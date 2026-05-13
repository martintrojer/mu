// mu — inverse of src/exporting.ts: parse a v0.3 bucket directory
// (markdown + manifest.json) and rebuild every source workstream as
// live DB rows.
//
// IMPORTS MARKDOWN ONLY. We do not read any .db file. The export
// shape is the import format: README + INDEX + manifest.json at the
// bucket root, then one subdir per source workstream containing
// README + INDEX + tasks/<id>.md. .db cross-machine = snapshot/undo;
// markdown cross-machine = this module. See task notes for
// workstream_import_from_markdown for the full rationale.
//
// What survives the round trip:
//   - per-task: id (local_id) + title + status + impact + effort_days +
//     created_at + updated_at + blocked_by + blocks + every note.
//   - per-source-ws: a workstream row of the same name (or the
//     --workstream override when the bucket has exactly one source).
//
// What does NOT survive (anti-features per the design note):
//   - owner_id (agents aren't exported; we keep the original owner
//     name in the markdown and set owner_id to NULL in the DB).
//   - agents / workspaces / agent_logs (out of scope).
//   - archive labels (separate follow-up if needed).
//
// Per source-ws transactionality: every task + edge + note for one
// source-ws goes into ONE SQLite transaction. If that source-ws
// fails (bad frontmatter, edge ref to a missing task, ...), only
// THAT source-ws is rolled back; siblings still import.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Db } from "./db.js";
import { resolveWorkstreamId } from "./db.js";
import { DELETED_BANNER_PREFIX, type ExportManifest, readManifest } from "./exporting.js";
import { emitEvent } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { type TaskStatus, isTaskStatus } from "./tasks/status.js";
import { ensureWorkstream } from "./workstream.js";

// ─── Typed errors ────────────────────────────────────────────────────

export class ImportBucketInvalidError extends Error implements HasNextSteps {
  override readonly name = "ImportBucketInvalidError";
  constructor(
    public readonly bucketDir: string,
    public readonly reason: string,
  ) {
    super(`not a valid mu bucket export at ${bucketDir}: ${reason}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List the directory's contents", command: `ls ${this.bucketDir}` },
      {
        intent: "Inspect the manifest (must be bucketVersion 2)",
        command: `cat ${this.bucketDir}/manifest.json`,
      },
    ];
  }
}

/** Raised when `--source-ws X[,Y]` lists a name that isn't a key in
 *  the bucket manifest's `sources` map. Exit code 4 (conflict) per
 *  classifyError. */
export class ImportSourceNotInBucketError extends Error implements HasNextSteps {
  override readonly name = "ImportSourceNotInBucketError";
  constructor(
    public readonly bucketDir: string,
    public readonly badName: string,
    public readonly validNames: string[],
  ) {
    super(
      `--source-ws "${badName}" is not a source-ws in bucket ${bucketDir}; valid: ${
        validNames.length === 0 ? "<none>" : validNames.join(", ")
      }`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List the bucket's source-ws subdirs", command: `ls ${this.bucketDir}` },
      {
        intent: "Inspect the bucket manifest's sources map",
        command: `cat ${this.bucketDir}/manifest.json | head -40`,
      },
    ];
  }
}

export class WorkstreamAlreadyExistsError extends Error implements HasNextSteps {
  override readonly name = "WorkstreamAlreadyExistsError";
  constructor(public readonly workstream: string) {
    super(
      `workstream "${workstream}" already exists in the DB; mu workstream import refuses to merge silently. Pass --workstream <new-name> to import under a different name (single-source buckets only), or destroy the existing workstream first.`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Import under a new name (single-source bucket only)",
        command: "mu workstream import <bucket> --workstream <new-name>",
      },
      {
        intent: "Or destroy the existing workstream first",
        command: `mu workstream destroy -w ${this.workstream} --yes`,
      },
    ];
  }
}

export class ImportFrontmatterParseError extends Error implements HasNextSteps {
  override readonly name = "ImportFrontmatterParseError";
  constructor(
    public readonly path: string,
    public readonly line: number,
    public readonly raw: string,
  ) {
    super(`failed to parse frontmatter at ${path}:${line}: ${raw}`);
  }
  errorNextSteps(): NextStep[] {
    return [{ intent: "Inspect the offending file", command: `sed -n 1,30p ${this.path}` }];
  }
}

export class ImportEdgeRefMissingError extends Error implements HasNextSteps {
  override readonly name = "ImportEdgeRefMissingError";
  constructor(
    public readonly fromTask: string,
    public readonly toTask: string,
    public readonly direction: "blocked_by" | "blocks",
  ) {
    super(
      `task "${fromTask}" references "${toTask}" via ${direction}, but no task with that id was found in the import`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Inspect the offending task file in the bucket",
        command: `grep -l 'id: "${this.fromTask}"' <bucket>/*/tasks/`,
      },
    ];
  }
}

// ─── Parser primitives (inverses of src/exporting.ts helpers) ─────────

/** Inverse of `yamlScalar`: strip the surrounding double quotes and
 *  unescape `\"` → `"` and `\\` → `\`. Newlines inside scalars are
 *  not supported (the renderer flattens them to spaces). */
function unquote(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed.length < 2 || trimmed[0] !== '"' || trimmed[trimmed.length - 1] !== '"') {
    return raw.trim();
  }
  const inner = trimmed.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next === '"' || next === "\\") {
        out += next;
        i += 1;
        continue;
      }
    }
    if (ch !== undefined) out += ch;
  }
  return out;
}

