// mu — unified bucket renderer for workstream / archive exports.
//
// One renderer, two entry points (`mu workstream export` and
// `mu archive export`). Both produce the same on-disk shape: a
// "bucket" directory whose top-level contains a bucket-wide README +
// INDEX + manifest, and one subdirectory per source workstream that
// holds the per-workstream README + INDEX + tasks/<id>.md files.
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listArchivedTasks } from "./archives.js";
import type { Db } from "./db.js";
import { emitEvent, latestSeq } from "./logs.js";
import { getTaskEdges, listNotes, listTasks } from "./tasks.js";
import type { TaskNoteRow, TaskRow } from "./tasks.js";

// ─── Types ───────────────────────────────────────────────────────────

/** One per-task summary inside a per-source-ws section of the manifest. */
export interface ExportTaskEntry {
  /** Task local_id == filename stem (`<id>.md`). */
  id: string;
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
  /** `latestSeq(db)` at the most recent re-export; for live workstreams
   *  this is the live `agent_logs.seq` cursor. For archive sources
   *  there is no equivalent live counter — we record the seq at
   *  archive-add time when available, else 0. */
  eventsSeqAtExport: number;
  /** Per-task entries; sorted by id for stable diffs. */
  tasks: ExportTaskEntry[];
}

/** Top-level bucket manifest. `bucketVersion: 2` — the v0.3 shape.
 *  Manifests without `bucketVersion: 2` fall through to the
 *  `corrupt` lane in `readManifest`. */
export interface ExportManifest {
  /** Schema discriminator. Always 2 in this codebase. */
  bucketVersion: 2;
  /** Operator-chosen bucket label (an archive label, or null for a
   *  one-shot `mu workstream export`). Surfaced in README only. */
  bucketLabel: string | null;
  bucketCreatedAt: string;
  bucketLastUpdatedAt: string;
  muVersion: string;
  /** Per-source-ws map; key is the source workstream's TEXT name. */
  sources: Record<string, ExportSourceManifest>;
}

/** One source's worth of input: the per-task data the renderer needs.
 *  Both entry points (workstream / archive) collapse to this shape. */
export interface ExportSource {
  /** Source workstream name. Becomes the subdirectory name. */
  name: string;
  tasks: TaskRow[];
  /** Per-task edges keyed on task name. Missing keys → no edges. */
  edges: Map<string, { blockers: string[]; dependents: string[] }>;
  /** Per-task notes keyed on task name. Missing keys → no notes. */
  notes: Map<string, TaskNoteRow[]>;
  /** `agent_logs.seq` cursor at this source's snapshot moment. 0 for
   *  archive sources (no live cursor). */
  eventsSeqAtExport: number;
}

export interface RenderBucketInput {
  sources: ExportSource[];
  /** Operator-chosen archive label, or null for a workstream export. */
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
      lines.push(`### #${i + 1} by ${note.author ?? "system"}, ${note.createdAt}`);
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
    REJECTED: 0,
    DEFERRED: 0,
  };
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const lines: string[] = [];
  lines.push(`# Source workstream: ${workstream}`);
  lines.push("");
  lines.push(`Exported at: ${exportedAt}`);
  lines.push("");
  lines.push(`- Tasks: ${tasks.length}`);
  for (const status of ["OPEN", "IN_PROGRESS", "CLOSED", "REJECTED", "DEFERRED"] as const) {
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
    "_Bucket exports are additive: re-running `mu workstream export -w <ws> --out <this-dir>` appends or refreshes one source-ws subdirectory; `mu archive export <label> --out <this-dir>` (re)builds every source-ws from the named archive. See `INDEX.md` for the cross-source task table and `manifest.json` for per-task sha256s._",
  );
  lines.push("");
  return lines.join("\n");
}

/** Bucket-level INDEX.md — union of every source-ws's task table,
 *  with a leading source-ws column to disambiguate cross-source. */
