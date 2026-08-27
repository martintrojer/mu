// mu — bucket renderer for workstream exports.
//
// Produces a "bucket" directory whose top-level contains a bucket-wide
// README + INDEX + manifest, and one subdirectory per source workstream
// that holds the per-workstream README + INDEX + tasks/<id>.md files.
//
// The bucket layout is ADDITIVE: re-running `mu workstream export
// -w X --out <bucket>` over an existing bucket either appends a new
// source-ws subdirectory (if X wasn't there before) or refreshes the
// existing subdirectory's contents in place (sha256 short-circuit).
// Source-ws subdirectories from earlier exports are NEVER touched
// by an unrelated source-ws's re-export.
//
// Disk shape (`bucketVersion: 2`):
//
//   <bucket>/
//     README.md           # bucket-level summary (every source-ws + dates + totals)
//     INDEX.md            # union of all task tables; first column = source-ws
//     manifest.json       # bucketVersion: 2 + per-source-ws sha256 + per-task sha256
//     <source-ws>/
//       README.md         # per-source-ws (counts)
//       INDEX.md          # per-source-ws (table of every task)
//       tasks/<id>.md     # one .md per task; YAML frontmatter + notes
//
// Origin: this code was lifted out of `src/workstream.ts`'s
// `exportWorkstream` (single-source rendering) and generalised to N
// sources. The single-source case is preserved as a thin wrapper
// (see exportWorkstream in src/workstream.ts) that builds a one-
// element `sources` array and delegates here.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { latestSeq } from "./logs.js";
import { isTaskStatus } from "./tasks/status.js";
import type { TaskNoteRow, TaskRow } from "./tasks.js";
import { getTaskEdges, listNotes, listTasks } from "./tasks.js";

// ─── Types ───────────────────────────────────────────────────────────

export const EXPORT_MANIFEST_VERSION = 2;

/** One per-task summary inside a per-source-ws section of the manifest. */
export interface ExportTaskEntry {
  /** Task local_id == filename stem (`<id>.md`). Kept for old-manifest compatibility. */
  id: string;
  /** Task local_id, duplicated under the operator-facing SDK name so bucket INDEX can render from manifest alone. */
  name: string;
  /** Compact summary fields needed for bucket-level INDEX.md without re-reading the DB. */
  title: string;
  status: TaskRow["status"];
  impact: number;
  effortDays: number;
  /** Path relative to the bucket root (e.g. `auth/tasks/design.md`). */
  path: string;
  /** sha256 of the markdown body bytes; idempotency key. */
  sha256: string;
  /** ISO timestamp of the first observed export at which the task
   *  was missing from the source. Absent for tasks still present. */
  deletedAt?: string;
}

/** Per-source-ws entry under `manifest.sources`. */
export interface ExportSourceManifest {
  /** ISO timestamp the source was first added to the bucket. */
  addedAt: string;
  /** ISO timestamp of the most recent re-export of this source. */
  lastReExportedAt: string;
  /** `latestSeq(db)` at the most recent re-export. The live
   *  `agent_logs.seq` cursor at the time of export. */
  eventsSeqAtExport: number;
  /** Per-task entries; sorted by id for stable diffs. */
  tasks: ExportTaskEntry[];
}

/** Top-level bucket manifest. `bucketVersion: 2` — the v0.3 disk layout.
 *  `manifest_version` is the schema of the manifest JSON payload itself:
 *  Manifest v1 lacked task summaries; manifest v2 stores enough per-task data to render
 *  bucket INDEX.md from `manifest.sources` alone. Manifests without
 *  `bucketVersion: 2` fall through to the `corrupt` lane in `readManifest`. */
export interface ExportManifest {
  /** Disk-layout discriminator. Always 2 in this codebase. */
  bucketVersion: 2;
  /** Manifest-payload discriminator. Always 2 when written by this codebase. */
  manifest_version: typeof EXPORT_MANIFEST_VERSION;
  /** Operator-chosen bucket label (null for a bare `mu workstream export`).
   *  Surfaced in README only. */
  bucketLabel: string | null;
  bucketCreatedAt: string;
  bucketLastUpdatedAt: string;
  muVersion: string;
  /** Per-source-ws map; key is the source workstream's TEXT name. */
  sources: Record<string, ExportSourceManifest>;
}

/** One source's worth of input: the per-task data the renderer needs.
 *  The per-task data the renderer needs from a source workstream. */