/** Parse `[ "a", "b", "c" ]` → ["a","b","c"]. Empty `[]` → []. */
function parseStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`expected [..] array, got ${JSON.stringify(raw)}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return [];
  const out: string[] = [];
  // Walk the inner content respecting `\"` escapes.
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && (inner[i] === " " || inner[i] === ",")) i += 1;
    if (i >= inner.length) break;
    if (inner[i] !== '"') {
      throw new Error(`expected quoted string in array, got ${JSON.stringify(inner.slice(i))}`);
    }
    let j = i + 1;
    while (j < inner.length) {
      if (inner[j] === "\\" && j + 1 < inner.length) {
        j += 2;
        continue;
      }
      if (inner[j] === '"') break;
      j += 1;
    }
    if (j >= inner.length) {
      throw new Error("unterminated quoted string in array");
    }
    const scalar = unquote(inner.slice(i, j + 1));
    if (scalar === null) {
      throw new Error("null is not a legal array element");
    }
    out.push(scalar);
    i = j + 1;
  }
  return out;
}

interface ParsedFrontmatter {
  id: string;
  workstream: string;
  status: TaskStatus;
  impact: number;
  effortDays: number;
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
  blockedBy: string[];
  blocks: string[];
  title: string;
  notes: { author: string | null; createdAt: string; content: string }[];
}

/** Parse a single rendered tasks/<id>.md file. Mirrors
 *  renderTaskMarkdown in src/exporting.ts. */
