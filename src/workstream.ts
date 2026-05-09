// mu — workstream-level operations.
//
// One workstream = one tmux session + N agents + M tasks (and their
// edges/notes) all sharing the workstream column. 0.1.0 ships `mu init`
// (create the tmux session) and `mu destroy` (this module: nuke the
// tmux session and every DB row tagged with the workstream name).
//
// `destroyWorkstream` is idempotent on every leg:
//   - tmux session already gone        → killSession swallows the error
//   - no agents/tasks for this name    → DELETE returns zero changes
//   - workstream never existed at all  → returns all-zero counts
//
// Both summarize and destroy take an optional `tmuxSession` override so
// tests (and the rare workstream whose tmux session was created with a
// non-default name) work without env-var gymnastics.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Db, defaultStateDir } from "./db.js";
import { emitEvent, latestSeq } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { captureSnapshot } from "./snapshots.js";
import { getTaskEdges, listNotes, listTasks } from "./tasks.js";
import type { TaskNoteRow, TaskRow } from "./tasks.js";
import { killSession, listSessions, sessionExists } from "./tmux.js";
import { type VcsBackend, type VcsBackendName, backendByName } from "./vcs.js";
import { listWorkspaces } from "./workspace.js";

/**
 * Allowed workstream-name shape: lowercase alpha first, then alnum,
 * underscore, or hyphen, up to 32 chars total. Mirrors the agent-name
 * rule in VOCABULARY.md §"Naming conventions".
 *
 * Critically, this rule excludes `.` and `:` — tmux silently rewrites
 * `.` to `_` in session names (because `.` is the window/pane separator
 * in tmux's `session:window.pane` target syntax) and `:` is reserved
 * outright. A workstream name with `.` would create a session that mu
 * couldn't subsequently look up, breaking every downstream verb. We
 * fail loud at init time instead.
 */
const WORKSTREAM_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** Reserved prefix — mu auto-prepends `mu-` to derive the tmux session
 *  name (so workstream `auth` lives in tmux session `mu-auth`). A
 *  workstream named `mu-auth` would produce session `mu-mu-auth`,
 *  which the user almost certainly didn't intend. Fail loud rather
 *  than silently double-prefix. */
const RESERVED_WORKSTREAM_PREFIX = "mu-";

export function isValidWorkstreamName(name: string): boolean {
  if (!WORKSTREAM_NAME_RE.test(name)) return false;
  if (name.startsWith(RESERVED_WORKSTREAM_PREFIX)) return false;
  return true;
}

/** Thrown by `ensureWorkstream` and `mu workstream init` when the name
 *  doesn't match the rules. */
export class WorkstreamNameInvalidError extends Error implements HasNextSteps {
  override readonly name = "WorkstreamNameInvalidError";
  constructor(public readonly attempted: string) {
    const reason = attempted.startsWith(RESERVED_WORKSTREAM_PREFIX)
      ? `the 'mu-' prefix is reserved (mu auto-prepends 'mu-' to derive the tmux session name; '${attempted}' would produce session 'mu-${attempted}', which is double-prefixed and almost never what you want). Drop the 'mu-' from the workstream name.`
      : `must match /^[a-z][a-z0-9_-]{0,31}$/. tmux silently rewrites '.' to '_' and reserves ':' as a target separator, so workstream names containing those characters would create tmux sessions mu couldn't look up afterwards. Use letters, digits, '_', and '-' only.`;
    super(`invalid workstream name ${JSON.stringify(attempted)}: ${reason}`);
  }
  errorNextSteps(): NextStep[] {
    // Suggest a sanitized form: strip the mu- prefix; replace dots and
    // colons with underscores; lowercase.
    const sanitized = this.attempted
      .toLowerCase()
      .replace(/^mu-/, "")
      .replace(/[.:]/g, "_")
      .slice(0, 32);
    return [
      {
        intent: "Try a sanitized name (best guess)",
        command: `mu workstream init ${sanitized || "<name>"}`,
      },
      { intent: "List existing workstreams", command: "mu workstream list" },
    ];
  }
}