export interface ExportSource {
  /** Source workstream name. Becomes the subdirectory name. */
  name: string;
  tasks: TaskRow[];
  /** Per-task edges keyed on task name. Missing keys → no edges. */
  edges: Map<string, { blockers: string[]; dependents: string[] }>;
  /** Per-task notes keyed on task name. Missing keys → no notes. */
  notes: Map<string, TaskNoteRow[]>;
  /** `agent_logs.seq` cursor at this source's snapshot moment. */
  eventsSeqAtExport: number;
}

export interface RenderBucketInput {
  sources: ExportSource[];
  /** Operator-chosen bucket label, or null for a bare workstream export. */
  bucketLabel: string | null;
  outDir: string;
}

export interface RenderBucketResult {
  outDir: string;
  /** Per-source-ws stat: how many task files were rewritten across
   *  every source in this call. */
  written: number;
  /** Per-source-ws stat: how many task files were sha256-skipped. */
  unchanged: number;
  /** Per-source-ws stat: how many task files exist for a task that
   *  has since vanished from the source. Banner is added once. */
  preserved: number;
  manifestPath: string;
  manifest: ExportManifest;
}

// ─── Markdown render helpers (per-task) ──────────────────────────────

/** Wrap arbitrary text in a fenced code block, choosing a fence
 *  longer than any backtick run inside `body` so the body's literal
 *  ``` (or ````, etc.) survives intact. Used for note content,
 *  which routinely contains markdown / code / triple-fences. */