function parseTaskMarkdown(path: string): ParsedFrontmatter {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");

  if (lines[0] !== "---") {
    throw new ImportFrontmatterParseError(path, 1, lines[0] ?? "");
  }
  // Find the closing '---' for the frontmatter block.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new ImportFrontmatterParseError(path, 1, "missing closing '---' for frontmatter");
  }

  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new ImportFrontmatterParseError(path, i + 1, line);
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fields[key] = value;
  }

  function require(key: string): string {
    const v = fields[key];
    if (v === undefined) {
      throw new ImportFrontmatterParseError(path, 1, `missing frontmatter key: ${key}`);
    }
    return v;
  }

  const id = unquote(require("id"));
  if (id === null || id === "") {
    throw new ImportFrontmatterParseError(path, 1, "id must be a non-empty string");
  }
  const workstream = unquote(require("workstream"));
  if (workstream === null || workstream === "") {
    throw new ImportFrontmatterParseError(path, 1, "workstream must be a non-empty string");
  }
  const statusRaw = require("status");
  if (!isTaskStatus(statusRaw)) {
    throw new ImportFrontmatterParseError(path, 1, `unknown status: ${statusRaw}`);
  }
  const impact = Number(require("impact"));
  const effortDays = Number(require("effort_days"));
  if (!Number.isFinite(impact) || !Number.isFinite(effortDays)) {
    throw new ImportFrontmatterParseError(path, 1, "impact / effort_days must be numeric");
  }
  const ownerName = unquote(require("owner"));
  const createdAt = unquote(require("created_at"));
  const updatedAt = unquote(require("updated_at"));
  if (createdAt === null || updatedAt === null) {
    throw new ImportFrontmatterParseError(path, 1, "created_at / updated_at cannot be null");
  }
  let blockedBy: string[];
  let blocks: string[];
  try {
    blockedBy = parseStringArray(require("blocked_by"));
    blocks = parseStringArray(require("blocks"));
  } catch (err) {
    throw new ImportFrontmatterParseError(
      path,
      1,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Body. Find the title line (first '# ').
  let bodyIdx = end + 1;
  while (bodyIdx < lines.length && lines[bodyIdx] === "") bodyIdx += 1;
  const titleLine = lines[bodyIdx] ?? "";
  if (!titleLine.startsWith("# ")) {
    throw new ImportFrontmatterParseError(
      path,
      bodyIdx + 1,
      "expected '# <title>' after frontmatter",
    );
  }
  const title = titleLine.slice(2).trim();

  // Notes: scan for '## Notes (' header. Everything else is layout
  // sugar from the renderer; we don't roundtrip the title H1.
  const notes: ParsedFrontmatter["notes"] = [];
  let i = bodyIdx + 1;
  while (i < lines.length && !(lines[i] ?? "").startsWith("## Notes (")) i += 1;
  if (i < lines.length) {
    i += 1; // consume the '## Notes (N)' line.
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (!line.startsWith("### #")) {
        i += 1;
        continue;
      }
      // '### #N by AUTHOR, TIMESTAMP'
      const headerRest = line.slice(line.indexOf(" by ") + 4);
      const lastComma = headerRest.lastIndexOf(", ");
      if (lastComma === -1) {
        throw new ImportFrontmatterParseError(path, i + 1, line);
      }
      const authorRaw = headerRest.slice(0, lastComma);
      const author = authorRaw === "system" ? null : authorRaw;
      const createdAtNote = headerRest.slice(lastComma + 2);
      i += 1;
      // Skip any blank line.
      while (i < lines.length && lines[i] === "") i += 1;
      // Opening fence (run of backticks).
      const openFence = lines[i] ?? "";
      if (!/^`{3,}$/.test(openFence)) {
        throw new ImportFrontmatterParseError(path, i + 1, openFence);
      }
      const fence = openFence;
      i += 1;
      const contentLines: string[] = [];
      while (i < lines.length && lines[i] !== fence) {
        contentLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i >= lines.length) {
        throw new ImportFrontmatterParseError(path, i + 1, `unterminated note fence ${fence}`);
      }
      i += 1; // consume closing fence
      notes.push({ author, createdAt: createdAtNote, content: contentLines.join("\n") });
    }
  }

  return {
    id,
    workstream,
    status: statusRaw,
    impact,
    effortDays,
    ownerName,
    createdAt,
    updatedAt,
    blockedBy,
    blocks,
    title,
    notes,
  };
}

// ─── Public types ────────────────────────────────────────────────────

export interface ImportBucketOptions {
  bucketDir: string;
  /** Rename the (single) source workstream on import. Only valid when
   *  the bucket has exactly one source-ws subdir (after applying any
   *  `sourceWs` filter); otherwise rejected with an
   *  ImportBucketInvalidError. */
  workstreamOverride?: string;
  /** Restrict the import to a subset of source-ws subdirs (by name).
   *  Each name must be a key in the bucket manifest's `sources` map;
   *  otherwise ImportSourceNotInBucketError is raised. Mutually
   *  exclusive with the per-source-ws-subdir invocation form (Form 1):
   *  passing this flag against a Form 1 path raises
   *  ImportBucketInvalidError. Empty array is treated as "no filter";
   *  the CLI rejects an explicitly-empty `--source-ws ,,`. */
  sourceWs?: string[];
  /** Walk + parse but write nothing to the DB. */
  dryRun?: boolean;
}

export interface ImportSourceResult {
  workstreamName: string;
  tasksImported: number;
  edgesImported: number;
  notesImported: number;
  tombstonesSkipped: number;
  /** Per-source-ws errors that did NOT roll back this source. Empty
   *  on success. (Sibling failures live in their own entry.) */
  errors: string[];
}

export interface ImportBucketResult {
  bucketLabel: string | null;
  bucketVersion: number;
  sources: ImportSourceResult[];
}

// ─── Bucket walker ────────────────────────────────────────────────────

interface BucketSource {
  /** Name of the on-disk subdirectory (== source workstream name). */
  diskName: string;
  /** Absolute paths of every tasks/*.md under the source. */
  taskFiles: string[];
}

/** Detected on-disk shape. Auto-detected by walkBucket; the CLI
 *  uses this to enforce the anti-feature guard against
 *  `--source-ws` on a Form 1 (per-source-ws subdir) invocation. */
export type BucketShape =
  /** `<dir>/manifest.json` (bucketVersion: 2) present. The classic
   *  shape; `--source-ws` can filter the per-source-ws subdirs. */
  | "bucket"
  /** `<dir>` is itself a per-source-ws subdir; the parent dir
   *  contains the bucket manifest and resolves the source name. */
  | "sourceWsSubdir";

/** Probe a directory and tell us whether it's a bucket root, a
 *  per-source-ws subdir of a parent bucket, or neither. Pure;
 *  does no DB I/O. Exposed for callers (the CLI) that need to
 *  distinguish Form 1 vs Form 2 to enforce the anti-feature guard. */
export function detectBucketShape(bucketDir: string): BucketShape {
  if (!existsSync(bucketDir) || !statSync(bucketDir).isDirectory()) return "bucket";
  const manifestPath = join(bucketDir, "manifest.json");
  const probe = readManifest(manifestPath);
  if (probe.kind === "v2") return "bucket";
  // The source-ws subdir signature: README.md + INDEX.md + tasks/
  // (matches what renderBucketSourceFiles writes per source-ws).
  if (
    existsSync(join(bucketDir, "README.md")) &&
    existsSync(join(bucketDir, "INDEX.md")) &&
    existsSync(join(bucketDir, "tasks")) &&
    statSync(join(bucketDir, "tasks")).isDirectory()
  ) {
    return "sourceWsSubdir";
  }
  return "bucket";
}

function walkBucket(bucketDir: string): {
  /** The bucket manifest. For source-ws-subdir mode, this is the
   *  parent bucket's manifest; bucketLabel still flows through. */
  manifest: ExportManifest;
  /** Every source-ws subdir under the bucket. For source-ws-subdir
   *  mode, this list has exactly one entry (the dir we were given). */
  sources: BucketSource[];
  /** Detected on-disk shape; the CLI uses this to refuse
   *  `--source-ws` on a Form 1 invocation. */
  shape: BucketShape;
} {
  if (!existsSync(bucketDir)) {
    throw new ImportBucketInvalidError(bucketDir, "directory does not exist");
  }
  if (!statSync(bucketDir).isDirectory()) {
    throw new ImportBucketInvalidError(bucketDir, "not a directory");
  }
  const manifestPath = join(bucketDir, "manifest.json");
  const probe = readManifest(manifestPath);

  // ── Form 2 (the classic): <dir>/manifest.json present ──
  if (probe.kind === "v2") {
    const manifest = probe.manifest;
    const sources: BucketSource[] = [];
    for (const entry of readdirSync(bucketDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDir = join(bucketDir, entry.name);
      const tasksDir = join(sourceDir, "tasks");
      if (!existsSync(tasksDir) || !statSync(tasksDir).isDirectory()) continue;
      const taskFiles: string[] = [];
      for (const f of readdirSync(tasksDir, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith(".md")) {
          taskFiles.push(join(tasksDir, f.name));
        }
      }
      taskFiles.sort();
      sources.push({ diskName: entry.name, taskFiles });
    }
    sources.sort((a, b) => a.diskName.localeCompare(b.diskName));
    return { manifest, sources, shape: "bucket" };
  }
  if (probe.kind === "corrupt") {
    throw new ImportBucketInvalidError(bucketDir, "manifest.json is unreadable / malformed");
  }

  // ── Form 1 (per-source-ws subdir): manifest.json absent at <dir>;
  // expect README.md + INDEX.md + tasks/ and a parent bucket manifest. ──
  const tasksDir = join(bucketDir, "tasks");
  const looksLikeSourceWs =
    existsSync(join(bucketDir, "README.md")) &&
    existsSync(join(bucketDir, "INDEX.md")) &&
    existsSync(tasksDir) &&
    statSync(tasksDir).isDirectory();
  if (!looksLikeSourceWs) {
    throw new ImportBucketInvalidError(bucketDir, "manifest.json missing");
  }

  // Walk one level up; require a v2 bucket manifest with our basename
  // listed under sources. Refuse "orphan" source-ws subdirs (an
  // intermediate that someone copied out of a bucket loses the
  // bucketLabel + cross-source provenance).
  const parentDir = dirname(bucketDir);
  const baseName = basename(bucketDir);
  const parentProbe = readManifest(join(parentDir, "manifest.json"));
  if (parentProbe.kind !== "v2") {
    throw new ImportBucketInvalidError(
      bucketDir,
      `${bucketDir} looks like a per-source-ws subdir (README.md + INDEX.md + tasks/), but ${parentDir}/manifest.json is missing or not a bucketVersion 2 manifest. Pass the parent bucket directory instead, or re-export.`,
    );
  }
  const parentManifest = parentProbe.manifest;
  if (!Object.prototype.hasOwnProperty.call(parentManifest.sources ?? {}, baseName)) {
    throw new ImportBucketInvalidError(
      bucketDir,
      `${bucketDir} looks like a per-source-ws subdir but "${baseName}" is not in the parent bucket manifest's sources (${parentDir}/manifest.json). Re-export to refresh the bucket manifest.`,
    );
  }

  // Synthesize a single-source BucketSource list. Reuse the parent
  // manifest verbatim so bucketLabel + bucketVersion flow through.
  const taskFiles: string[] = [];
  for (const f of readdirSync(tasksDir, { withFileTypes: true })) {
    if (f.isFile() && f.name.endsWith(".md")) {
      taskFiles.push(join(tasksDir, f.name));
    }
  }
  taskFiles.sort();
  return {
    manifest: parentManifest,
    sources: [{ diskName: baseName, taskFiles }],
    shape: "sourceWsSubdir",
  };
}

// ─── Per-source-ws DB writer ─────────────────────────────────────────

/** Insert one source's tasks + edges + notes inside one transaction.
 *  Throws to roll the whole source back; caller catches per-source. */
function importOneSource(
  db: Db,
  targetWorkstream: string,
  parsed: ParsedFrontmatter[],
  options: { dryRun: boolean },
): { tasksImported: number; edgesImported: number; notesImported: number } {
  // Build the id-set early so we can validate edge endpoints before
  // any INSERT (cheap-fail path; the transaction below can also catch
  // a missed ref but pre-validating gives a clearer error message and
  // skips the rollback bookkeeping).
  const idSet = new Set(parsed.map((p) => p.id));
  for (const t of parsed) {
    for (const blocker of t.blockedBy) {
      if (!idSet.has(blocker)) {
        throw new ImportEdgeRefMissingError(t.id, blocker, "blocked_by");
      }
    }
    for (const dep of t.blocks) {
      if (!idSet.has(dep)) {
        throw new ImportEdgeRefMissingError(t.id, dep, "blocks");
      }
    }
  }

  if (options.dryRun) {
    // Edges: count canonical (blocker → blocked) edges; the renderer
    // emits both blocked_by AND blocks, but they're the same set.
    // We dedupe on (from, to) pairs.
    const edgePairs = new Set<string>();
    for (const t of parsed) {
      for (const blocker of t.blockedBy) edgePairs.add(`${blocker}\0${t.id}`);
      for (const dep of t.blocks) edgePairs.add(`${t.id}\0${dep}`);
    }
    const noteCount = parsed.reduce((acc, p) => acc + p.notes.length, 0);
    return {
      tasksImported: parsed.length,
      edgesImported: edgePairs.size,
      notesImported: noteCount,
    };
  }

  return db.transaction(() => {
    ensureWorkstream(db, targetWorkstream);
    const wsId = resolveWorkstreamId(db, targetWorkstream);

    // INSERT tasks. Preserve created_at / updated_at, force owner to
    // NULL (agents aren't restored). Status is preserved verbatim;
    // schema CHECK keeps us honest.
    const insertTask = db.prepare(
      `INSERT INTO tasks
         (workstream_id, local_id, title, status, impact, effort_days, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    );
    const taskIdByLocalId = new Map<string, number>();
    for (const t of parsed) {
      const r = insertTask.run(
        wsId,
        t.id,
        t.title,
        t.status,
        t.impact,
        t.effortDays,
        t.createdAt,
        t.updatedAt,
      );
      taskIdByLocalId.set(t.id, Number(r.lastInsertRowid));
    }

    // Edges DEFERRED until every task is inserted (forward refs).
    // Dedupe (from, to) so blocked_by + blocks (which are mutual)
    // don't double-insert. Same pair from two task files is a no-op.
    const insertEdge = db.prepare(
      "INSERT OR IGNORE INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    );
    const seenEdges = new Set<string>();
    let edgesImported = 0;
    const now = new Date().toISOString();
    const recordEdge = (fromLocal: string, toLocal: string): void => {
      const key = `${fromLocal}\0${toLocal}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      const fromId = taskIdByLocalId.get(fromLocal);
      const toId = taskIdByLocalId.get(toLocal);
      if (fromId === undefined || toId === undefined) return; // pre-validated
      const r = insertEdge.run(fromId, toId, now);
      if (r.changes > 0) edgesImported += 1;
    };
    for (const t of parsed) {
      for (const blocker of t.blockedBy) recordEdge(blocker, t.id);
      for (const dep of t.blocks) recordEdge(t.id, dep);
    }

    // Notes — preserve author + content + createdAt verbatim.
    const insertNote = db.prepare(
      "INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)",
    );
    let notesImported = 0;
    for (const t of parsed) {
      const taskId = taskIdByLocalId.get(t.id);
      if (taskId === undefined) continue;
      for (const note of t.notes) {
        insertNote.run(taskId, note.author, note.content, note.createdAt);
        notesImported += 1;
      }
    }

    emitEvent(
      db,
      targetWorkstream,
      `workstream import ${targetWorkstream} (tasks=${parsed.length}, edges=${edgesImported}, notes=${notesImported})`,
    );
    return {
      tasksImported: parsed.length,
      edgesImported,
      notesImported,
    };
  })();
}

// ─── Public verb ─────────────────────────────────────────────────────

/**
 * Import a v0.3 bucket directory back into the DB. One source-ws
 * subdirectory becomes one workstream + N tasks + M edges + K notes.
 * Per source-ws transactional: a failure in source A rolls back A
 * but leaves source B's import committed.
 *
 * Throws on unrecoverable bucket-level errors (no manifest,
 * --workstream override against multi-source). Per-source
 * errors (frontmatter parse, edge ref, target name collision) leave
 * the failing source's `errors` array populated and that source's
 * counts at zero; siblings still attempt their own import.
 */
export function importBucket(db: Db, opts: ImportBucketOptions): ImportBucketResult {
  const { manifest, sources, shape } = walkBucket(opts.bucketDir);

  // Anti-feature guard: --source-ws against a per-source-ws subdir
  // is meaningless (the subdir already implies a single source).
  // Refuse loudly so a confused operator drops the flag rather
  // than silently importing something they didn't expect.
  if (shape === "sourceWsSubdir" && opts.sourceWs !== undefined && opts.sourceWs.length > 0) {
    throw new ImportBucketInvalidError(
      opts.bucketDir,
      `cannot pass --source-ws when ${opts.bucketDir} is itself a source-ws subdir; drop the flag`,
    );
  }

  // Apply the --source-ws filter (Form 2 only). Validate every name
  // is a key in the bucket manifest BEFORE the walker's source list,
  // so a typo surfaces an ImportSourceNotInBucketError listing the
  // valid names rather than a silent "nothing to import".
  let filteredSources = sources;
  if (opts.sourceWs !== undefined && opts.sourceWs.length > 0) {
    const validNames = Object.keys(manifest.sources ?? {}).sort();
    const validSet = new Set(validNames);
    for (const wanted of opts.sourceWs) {
      if (!validSet.has(wanted)) {
        throw new ImportSourceNotInBucketError(opts.bucketDir, wanted, validNames);
      }
    }
    const wantedSet = new Set(opts.sourceWs);
    filteredSources = sources.filter((s) => wantedSet.has(s.diskName));
  }

  if (opts.workstreamOverride !== undefined && filteredSources.length !== 1) {
    throw new ImportBucketInvalidError(
      opts.bucketDir,
      `--workstream override requires a single source-ws subdir; this bucket has ${filteredSources.length}`,
    );
  }

  const dryRun = opts.dryRun === true;
  const results: ImportSourceResult[] = [];

  for (const source of filteredSources) {
    const targetName = opts.workstreamOverride ?? source.diskName;
    const result: ImportSourceResult = {
      workstreamName: targetName,
      tasksImported: 0,
      edgesImported: 0,
      notesImported: 0,
      tombstonesSkipped: 0,
      errors: [],
    };

    // Walk the tombstones first; counted but never imported.
    const liveFiles: string[] = [];
    for (const file of source.taskFiles) {
      const head = readFileSync(file, "utf8").slice(0, DELETED_BANNER_PREFIX.length);
      if (head.startsWith(DELETED_BANNER_PREFIX)) {
        result.tombstonesSkipped += 1;
        continue;
      }
      liveFiles.push(file);
    }

    // Pre-flight: refuse merge into an existing workstream of the
    // same target name. Done BEFORE parsing so a heavy bucket fails
    // fast on the cheap check.
    if (!dryRun) {
      const existing = db
        .prepare("SELECT 1 AS x FROM workstreams WHERE name = ?")
        .get(targetName) as { x: number } | undefined;
      if (existing !== undefined) {
        const err = new WorkstreamAlreadyExistsError(targetName);
        result.errors.push(err.message);
        results.push(result);
        // Bubble the typed error up so the CLI maps it to exit 4.
        // We've already populated result.errors for the JSON view;
        // the throw below preempts subsequent siblings, which is
        // intentional for the conflict case.
        throw err;
      }
    }

    let parsed: ParsedFrontmatter[];
    try {
      parsed = liveFiles.map(parseTaskMarkdown);
    } catch (err) {
      // Frontmatter parse errors abort the source AND propagate so
      // the CLI maps them to exit 2; we still emit a per-source
      // result so the JSON view names the failing workstream.
      result.errors.push(err instanceof Error ? err.message : String(err));
      results.push(result);
      throw err;
    }

    try {
      const counts = importOneSource(db, targetName, parsed, { dryRun });
      result.tasksImported = counts.tasksImported;
      result.edgesImported = counts.edgesImported;
      result.notesImported = counts.notesImported;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
      results.push(result);
      throw err;
    }
    results.push(result);
  }

  return {
    bucketLabel: manifest.bucketLabel,
    bucketVersion: manifest.bucketVersion,
    sources: results,
  };
}