function assertValidWorkstreamName(name: string): void {
  if (!isValidWorkstreamName(name)) throw new WorkstreamNameInvalidError(name);
}

/**
 * Ensure a row exists in the `workstreams` table for `name`. Idempotent;
 * INSERT OR IGNORE so concurrent callers race safely. Called by
 * `insertAgent` and `addTask` so callers don't need to remember to call
 * `mu init` before adding a task / spawning an agent (preserves the
 * spawn-without-init ergonomics now that agents.workstream and
 * tasks.workstream are real FKs into this table).
 *
 * Validates the name before inserting; throws `WorkstreamNameInvalidError`
 * for names tmux would silently mangle (containing '.' or ':') or that
 * exceed 32 chars / start with a non-letter.
 *
 * Returns true iff a row was actually inserted (vs. already present).
 */
export function ensureWorkstream(db: Db, name: string): boolean {
  assertValidWorkstreamName(name);
  const result = db
    .prepare("INSERT OR IGNORE INTO workstreams (name, created_at) VALUES (?, ?)")
    .run(name, new Date().toISOString());
  const created = result.changes > 0;
  if (created) emitEvent(db, name, `workstream init ${name}`);
  return created;
}

export interface WorkstreamSummary {
  workstream: string;
  /** Tmux session name, defaults to `mu-<workstream>`. */
  tmuxSession: string;
  /** True iff `tmux has-session -t <tmuxSession>` succeeds right now. */
  tmuxAlive: boolean;
  /** Rows in `agents` for this workstream. */
  agents: number;
  /** Rows in `tasks` for this workstream. */
  tasks: number;
  /** Rows in `task_notes` whose task is in this workstream. */
  notes: number;
  /** Rows in `task_edges` whose `from_task` is in this workstream. */
  edges: number;
  /** Rows in `vcs_workspaces` for this workstream. Surfaced so the
   *  destroy dry-run can warn about per-agent worktrees that need
   *  cleanup before the FK cascade silently nukes their rows. */
  workspaces: number;
  /** True iff a row exists in the `workstreams` table itself. False
   *  for tmux-only `mu-*` sessions that mu never observed via
   *  `mu workstream init`. Surfaced so destroy can clean up bare
   *  registry rows (workstream row exists, no agents/tasks/etc.) —
   *  otherwise such rows are orphaned forever (the previous
   *  `nothingToDo` heuristic short-circuited on them). */
  registered: boolean;
}

export interface DestroyResult {
  /** True iff `tmux kill-session` actually killed something. */
  killedTmux: boolean;
  /** Number of `agents` rows deleted. */
  deletedAgents: number;
  /** Number of `tasks` rows deleted (edges/notes cascade via FK). */
  deletedTasks: number;
  /** Number of `task_notes` deleted by the cascade — informational. */
  deletedNotes: number;
  /** Number of `task_edges` deleted by the cascade — informational. */
  deletedEdges: number;
  /** Number of vcs_workspaces whose on-disk path was actually
   *  removed by the backend on this destroy. Excludes
   *  `alreadyGoneWorkspaces` (those were no-ops on disk). */
  freedWorkspaces: number;
  /** Number of vcs_workspaces whose registry row existed but
   *  whose on-disk path was already gone (manual rm -rf or a prior
   *  interrupted destroy). The DB row was cascade-deleted; the
   *  backend did no filesystem work. Tracked separately so the
   *  destroy report doesn't lie about how much cleanup it actually
   *  performed. */
  alreadyGoneWorkspaces: number;
  /** Workspaces whose backend cleanup failed (e.g. `git worktree
   *  remove` refused because of uncommitted changes). The DB row
   *  was still cascade-deleted; the on-disk path remains and needs
   *  manual cleanup. */
  failedWorkspaces: WorkspaceFailure[];
}