export function fenceForBody(body: string): string {
  const longestRun = (body.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** YAML-ish scalar quote: always double-quoted, with `"` and `\\`
 *  escaped. Multi-line values are coerced to single-line by
 *  replacing newlines with ` ` so the frontmatter block stays
 *  valid YAML. */
export function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

export function renderTaskMarkdown(
  task: TaskRow,
  edges: { blockers: string[]; dependents: string[] },
  notes: TaskNoteRow[],
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${yamlScalar(task.name)}`);
  lines.push(`workstream: ${yamlScalar(task.workstreamName)}`);
  lines.push(`status: ${task.status}`);
  lines.push(`impact: ${task.impact}`);
  lines.push(`effort_days: ${task.effortDays}`);
  // ROI is derived but a load-bearing field for operators ranking
  // closed tasks in retrospect; emit it precomputed so consumers
  // don't have to re-derive.
  lines.push(`roi: ${(task.impact / task.effortDays).toFixed(2)}`);
  lines.push(`owner: ${task.ownerName === null ? "null" : yamlScalar(task.ownerName)}`);
  lines.push(`created_at: ${yamlScalar(task.createdAt)}`);
  lines.push(`updated_at: ${yamlScalar(task.updatedAt)}`);
  lines.push(`blocked_by: [${edges.blockers.map(yamlScalar).join(", ")}]`);
  lines.push(`blocks: [${edges.dependents.map(yamlScalar).join(", ")}]`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${task.title}`);
  lines.push("");
  if (notes.length === 0) {
    lines.push("_No notes._");
    lines.push("");
  } else {
    lines.push(`## Notes (${notes.length})`);
    lines.push("");
    for (const [i, note] of notes.entries()) {
      const author = note.author === null ? "null" : yamlScalar(note.author);
      lines.push(`### #${i + 1} by ${author}, ${note.createdAt}`);
      lines.push("");
      const fence = fenceForBody(note.content);
      lines.push(fence);
      lines.push(note.content);
      lines.push(fence);
      lines.push("");
    }
  }
  // Trailing newline so POSIX tools (and git diff) don't complain.
  return `${lines.join("\n")}`.replace(/\n*$/, "\n");
}

/** Per-source-ws INDEX.md — one row per task in this source. */
export function renderSourceIndexMarkdown(workstream: string, tasks: TaskRow[]): string {
  const lines: string[] = [];
  lines.push(`# ${workstream} — task index`);
  lines.push("");
  if (tasks.length === 0) {
    lines.push("_No tasks._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| id | status | impact | effort | ROI | title |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const t of tasks) {
    const roi = (t.impact / t.effortDays).toFixed(2);
    const title = t.title.replace(/\|/g, "\\|");
    lines.push(
      `| [\`${t.name}\`](tasks/${t.name}.md) | ${t.status} | ${t.impact} | ${t.effortDays} | ${roi} | ${title} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/** Per-source-ws README.md — counts and pointer to INDEX.md. */
export function renderSourceReadmeMarkdown(
  workstream: string,
  tasks: TaskRow[],
  exportedAt: string,
): string {
  const counts: Record<string, number> = {
    OPEN: 0,
    IN_PROGRESS: 0,
    CLOSED: 0,
  };
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const lines: string[] = [];
  lines.push(`# Source workstream: ${workstream}`);
  lines.push("");
  lines.push(`Exported at: ${exportedAt}`);
  lines.push("");
  lines.push(`- Tasks: ${tasks.length}`);
  for (const status of ["OPEN", "IN_PROGRESS", "CLOSED"] as const) {
    lines.push(`  - ${status}: ${counts[status] ?? 0}`);
  }
  lines.push("");
  lines.push("See `INDEX.md` for the task table; one `.md` per task in `tasks/`.");
  lines.push("");
  return lines.join("\n");
}

/** Bucket-level README.md — multi-source summary. */
export function renderBucketReadmeMarkdown(manifest: ExportManifest): string {
  const lines: string[] = [];
  const label = manifest.bucketLabel ?? "(no label)";
  lines.push(`# Export bucket: ${label}`);
  lines.push("");
  lines.push(`- Bucket created at: ${manifest.bucketCreatedAt}`);
  lines.push(`- Bucket last updated at: ${manifest.bucketLastUpdatedAt}`);
  lines.push(`- mu version: ${manifest.muVersion}`);
  lines.push(`- Bucket layout version: ${manifest.bucketVersion}`);
  lines.push(`- Manifest version: ${manifest.manifest_version}`);
  lines.push("");
  const sources = Object.entries(manifest.sources).sort(([a], [b]) => a.localeCompare(b));
  lines.push(`## Sources (${sources.length})`);
  lines.push("");
  if (sources.length === 0) {
    lines.push("_No sources yet._");
    lines.push("");
  } else {
    lines.push("| source workstream | tasks | added | last re-exported |");
    lines.push("| --- | --- | --- | --- |");
    for (const [name, src] of sources) {
      lines.push(
        `| [\`${name}\`](${name}/README.md) | ${src.tasks.length} | ${src.addedAt} | ${src.lastReExportedAt} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "_Bucket exports are additive: re-running `mu workstream export -w <ws> --out <this-dir>` appends or refreshes one source-ws subdirectory. See `INDEX.md` for the cross-source task table and `manifest.json` for per-task sha256s._",
  );
  lines.push("");
  return lines.join("\n");
}

/** Bucket-level INDEX.md — union of every source-ws's task table,
 *  with a leading source-ws column to disambiguate cross-source. */
function taskEntryName(entry: Pick<ExportTaskEntry, "id"> & { name?: string }): string {
  return entry.name ?? entry.id;
}

function taskEntryFromTask(task: TaskRow, path: string, sha256: string): ExportTaskEntry {
  return {
    id: task.name,
    name: task.name,
    title: task.title,
    status: task.status,
    impact: task.impact,
    effortDays: task.effortDays,
    path,
    sha256,
  };
}

export function renderBucketIndexMarkdown(manifest: ExportManifest): string {
  const lines: string[] = [];
  const label = manifest.bucketLabel ?? "(no label)";
  lines.push(`# ${label} — task index (all sources)`);
  lines.push("");
  const sourcesWithTasks = Object.entries(manifest.sources)
    .map(([name, source]) => ({
      name,
      tasks: source.tasks.filter((task) => task.deletedAt === undefined),
    }))
    .filter((source) => source.tasks.length > 0);
  if (sourcesWithTasks.length === 0) {
    lines.push("_No tasks._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| source-ws | id | status | impact | effort | ROI | title |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  // Stable sort across sources: source name then task name.
  const sortedSources = sourcesWithTasks.sort((a, b) => a.name.localeCompare(b.name));
  for (const src of sortedSources) {
    for (const t of src.tasks) {
      const name = taskEntryName(t);
      const roi = (t.impact / t.effortDays).toFixed(2);
      const title = t.title.replace(/\|/g, "\\|");
      lines.push(
        `| ${src.name} | [\`${name}\`](${t.path}) | ${t.status} | ${t.impact} | ${t.effortDays} | ${roi} | ${title} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ─── Deletion banner ─────────────────────────────────────────────────

export const DELETED_BANNER_PREFIX = "> **Deleted from DB on ";

export function bannerFor(timestamp: string): string {
  return `${DELETED_BANNER_PREFIX}${timestamp}** — this task no longer exists in mu's database. The export below is the last-known state. Re-export will not regenerate it.\n\n`;
}

// ─── manifest.json read/parse ────────────────────────────────────────

/** Read an existing bucket manifest. Returns `{ kind: "v2", manifest }`
 *  for a v0.3+ bucket; `{ kind: "absent" }` if the file doesn't
 *  exist; `{ kind: "corrupt" }` for anything else. The pre-0.3
 *  (single-source, top-level `workstream` + `tasks`) shape is no
 *  longer recognized — v0.3 shipped 2026-05-10 and there are no
 *  pre-v0.3 buckets in the wild to keep a detection branch for. */
export type ManifestProbe =
  | { kind: "v2"; manifest: ExportManifest }
  | { kind: "absent" }
  | { kind: "corrupt" };

export function readManifest(path: string): ManifestProbe {
  if (!existsSync(path)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { kind: "corrupt" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "corrupt" };
  const obj = parsed as Record<string, unknown>;
  if (obj.bucketVersion === 2 && typeof obj.sources === "object" && obj.sources !== null) {
    const manifest = migrateManifest(obj, dirname(path));
    return manifest ? { kind: "v2", manifest } : { kind: "corrupt" };
  }
  return { kind: "corrupt" };
}

function migrateManifest(obj: Record<string, unknown>, bucketDir: string): ExportManifest | null {
  const rawVersion = obj.manifest_version;
  const version = rawVersion === undefined ? 1 : rawVersion;
  if (version !== 1 && version !== 2) return null;
  const sources = migrateSources(obj.sources, bucketDir);
  if (sources === null) return null;
  return {
    bucketVersion: 2,
    manifest_version: EXPORT_MANIFEST_VERSION,
    bucketLabel:
      typeof obj.bucketLabel === "string" || obj.bucketLabel === null ? obj.bucketLabel : null,
    bucketCreatedAt: typeof obj.bucketCreatedAt === "string" ? obj.bucketCreatedAt : "",
    bucketLastUpdatedAt: typeof obj.bucketLastUpdatedAt === "string" ? obj.bucketLastUpdatedAt : "",
    muVersion: typeof obj.muVersion === "string" ? obj.muVersion : "unknown",
    sources,
  };
}

function migrateSources(
  raw: unknown,
  bucketDir: string,
): Record<string, ExportSourceManifest> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, ExportSourceManifest> = {};
  for (const [sourceName, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const tasks = Array.isArray(source.tasks)
      ? source.tasks.map((task) => migrateTaskEntry(sourceName, task, bucketDir))
      : [];
    if (tasks.some((task) => task === null)) return null;
    out[sourceName] = {
      addedAt: typeof source.addedAt === "string" ? source.addedAt : "",
      lastReExportedAt: typeof source.lastReExportedAt === "string" ? source.lastReExportedAt : "",
      eventsSeqAtExport:
        typeof source.eventsSeqAtExport === "number" ? source.eventsSeqAtExport : 0,
      tasks: tasks.filter((task): task is ExportTaskEntry => task !== null),
    };
  }
  return out;
}

function migrateTaskEntry(
  sourceName: string,
  raw: unknown,
  bucketDir: string,
): ExportTaskEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id : undefined;
  const name = typeof entry.name === "string" ? entry.name : id;
  const path = typeof entry.path === "string" ? entry.path : `${sourceName}/tasks/${name ?? ""}.md`;
  const inferred = inferTaskSummaryFromMarkdown(join(bucketDir, path), name ?? id ?? "");
  const title = typeof entry.title === "string" ? entry.title : inferred.title;
  const status =
    typeof entry.status === "string" && isTaskStatus(entry.status) ? entry.status : inferred.status;
  const impact =
    typeof entry.impact === "number" && Number.isFinite(entry.impact)
      ? entry.impact
      : inferred.impact;
  const effortDays =
    typeof entry.effortDays === "number" &&
    Number.isFinite(entry.effortDays) &&
    entry.effortDays > 0
      ? entry.effortDays
      : inferred.effortDays;
  const sha256 = typeof entry.sha256 === "string" ? entry.sha256 : "";
  if (!id || !name) return null;
  const migrated: ExportTaskEntry = {
    id,
    name,
    title,
    status,
    impact,
    effortDays,
    path,
    sha256,
  };
  if (typeof entry.deletedAt === "string") migrated.deletedAt = entry.deletedAt;
  return migrated;
}

function inferTitleFromPath(path: string, fallback: string): string {
  const stem = basename(path).replace(/\.md$/, "");
  return stem || fallback || "(unknown title; manifest v1 fallback)";
}

function inferTaskSummaryFromMarkdown(
  path: string,
  fallbackName: string,
): Pick<ExportTaskEntry, "title" | "status" | "impact" | "effortDays"> {
  const fallback = {
    title: inferTitleFromPath(path, fallbackName),
    status: "OPEN" as TaskRow["status"],
    impact: 0,
    effortDays: 1,
  };
  if (!existsSync(path)) return fallback;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
  const lines = raw.split("\n");
  const firstFence = lines.indexOf("---");
  if (firstFence < 0) return fallback;
  let secondFence = -1;
  for (let i = firstFence + 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      secondFence = i;
      break;
    }
  }
  if (secondFence < 0) return fallback;
  const fields: Record<string, string> = {};
  for (let i = firstFence + 1; i < secondFence; i += 1) {
    const line = lines[i] ?? "";
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const status = fields.status && isTaskStatus(fields.status) ? fields.status : fallback.status;
  const impact = Number(fields.impact);
  const effortDays = Number(fields.effort_days);
  const titleLine = lines.slice(secondFence + 1).find((line) => line.startsWith("# "));
  return {
    title: titleLine ? titleLine.slice(2).trim() : fallback.title,
    status,
    impact: Number.isFinite(impact) ? impact : fallback.impact,
    effortDays: Number.isFinite(effortDays) && effortDays > 0 ? effortDays : fallback.effortDays,
  };
}

// ─── sha256 + mu version ─────────────────────────────────────────────

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Read the package.json shipped next to the bundled CLI (or src/) so
 *  the manifest records the mu version that produced it. Falls back
 *  to "unknown" if the file isn't reachable. */
export function readMuVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Renderer ────────────────────────────────────────────────────────

/**
 * Render `input.sources` to disk under `input.outDir` in the v0.3
 * bucket layout. Idempotent + additive:
 *   - If the bucket doesn't exist, scaffold it.
 *   - If it does exist with bucketVersion 2, MERGE: each source in
 *     `input.sources` either appends (new) or refreshes (existing)
 *     its subdirectory; sources NOT in `input.sources` are left
 *     untouched.
 *
 * Per-task idempotency is sha256-keyed: a re-export of the same
 * source against an unchanged DB rewrites zero task files. Tasks
 * that disappear from a source between re-exports are preserved on
 * disk with a one-time `> **Deleted from DB on <ts>**` banner.
 */
export function renderToBucket(input: RenderBucketInput): RenderBucketResult {
  const outDir = input.outDir;
  if (existsSync(outDir)) {
    const stat = statSync(outDir);
    if (!stat.isDirectory()) {
      throw new Error(`renderToBucket: outDir exists and is not a directory: ${outDir}`);
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }

  const manifestPath = join(outDir, "manifest.json");
  const probe = readManifest(manifestPath);

  const now = new Date().toISOString();
  const muVersion = readMuVersion();
  const previous: ExportManifest | undefined = probe.kind === "v2" ? probe.manifest : undefined;
  // Start the new manifest from the previous one (so untouched
  // sources keep their entries) or a fresh scaffold.
  const manifest: ExportManifest = previous
    ? {
        bucketVersion: 2,
        manifest_version: EXPORT_MANIFEST_VERSION,
        bucketLabel: input.bucketLabel ?? previous.bucketLabel,
        bucketCreatedAt: previous.bucketCreatedAt,
        bucketLastUpdatedAt: now,
        muVersion,
        sources: { ...previous.sources },
      }
    : {
        bucketVersion: 2,
        manifest_version: EXPORT_MANIFEST_VERSION,
        bucketLabel: input.bucketLabel,
        bucketCreatedAt: now,
        bucketLastUpdatedAt: now,
        muVersion,
        sources: {},
      };

  let writtenTotal = 0;
  let unchangedTotal = 0;
  let preservedTotal = 0;

  for (const source of input.sources) {
    const sourceDir = join(outDir, source.name);
    const tasksDir = join(sourceDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    const previousSource = previous?.sources[source.name];
    const previousById = new Map<string, ExportTaskEntry>();
    if (previousSource) {
      for (const t of previousSource.tasks) previousById.set(taskEntryName(t), t);
    }

    const liveIds = new Set(source.tasks.map((t) => t.name));
    const manifestEntries: ExportTaskEntry[] = [];
    let written = 0;
    let unchanged = 0;
    let preserved = 0;

    for (const task of source.tasks) {
      const edges = source.edges.get(task.name) ?? { blockers: [], dependents: [] };
      const notes = source.notes.get(task.name) ?? [];
      const md = renderTaskMarkdown(task, edges, notes);
      const sha = sha256Hex(md);
      const relPath = `${source.name}/tasks/${task.name}.md`;
      const absPath = join(outDir, relPath);

      const prev = previousById.get(task.name);
      const onDisk = existsSync(absPath);
      if (onDisk && prev?.sha256 === sha && prev.deletedAt === undefined) {
        unchanged += 1;
      } else {
        writeFileSync(absPath, md, "utf8");
        written += 1;
      }
      manifestEntries.push(taskEntryFromTask(task, relPath, sha));
    }

    // Preserve files for tasks that disappeared from the source.
    // Banner is one-time (idempotent across re-exports).
    for (const prev of previousById.values()) {
      if (liveIds.has(taskEntryName(prev))) continue;
      const absPath = join(outDir, prev.path);
      const deletedAt = prev.deletedAt ?? now;
      if (existsSync(absPath)) {
        const existing = readFileSync(absPath, "utf8");
        if (!existing.startsWith(DELETED_BANNER_PREFIX)) {
          writeFileSync(absPath, bannerFor(deletedAt) + existing, "utf8");
        }
      }
      manifestEntries.push({ ...prev, deletedAt });
      preserved += 1;
    }

    // Stable order — diffs across re-exports stay clean.
    manifestEntries.sort((a, b) => taskEntryName(a).localeCompare(taskEntryName(b)));

    // Per-source-ws scaffolding (cheap; always rewritten — but the
    // sha256 short-circuit on `tasks/<id>.md` is what matters for
    // mtime stability of the operator-visible files).
    writeFileSync(
      join(sourceDir, "README.md"),
      renderSourceReadmeMarkdown(source.name, source.tasks, now),
      "utf8",
    );
    writeFileSync(
      join(sourceDir, "INDEX.md"),
      renderSourceIndexMarkdown(source.name, source.tasks),
      "utf8",
    );

    manifest.sources[source.name] = {
      addedAt: previousSource?.addedAt ?? now,
      lastReExportedAt: now,
      eventsSeqAtExport: source.eventsSeqAtExport,
      tasks: manifestEntries,
    };

    writtenTotal += written;
    unchangedTotal += unchanged;
    preservedTotal += preserved;
  }

  // Bucket-level scaffolding covers EVERY source-ws in the merged
  // manifest, not just the ones refreshed by this call. Manifest v2
  // carries compact task summaries so INDEX.md can remain a true
  // cross-source union after additive one-workstream re-exports.
  const bucketReadme = renderBucketReadmeMarkdown(manifest);
  const bucketIndex = renderBucketIndexMarkdown(manifest);
  writeFileSync(join(outDir, "README.md"), bucketReadme, "utf8");
  writeFileSync(join(outDir, "INDEX.md"), bucketIndex, "utf8");

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    outDir,
    written: writtenTotal,
    unchanged: unchangedTotal,
    preserved: preservedTotal,
    manifestPath,
    manifest,
  };
}

// ─── Source builders ──────────────────────────────────────────────────

/** Construct an ExportSource for one live workstream by reading the
 *  current DB. Pure data assembly; renderer does the I/O. */
export function exportSourceForWorkstream(db: Db, workstream: string): ExportSource {
  const tasks = listTasks(db, workstream);
  const edges = new Map<string, { blockers: string[]; dependents: string[] }>();
  const notes = new Map<string, TaskNoteRow[]>();
  for (const t of tasks) {
    edges.set(t.name, getTaskEdges(db, t.name, t.workstreamName));
    notes.set(t.name, listNotes(db, t.name, t.workstreamName));
  }
  return {
    name: workstream,
    tasks,
    edges,
    notes,
    eventsSeqAtExport: latestSeq(db),
  };
}