export function renderBucketIndexMarkdown(input: RenderBucketInput): string {
  const lines: string[] = [];
  const label = input.bucketLabel ?? "(no label)";
  lines.push(`# ${label} — task index (all sources)`);
  lines.push("");
  const sourcesWithTasks = input.sources.filter((s) => s.tasks.length > 0);
  if (sourcesWithTasks.length === 0) {
    lines.push("_No tasks._");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| source-ws | id | status | impact | effort | ROI | title |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  // Stable sort across sources: source name then task name.
  const sortedSources = [...input.sources].sort((a, b) => a.name.localeCompare(b.name));
  for (const src of sortedSources) {
    for (const t of src.tasks) {
      const roi = (t.impact / t.effortDays).toFixed(2);
      const title = t.title.replace(/\|/g, "\\|");
      lines.push(
        `| ${src.name} | [\`${t.name}\`](${src.name}/tasks/${t.name}.md) | ${t.status} | ${t.impact} | ${t.effortDays} | ${roi} | ${title} |`,
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
    // Best-effort cast; the caller treats unknown sources as a fresh
    // bucket if any field is malformed.
    return { kind: "v2", manifest: obj as unknown as ExportManifest };
  }
  return { kind: "corrupt" };
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
        bucketLabel: input.bucketLabel ?? previous.bucketLabel,
        bucketCreatedAt: previous.bucketCreatedAt,
        bucketLastUpdatedAt: now,
        muVersion,
        sources: { ...previous.sources },
      }
    : {
        bucketVersion: 2,
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
      for (const t of previousSource.tasks) previousById.set(t.id, t);
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
      manifestEntries.push({ id: task.name, path: relPath, sha256: sha });
    }

    // Preserve files for tasks that disappeared from the source.
    // Banner is one-time (idempotent across re-exports).
    for (const prev of previousById.values()) {
      if (liveIds.has(prev.id)) continue;
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
    manifestEntries.sort((a, b) => a.id.localeCompare(b.id));

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

  // Bucket-level scaffolding: covers EVERY source-ws in the
  // (possibly merged) manifest, not just the ones in this call.
  // The bucket README/INDEX must reflect untouched siblings too.
  // To render the bucket INDEX we need TaskRow shapes for siblings
  // we did NOT pass in this call; we don't have them. Compromise:
  // the bucket INDEX renders ONLY the sources whose data we have
  // in `input.sources`. This is honest about what this call refreshed
  // and matches the additive semantics: mu archive export passes
  // every source; mu workstream export passes one and the bucket
  // INDEX shrinks to that one source. Operators who care about the
  // global table use mu archive export.
  const bucketReadme = renderBucketReadmeMarkdown(manifest);
  const bucketIndex = renderBucketIndexMarkdown(input);
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

/** Construct ExportSources for every source workstream that
 *  contributed to an archive label. One ExportSource per
 *  (archive_id, source_workstream) partition. The TaskRow shapes are
 *  reconstructed from archived_* rows; `workstreamName` is set to
 *  the source workstream so the rendered frontmatter reflects the
 *  task's original home. */
export function exportSourcesForArchive(db: Db, label: string): ExportSource[] {
  // Pull every archived task in deterministic (source_workstream,
  // original_local_id) order.
  const allTasks = listArchivedTasks(db, label);
  if (allTasks.length === 0) return [];

  // archive_id (resolved internally) — we need it for the edge /
  // note / event queries below. Look it up via the first row's
  // archiveLabel (every row in `allTasks` shares the same archive).
  const archiveIdRow = db.prepare("SELECT id FROM archives WHERE label = ?").get(label) as
    | { id: number }
    | undefined;
  if (!archiveIdRow) return []; // Should be unreachable: listArchivedTasks would have thrown.
  const archiveId = archiveIdRow.id;

  // Group tasks by source workstream.
  const bySource = new Map<string, typeof allTasks>();
  for (const t of allTasks) {
    const list = bySource.get(t.sourceWorkstream) ?? [];
    list.push(t);
    bySource.set(t.sourceWorkstream, list);
  }

  // Pre-load notes + edges per archived task. Two batched queries
  // is enough — the per-task loops below just dereference.
  const notesByArchivedId = new Map<number, TaskNoteRow[]>();
  const noteRows = db
    .prepare(
      `SELECT archived_task_id AS aid, author, content, created_at
         FROM archived_notes
        WHERE archive_id = ?
        ORDER BY id`,
    )
    .all(archiveId) as {
    aid: number;
    author: string | null;
    content: string;
    created_at: string;
  }[];
  for (const n of noteRows) {
    const list = notesByArchivedId.get(n.aid) ?? [];
    list.push({ author: n.author, content: n.content, createdAt: n.created_at });
    notesByArchivedId.set(n.aid, list);
  }

  // Edges: archived endpoint ids → original_local_id strings.
  // Build {from_archived_id → original_local_id} once, then map.
  const localIdByArchivedId = new Map<number, string>();
  for (const t of allTasks) localIdByArchivedId.set(t.id, t.originalLocalId);
  const blockersByArchivedId = new Map<number, string[]>();
  const dependentsByArchivedId = new Map<number, string[]>();
  const edgeRows = db
    .prepare(
      `SELECT from_archived_id AS f, to_archived_id AS t
         FROM archived_edges
        WHERE archive_id = ?`,
    )
    .all(archiveId) as { f: number; t: number }[];
  for (const e of edgeRows) {
    const fromId = localIdByArchivedId.get(e.f);
    const toId = localIdByArchivedId.get(e.t);
    if (fromId === undefined || toId === undefined) continue;
    // edge `from blocks to`: `from` is a blocker of `to`; `to` is
    // a dependent of `from`. (See getTaskEdges in src/tasks.ts.)
    const blockers = blockersByArchivedId.get(e.t) ?? [];
    blockers.push(fromId);
    blockersByArchivedId.set(e.t, blockers);
    const deps = dependentsByArchivedId.get(e.f) ?? [];
    deps.push(toId);
    dependentsByArchivedId.set(e.f, deps);
  }

  // archived_events: max(seq) per source workstream gives us the
  // best available "events seq at archive time" — the highest seq
  // of any event that contributed to this source's archive.
  const eventSeqRows = db
    .prepare(
      `SELECT source_workstream AS sw, MAX(seq) AS max_seq
         FROM archived_events
        WHERE archive_id = ?
        GROUP BY source_workstream`,
    )
    .all(archiveId) as { sw: string; max_seq: number }[];
  const eventsSeqBySource = new Map<string, number>();
  for (const r of eventSeqRows) eventsSeqBySource.set(r.sw, r.max_seq);

  const sources: ExportSource[] = [];
  for (const [sourceName, taskList] of bySource) {
    const tasks: TaskRow[] = taskList.map((t) => ({
      name: t.originalLocalId,
      workstreamName: t.sourceWorkstream,
      title: t.title,
      // Status as snapshotted; cast through the TaskStatus union by
      // way of any narrowed value (the renderer doesn't validate).
      status: t.status as TaskRow["status"],
      impact: t.impact,
      effortDays: t.effortDays,
      ownerName: t.ownerName,
      createdAt: t.originalCreatedAt,
      updatedAt: t.originalUpdatedAt,
    }));
    const edges = new Map<string, { blockers: string[]; dependents: string[] }>();
    const notes = new Map<string, TaskNoteRow[]>();
    for (const t of taskList) {
      const blockers = (blockersByArchivedId.get(t.id) ?? []).sort((a, b) => a.localeCompare(b));
      const dependents = (dependentsByArchivedId.get(t.id) ?? []).sort((a, b) =>
        a.localeCompare(b),
      );
      edges.set(t.originalLocalId, { blockers, dependents });
      const ns = notesByArchivedId.get(t.id);
      if (ns) notes.set(t.originalLocalId, ns);
    }
    sources.push({
      name: sourceName,
      tasks,
      edges,
      notes,
      eventsSeqAtExport: eventsSeqBySource.get(sourceName) ?? 0,
    });
  }

  // Stable order across the bucket: source name ascending.
  sources.sort((a, b) => a.name.localeCompare(b.name));
  return sources;
}

// ─── Public verbs ────────────────────────────────────────────────────

export interface ExportArchiveOptions {
  label: string;
  /** Output directory (the bucket). Created if missing. */
  outDir: string;
}

export interface ExportArchiveResult extends RenderBucketResult {
  archiveLabel: string;
  /** Number of source workstreams the renderer wrote / refreshed. */
  sourceCount: number;
}

/** Render every source-ws in an archive to a bucket directory.
 *  Throws `ArchiveNotFoundError` (via listArchivedTasks) when the
 *  label doesn't exist. */
export function exportArchive(db: Db, opts: ExportArchiveOptions): ExportArchiveResult {
  // Resolve up-front so a missing label fails before any disk I/O.
  // listArchivedTasks throws ArchiveNotFoundError on miss.
  listArchivedTasks(db, opts.label);
  const sources = exportSourcesForArchive(db, opts.label);
  const result = renderToBucket({
    sources,
    bucketLabel: opts.label,
    outDir: opts.outDir,
  });
  emitEvent(
    db,
    null,
    `archive export ${opts.label} (out=${result.outDir}, sources=${sources.length}, tasks=${sources.reduce((acc, s) => acc + s.tasks.length, 0)}, written=${result.written}, unchanged=${result.unchanged}, preserved=${result.preserved})`,
  );
  return { ...result, archiveLabel: opts.label, sourceCount: sources.length };
}