export interface WorkspaceFailure {
  agent: string;
  backend: string;
  path: string;
  error: string;
}

export interface WorkstreamOptions {
  workstream: string;
  /** Override the tmux session name. Defaults to `mu-<workstream>`. */
  tmuxSession?: string;
  /** Override the per-name VcsBackend resolver. Defaults to
   *  `backendByName`. Lets tests inject a fake backend (e.g. one whose
   *  `freeWorkspace` throws) without mutating the exported singletons —
   *  same pattern as `createWorkspace`'s `opts.backend` accepting a
   *  pre-built `VcsBackend` object. Production callers leave this
   *  unset. */
  resolveBackend?: (name: VcsBackendName) => VcsBackend;
}

/**
 * Discover every workstream visible on this machine. The union of:
 *   - rows in the `workstreams` table (canonical DB source; populated by
 *     `mu init` and auto-created by insertAgent / addTask)
 *   - tmux sessions named `mu-*` (with the prefix stripped) — catches
 *     externally-created `tmux new-session -s mu-foo` that mu hasn't
 *     observed yet
 *
 * Returns one `WorkstreamSummary` per workstream, sorted by name.
 * Useful as a pre-flight before `mu init` ("is this name taken?") and
 * for `mu doctor`-style diagnostics.
 */
export async function listWorkstreams(db: Db): Promise<WorkstreamSummary[]> {
  const dbNames = new Set<string>(
    (db.prepare("SELECT name FROM workstreams").all() as { name: string }[]).map((r) => r.name),
  );

  const tmuxNames = new Set<string>();
  for (const session of await listSessions()) {
    if (session.name.startsWith("mu-")) tmuxNames.add(session.name.slice(3));
  }

  const allNames = Array.from(new Set([...dbNames, ...tmuxNames])).sort();
  return Promise.all(allNames.map((name) => summarizeWorkstream(db, { workstream: name })));
}

export async function summarizeWorkstream(
  db: Db,
  opts: WorkstreamOptions,
): Promise<WorkstreamSummary> {
  const tmuxSession = opts.tmuxSession ?? `mu-${opts.workstream}`;
  return {
    workstream: opts.workstream,
    tmuxSession,
    tmuxAlive: await sessionExists(tmuxSession),
    agents: countAgents(db, opts.workstream),
    tasks: countTasks(db, opts.workstream),
    notes: countNotes(db, opts.workstream),
    edges: countEdges(db, opts.workstream),
    workspaces: listWorkspaces(db, opts.workstream).length,
    registered: isRegistered(db, opts.workstream),
  };
}

function isRegistered(db: Db, workstream: string): boolean {
  const row = db.prepare("SELECT 1 AS x FROM workstreams WHERE name = ?").get(workstream) as
    | { x: number }
    | undefined;
  return row !== undefined;
}

/**
 * Tear down a workstream: kill its tmux session and delete every DB row
 * tagged with its name. Cascades on `tasks` clean up `task_edges` and
 * `task_notes` automatically (FK ON DELETE CASCADE in the schema).
 *
 * Idempotent: safe to call against a workstream that never existed; safe
 * to call repeatedly. Returns counts so the caller can print a useful
 * summary.
 */
export async function destroyWorkstream(db: Db, opts: WorkstreamOptions): Promise<DestroyResult> {
  const tmuxSession = opts.tmuxSession ?? `mu-${opts.workstream}`;

  // Pre-mutation snapshot (snap_design §EDGE CASES > WORKSTREAM
  // DESTROY). workstream=null because workstream-destroy snapshots
  // logically span every workstream in the DB (whole-DB backup;
  // anchoring to one name would lie about scope). If the snapshot
  // throws (disk full, perms), abort the destroy — better to refuse
  // than to delete irrecoverably.
  captureSnapshot(db, `workstream destroy ${opts.workstream}`, null);

  // Pre-count the cascade victims so we can report them — SQLite's
  // changes() only reports rows directly affected by the last statement,
  // not cascade victims.
  const agentsBefore = countAgents(db, opts.workstream);
  const tasksBefore = countTasks(db, opts.workstream);
  const notesBefore = countNotes(db, opts.workstream);
  const edgesBefore = countEdges(db, opts.workstream);
  const workspacesBefore = listWorkspaces(db, opts.workstream);

  // Tmux first: if killSession throws we don't want the DB rows already
  // gone with no way to recover. (killSession is itself idempotent on
  // missing sessions — a real throw here is an unexpected tmux error.)
  const tmuxAliveBefore = await sessionExists(tmuxSession);
  if (tmuxAliveBefore) {
    await killSession(tmuxSession);
  }

  // Workspaces SECOND, before the FK cascade. The cascade silently
  // deletes vcs_workspaces rows but leaves the on-disk worktrees
  // (and the git worktree registry entries) behind — the bug from
  // mufeedback note #195. Per backend, the right cleanup is
  // 'git worktree remove --force' / 'jj workspace forget' / etc.,
  // not 'rm -rf'. We surface failures so the user can recover; we
  // do NOT abort the destroy on workspace failure (the workstream
  // semantics are 'tear it all down', not 'partial cleanup').
  let freedWorkspaces = 0;
  let alreadyGoneWorkspaces = 0;
  const failedWorkspaces: WorkspaceFailure[] = [];
  const resolveBackend = opts.resolveBackend ?? backendByName;
  for (const ws of workspacesBefore) {
    try {
      const backend = resolveBackend(ws.backend);
      const result = await backend.freeWorkspace({
        workspacePath: ws.path,
        commit: false,
      });
      if (result.removed) {
        // Backend actually removed the on-disk path. This is the
        // only case that counts as 'work done by destroy'.
        freedWorkspaces += 1;
      } else {
        // Path was already gone (manual rm -rf or interrupted prior
        // destroy). The DB row is cascade-deleted below either way,
        // but we don't claim to have freed anything on disk — it was
        // already in the desired state. Tracked separately so the
        // user can spot stale registry rows from past mishaps.
        alreadyGoneWorkspaces += 1;
      }
    } catch (err) {
      failedWorkspaces.push({
        agent: ws.agent,
        backend: ws.backend,
        path: ws.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // After every per-agent worktree is freed, the parent
  // <state>/workspaces/<workstream>/ directory is empty — reap it
  // too. Best-effort: rmdir refuses if non-empty (e.g. backend
  // removal failed and left files behind), which is the right
  // outcome (don't silently rm -rf user data). Skipped if the
  // parent doesn't exist (workstream never had any workspaces).
  const parentDir = join(defaultStateDir(), "workspaces", opts.workstream);
  if (existsSync(parentDir)) {
    try {
      if (readdirSync(parentDir).length === 0) rmdirSync(parentDir);
    } catch {
      // Non-empty or otherwise unreapable. The failed-workspaces
      // list above already tells the user what to clean.
    }
  }

  // One DELETE: the FK CASCADE chain (workstreams → agents,
  // workstreams → tasks → task_edges + task_notes, workstreams →
  // agent_logs, workstreams → vcs_workspaces) cleans every row in
  // one shot, atomically. If the workstream was never registered
  // (e.g. an orphan tmux session that mu never observed),
  // changes() = 0 and we still report the killed tmux session
  // honestly.
  const result = db.prepare("DELETE FROM workstreams WHERE name = ?").run(opts.workstream);
  // The destroy event itself goes to workstream=null (machine-wide)
  // because the FK CASCADE we just triggered would otherwise wipe
  // it on the same statement. Visible via `mu log --all`.
  if (result.changes > 0 || tmuxAliveBefore) {
    emitEvent(
      db,
      null,
      `workstream destroy ${opts.workstream} (agents=${agentsBefore}, tasks=${tasksBefore}, edges=${edgesBefore}, notes=${notesBefore}, workspaces=${freedWorkspaces}/${workspacesBefore.length}, already_gone=${alreadyGoneWorkspaces}, tmux=${tmuxAliveBefore})`,
    );
  }

  return {
    killedTmux: tmuxAliveBefore,
    deletedAgents: agentsBefore,
    deletedTasks: tasksBefore,
    deletedNotes: notesBefore,
    deletedEdges: edgesBefore,
    freedWorkspaces,
    alreadyGoneWorkspaces,
    failedWorkspaces,
  };
}

// ─── Counts ────────────────────────────────────────────────────────────

function countAgents(db: Db, workstream: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM agents WHERE workstream = ?")
    .get(workstream) as { n: number };
  return row.n;
}

function countTasks(db: Db, workstream: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM tasks WHERE workstream = ?")
    .get(workstream) as { n: number };
  return row.n;
}

function countNotes(db: Db, workstream: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM task_notes n
         JOIN tasks      t ON t.local_id = n.task_id
        WHERE t.workstream = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}

function countEdges(db: Db, workstream: string): number {
  // Count edges whose blocker (from_task) is in the workstream. Since
  // cross-workstream edges are forbidden by addTask, this equals the
  // edge count for the workstream subgraph.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM task_edges e
         JOIN tasks      t ON t.local_id = e.from_task
        WHERE t.workstream = ?`,
    )
    .get(workstream) as { n: number };
  return row.n;
}

// ─── exportWorkstream ──────────────────────────────────────────────────
//
// Render a workstream's task graph + notes as a directory of plain
// markdown so operators can preserve the conversation OUTSIDE mu (for
// code review, project handoff, grep, git-checked-in artifacts) before
// `mu workstream destroy` blows it away. Re-export against the same
// directory is idempotent: identical files are not rewritten (sha256
// short-circuit), changed tasks get one-line frontmatter / one-section
// note diffs, new tasks get new files, and tasks that have since been
// deleted from the DB STAY on disk with a banner so the operator never
// loses context they may have already git-blamed.
//
// Anti-features (per the originating design note):
//   - re-import: out of scope; manifest.json gives a future hook
//   - HTML/PDF: markdown-only; operators can pandoc
//   - embedded VCS: caller can `git init && git add . && git commit`
//   - cross-workstream merge: one workstream per export call

export interface ExportWorkstreamOptions {
  workstream: string;
  /** Output directory. Defaults to `./<workstream>/` in the cwd. */
  outDir?: string;
}

export interface ExportTaskEntry {
  /** Task local_id == filename stem (`<id>.md`). */
  id: string;
  /** Path relative to outDir. */
  path: string;
  /** sha256 of the markdown body bytes. Lets a re-export skip
   *  byte-identical writes. */
  sha256: string;
  /** ISO timestamp of the first observed export at which the task
   *  was missing from the DB (preserved across re-exports via
   *  manifest.json merge). Absent for tasks that still exist. */
  deletedAt?: string;
}

export interface ExportManifest {
  workstream: string;
  exportedAt: string;
  muVersion: string;
  /** `latestSeq(db)` at export time — a re-importer (future) can
   *  reason about what happened after this snapshot. */
  eventsSeqAtExport: number;
  tasks: ExportTaskEntry[];
}

export interface ExportResult {
  outDir: string;
  written: number;
  unchanged: number;
  /** Tasks present in a previous manifest that are no longer in the
   *  DB. Their .md is preserved; a banner is added (idempotent: not
   *  re-added on subsequent re-exports). */
  preserved: number;
  manifestPath: string;
  manifest: ExportManifest;
}

/** Wrap arbitrary text in a fenced code block, choosing a fence longer
 *  than any backtick run inside `body` so the body's literal ``` (or
 *  ````, etc.) survives intact. Used for note content, which routinely
 *  contains markdown / code / triple-fences. */
function fenceForBody(body: string): string {
  const longestRun = (body.match(/`+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
}

/** YAML-ish scalar quote: always double-quoted, with `"` and `\\`
 *  escaped. Good enough for the small string set we emit (titles,
 *  ids, status, evidence). Multi-line evidence strings are coerced
 *  to single-line by replacing newlines with ` ` so the frontmatter
 *  block stays valid YAML — full faithful evidence still appears in
 *  the per-task notes section if the operator captured it via
 *  `mu task close --evidence`. */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function renderTaskMarkdown(
  task: TaskRow,
  edges: { blockers: string[]; dependents: string[] },
  notes: TaskNoteRow[],
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${yamlScalar(task.localId)}`);
  lines.push(`workstream: ${yamlScalar(task.workstream)}`);
  lines.push(`status: ${task.status}`);
  lines.push(`impact: ${task.impact}`);
  lines.push(`effort_days: ${task.effortDays}`);
  // ROI is derived but a load-bearing field for operators ranking
  // closed tasks in retrospect; emit it precomputed so consumers
  // don't have to re-derive.
  lines.push(`roi: ${(task.impact / task.effortDays).toFixed(2)}`);
  lines.push(`owner: ${task.owner === null ? "null" : yamlScalar(task.owner)}`);
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
    for (const note of notes) {
      lines.push(`### #${note.id} by ${note.author ?? "system"}, ${note.createdAt}`);
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

function renderIndexMarkdown(workstream: string, tasks: TaskRow[]): string {
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
    // Pipe-escape titles so the table stays valid markdown.
    const title = t.title.replace(/\|/g, "\\|");
    lines.push(
      `| [\`${t.localId}\`](tasks/${t.localId}.md) | ${t.status} | ${t.impact} | ${t.effortDays} | ${roi} | ${title} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderReadmeMarkdown(workstream: string, tasks: TaskRow[], exportedAt: string): string {
  const counts: Record<string, number> = {
    OPEN: 0,
    IN_PROGRESS: 0,
    CLOSED: 0,
    REJECTED: 0,
    DEFERRED: 0,
  };
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const lines: string[] = [];
  lines.push(`# Workstream: ${workstream}`);
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
  lines.push(
    "_This directory was produced by `mu workstream export`. Re-run the verb to regenerate; deleted tasks are preserved with a banner. See `manifest.json` for the machine-readable index._",
  );
  lines.push("");
  return lines.join("\n");
}

const DELETED_BANNER_PREFIX = "> **Deleted from DB on ";

function bannerFor(timestamp: string): string {
  return `${DELETED_BANNER_PREFIX}${timestamp}** — this task no longer exists in mu's database. The export below is the last-known state. Re-export will not regenerate it.\n\n`;
}

/** Read an existing manifest if present; tolerant of corruption (returns
 *  undefined and the export rebuilds from scratch — every per-task .md
 *  will be re-written, but no data is lost). */
function readManifest(path: string): ExportManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ExportManifest;
    if (typeof parsed.workstream !== "string" || !Array.isArray(parsed.tasks)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Read the package.json shipped next to the bundled CLI (or src/) so
 *  the manifest records the mu version that produced it. Falls back to
 *  "unknown" if the file isn't reachable (e.g. mu loaded from a tarball
 *  with no sibling package.json). */
function readMuVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Export a workstream's task graph + notes to a directory of markdown
 * files. Idempotent against the same `outDir`: re-export rewrites only
 * tasks whose markdown changed; tasks deleted from the DB since the
 * previous export are preserved on disk with a one-time banner; new
 * tasks get new files; the manifest.json is rewritten in place.
 *
 * Throws on the following NON-recoverable conditions:
 *   - `outDir` exists but is not a directory (refuses to clobber)
 *   - any per-task path inside `outDir` exists but is a directory
 *
 * Otherwise: best-effort idempotent. Safe to call repeatedly. Cheap
 * enough (sha256 short-circuit) that auto-export at destroy time
 * is constant-time per unchanged task.
 */
export function exportWorkstream(db: Db, opts: ExportWorkstreamOptions): ExportResult {
  const outDir = resolve(opts.outDir ?? join(process.cwd(), opts.workstream));
  if (existsSync(outDir)) {
    const stat = statSync(outDir);
    if (!stat.isDirectory()) {
      throw new Error(`exportWorkstream: outDir exists and is not a directory: ${outDir}`);
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }
  const tasksDir = join(outDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const manifestPath = join(outDir, "manifest.json");
  const previous = readManifest(manifestPath);
  const previousById = new Map<string, ExportTaskEntry>();
  if (previous) {
    for (const t of previous.tasks) previousById.set(t.id, t);
  }

  const liveTasks = listTasks(db, opts.workstream);
  const liveIds = new Set(liveTasks.map((t) => t.localId));
  const exportedAt = new Date().toISOString();

  let written = 0;
  let unchanged = 0;
  let preserved = 0;
  const manifestEntries: ExportTaskEntry[] = [];

  for (const task of liveTasks) {
    const edges = getTaskEdges(db, task.localId);
    const notes = listNotes(db, task.localId);
    const md = renderTaskMarkdown(task, edges, notes);
    const sha = sha256Hex(md);
    const relPath = join("tasks", `${task.localId}.md`);
    const absPath = join(outDir, relPath);

    const prev = previousById.get(task.localId);
    const onDisk = existsSync(absPath);
    if (onDisk && prev?.sha256 === sha && prev.deletedAt === undefined) {
      // Identical to last export AND file still on disk — skip the
      // write so mtime stays put (operators sometimes git-blame these).
      unchanged += 1;
    } else {
      writeFileSync(absPath, md, "utf8");
      written += 1;
    }
    manifestEntries.push({ id: task.localId, path: relPath, sha256: sha });
  }

  // Preserve files for tasks that disappeared from the DB. We DO NOT
  // delete the .md (the operator may have git-blamed it; that's the
  // load-bearing invariant from the originating note). We DO add a
  // one-time banner so re-readers know the row is gone. The banner
  // is keyed off the manifest's `deletedAt`, not the file's content,
  // so a later re-export against a hand-edited file is still safe.
  for (const prev of previousById.values()) {
    if (liveIds.has(prev.id)) continue;
    const absPath = join(outDir, prev.path);
    const deletedAt = prev.deletedAt ?? exportedAt;
    if (existsSync(absPath)) {
      const existing = readFileSync(absPath, "utf8");
      // Idempotent banner add: only prepend if not already there.
      if (!existing.startsWith(DELETED_BANNER_PREFIX)) {
        writeFileSync(absPath, bannerFor(deletedAt) + existing, "utf8");
      }
    }
    manifestEntries.push({ ...prev, deletedAt });
    preserved += 1;
  }

  // Sort manifest entries by id for deterministic output (stable
  // diffs across re-exports).
  manifestEntries.sort((a, b) => a.id.localeCompare(b.id));

  const manifest: ExportManifest = {
    workstream: opts.workstream,
    exportedAt,
    muVersion: readMuVersion(),
    eventsSeqAtExport: latestSeq(db),
    tasks: manifestEntries,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // Static surface files: README.md (human entry point) and INDEX.md
  // (pretty table of every live task). Always rewritten — they're
  // cheap and a stale README would confuse the next reader.
  writeFileSync(
    join(outDir, "README.md"),
    renderReadmeMarkdown(opts.workstream, liveTasks, exportedAt),
    "utf8",
  );
  writeFileSync(join(outDir, "INDEX.md"), renderIndexMarkdown(opts.workstream, liveTasks), "utf8");

  emitEvent(
    db,
    opts.workstream,
    `workstream export ${opts.workstream} (out=${outDir}, tasks=${liveTasks.length}, written=${written}, unchanged=${unchanged}, preserved=${preserved})`,
  );

  return { outDir, written, unchanged, preserved, manifestPath, manifest };
}
