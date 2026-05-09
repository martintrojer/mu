// mu — task graph: CRUD primitives, verbs (addTask, addNote, claimTask),
// view reads (ready / blocked / goals), and DAG traversal helpers.
//
// The schema (db.ts) does the heavy lifting: PRIMARY KEYs, CHECK
// constraints on impact/effort/status, FK cascades on edges and notes.
// This module adds:
//   - the cycle check on edge insertion (SQL CHECK can't express it)
//   - the claim protocol (atomic CAS on tasks.owner via single UPDATE)
//   - row-shape mapping (snake_case columns → camelCase TS)

import type { Db } from "./db.js";
import { emitEvent } from "./logs.js";
import { captureSnapshot } from "./snapshots.js";
import {
  CrossWorkstreamEdgeError,
  CycleError,
  TaskExistsError,
  TaskIdInvalidError,
  TaskNotFoundError,
} from "./tasks/errors.js";
import type { TaskStatus } from "./tasks/status.js";
import { ensureWorkstream } from "./workstream.js";

// Re-export status enum + helpers and error classes from the cluster
// modules. Public callers continue to `import { ... } from "./tasks.js"`
// regardless of which sub-file the symbol lives in.
export {
  STATUSES_TERMINAL_OR_PARKED,
  TASK_STATUS_LIST,
  TASK_STATUSES,
  type TaskStatus,
  isTaskStatus,
} from "./tasks/status.js";
export {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  TaskAlreadyOwnedError,
  TaskExistsError,
  TaskHasOpenDependentsError,
  TaskIdInvalidError,
  TaskNotFoundError,
  TaskNotInWorkstreamError,
} from "./tasks/errors.js";
export {
  getWaitPollCount,
  resetWaitPollCount,
  setWaitSleepForTests,
  type TaskWaitOptions,
  type TaskWaitResult,
  type TaskWaitTaskState,
  waitForTasks,
} from "./tasks/wait.js";
export {
  type EvidenceOption,
  type RejectDeferOptions,
  type RejectDeferResult,
  type SetStatusResult,
  closeTask,
  deferTask,
  openTask,
  rejectTask,
  setTaskStatus,
} from "./tasks/lifecycle.js";
export {
  type ClaimResult,
  type ClaimTaskOptions,
  type ReleaseResult,
  type ReleaseTaskOptions,
  claimTask,
  releaseTask,
  resolveActorIdentity,
} from "./tasks/claim.js";

// ─── Domain types ──────────────────────────────────────────────────────

export interface TaskRow {
  localId: string;
  workstream: string;
  title: string;
  status: TaskStatus;
  impact: number;
  effortDays: number;
  owner: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskNoteRow {
  id: number;
  taskId: string;
  author: string | null;
  content: string;
  createdAt: string;
}

interface RawTaskRow {
  local_id: string;
  workstream: string;
  title: string;
  status: string;
  impact: number;
  effort_days: number;
  owner: string | null;
  created_at: string;
  updated_at: string;
}

interface RawTaskNoteRow {
  id: number;
  task_id: string;
  author: string | null;
  content: string;
  created_at: string;
}

function rowFromDb(row: RawTaskRow): TaskRow {
  return {
    localId: row.local_id,
    workstream: row.workstream,
    title: row.title,
    status: row.status as TaskStatus,
    impact: row.impact,
    effortDays: row.effort_days,
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function noteFromDb(row: RawTaskNoteRow): TaskNoteRow {
  return {
    id: row.id,
    taskId: row.task_id,
    author: row.author,
    content: row.content,
    createdAt: row.created_at,
  };
}

// ─── ID validation ─────────────────────────────────────────────────────

/** Lowercase alpha first, then alnum / underscore / hyphen, ≤64 chars. */
const TASK_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** The `mu_` prefix is reserved for system-generated IDs. Mirrors
 *  `tg`'s `T<digits>` reservation. */
const RESERVED_PREFIX = "mu_";

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id) && !id.startsWith(RESERVED_PREFIX);
}

/**
 * Derive a task id from a free-form title.
 *
 *   "Build the auth module"      → "build_the_auth_module"
 *   "FILES: foo.ts (refactor)"   → "files_foo_ts_refactor"
 *
/**
 * Soft cap for auto-generated slugs. The collision-suffix loop in
 * idFromTitle can push past this (`_2`, `_3`, ...) without going past
 * the hard ceiling. 40 chars hits the sweet spot of 'short enough to
 * type and to look reasonable in mu task tree' without losing too
 * much of the title's meaning.
 */
const SLUG_SOFT_CAP = 40;

/**
 * Hard ceiling for any generated id. Schema has no length limit, but
 * 64 keeps ids comfortable in tables, JSON, and tmux pane titles. The
 * collision-suffix loop also respects this.
 */
const SLUG_HARD_CAP = 64;

/**
 * Lowercase title; collapse non-alnum runs into single `_`; trim
 * leading/trailing `_`; prefix `t_` if the result starts with a digit
 * (schema requires first char letter); apply the soft cap with
 * word-boundary trim (cut at the last `_` at-or-before SLUG_SOFT_CAP
 * when one exists, else hard-truncate). Mirrors `tg`'s `id_from_title`
 * but adds the soft cap.
 *
 * Throws if `title` yields an empty slug after stripping.
 */
export function slugifyTitle(title: string): string {
  const stripped = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (stripped.length === 0) {
    throw new Error(`title yields empty slug: ${JSON.stringify(title)}`);
  }
  // Soft cap with word-boundary preference: if the slug exceeds the
  // soft cap, look for the last `_` at-or-before the cap and cut there
  // (so we never break a word). If no underscore is in the cap window
  // (ie the title is one giant word), fall back to a hard truncate at
  // the soft cap. The result is always <= SLUG_SOFT_CAP after this.
  let trimmed: string;
  if (stripped.length <= SLUG_SOFT_CAP) {
    trimmed = stripped;
  } else {
    const window = stripped.slice(0, SLUG_SOFT_CAP);
    const lastSep = window.lastIndexOf("_");
    trimmed = lastSep > 0 ? window.slice(0, lastSep) : window;
  }
  // Two prefix-corrections so derived slugs always pass the schema:
  //  - first char must be a letter → prefix `t_` if it isn't
  //  - the `mu_` prefix is reserved for system-generated IDs (see
  //    RESERVED_PREFIX above) → prefix `t_` so titles like
  //    "Mu smoke test" don't dead-end at addTask's reserved-prefix
  //    check. The explicit-id rejection still applies when a caller
  //    hand-writes `mu_foo`.
  const fixed = /^[a-z]/.test(trimmed) ? trimmed : `t_${trimmed}`;
  const safe = fixed.startsWith(RESERVED_PREFIX) ? `t_${fixed}` : fixed;
  return safe.slice(0, SLUG_HARD_CAP);
}

/**
 * Generate a unique task id from a title. On collision in `workstream`,
 * appends `_2`, `_3`, … until unique. Tasks are keyed on `local_id`
 * globally today, so collision check spans every workstream (a future
 * composite-PK migration would scope this).
 */
export function idFromTitle(db: Db, workstream: string, title: string): string {
  const base = slugifyTitle(title);
  if (getTask(db, base) === undefined) return base;
  // Truncate the BASE before adding the suffix, not the
  // suffix-after-concat. Concat-then-slice (the previous shape)
  // chops off the suffix when base.length is at SLUG_HARD_CAP,
  // making `_2` through `_999` all collapse back to base and the
  // loop exhaust 998 iterations before throwing an inscrutable
  // error. (review_code_slugify_collision_truncates: latent bug,
  // surfaced theoretically when a base hit the 64-char hard cap.)
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const truncatedBase = base.slice(0, SLUG_HARD_CAP - suffix.length);
    const candidate = `${truncatedBase}${suffix}`;
    if (getTask(db, candidate) === undefined) return candidate;
  }
  throw new Error(`could not derive a unique id from title in workstream ${workstream}: ${title}`);
}

// ─── Read primitives ───────────────────────────────────────────────────

export function getTask(db: Db, localId: string): TaskRow | undefined {
  const row = db.prepare("SELECT * FROM tasks WHERE local_id = ?").get(localId) as
    | RawTaskRow
    | undefined;
  return row ? rowFromDb(row) : undefined;
}

/**
 * List tasks. With no `workstream` arg returns every row — used by `mu sql`
 * and by tests; CLI surfaces always pass a workstream so users only see
 * their own.
 */
export interface ListTasksOptions {
  /** Filter to one or more lifecycle statuses. Omitted = all statuses. */
  status?: TaskStatus | readonly TaskStatus[];
}

export function listTasks(db: Db, workstream?: string, opts: ListTasksOptions = {}): TaskRow[] {
  const statuses =
    opts.status === undefined
      ? undefined
      : Array.isArray(opts.status)
        ? (opts.status as TaskStatus[])
        : [opts.status as TaskStatus];

  const where: string[] = [];
  const params: unknown[] = [];
  if (workstream !== undefined) {
    where.push("workstream = ?");
    params.push(workstream);
  }
  if (statuses !== undefined) {
    where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  const sql =
    where.length === 0
      ? "SELECT * FROM tasks ORDER BY local_id"
      : `SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY local_id`;
  const rows = db.prepare(sql).all(...params) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listReady(db: Db, workstream: string): TaskRow[] {
  const rows = db
    .prepare("SELECT * FROM ready WHERE workstream = ? ORDER BY local_id")
    .all(workstream) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listBlocked(db: Db, workstream: string): TaskRow[] {
  const rows = db
    .prepare("SELECT * FROM blocked WHERE workstream = ? ORDER BY local_id")
    .all(workstream) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listGoals(db: Db, workstream: string): TaskRow[] {
  const rows = db
    .prepare("SELECT * FROM goals WHERE workstream = ? ORDER BY local_id")
    .all(workstream) as RawTaskRow[];
  return rows.map(rowFromDb);
}

/** All IN_PROGRESS tasks in a workstream, most-recently-touched first.
 *  Used by `mu state` and `mu hud` to populate their in-progress slice;
 *  exposed as a named SDK helper so those CLI verbs don't re-derive
 *  the row-shape conversion (review_code_raw_task_state_duplicate). */
export function listInProgress(db: Db, workstream: string): TaskRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM tasks WHERE workstream = ? AND status = 'IN_PROGRESS' ORDER BY updated_at DESC",
    )
    .all(workstream) as RawTaskRow[];
  return rows.map(rowFromDb);
}

/** Most-recently-closed tasks in a workstream, newest first, capped at
 *  `limit` (default 5). Used by `mu state` for its 'recent closed'
 *  slice; exposed as a named SDK helper so the CLI no longer needs the
 *  raw-row type that was duplicating RawTaskRow
 *  (review_code_raw_task_state_duplicate). */
export function listRecentClosed(db: Db, workstream: string, limit = 5): TaskRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM tasks WHERE workstream = ? AND status = 'CLOSED' ORDER BY updated_at DESC LIMIT ?",
    )
    .all(workstream, limit) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listNotes(db: Db, taskId: string): TaskNoteRow[] {
  const rows = db
    .prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY id")
    .all(taskId) as RawTaskNoteRow[];
  return rows.map(noteFromDb);
}

/**
 * All tasks currently owned by `agent`, across every workstream
 * (agent names are PRIMARY KEY — globally unique — so this is
 * unambiguous). Sorted by workstream, then local_id.
 *
 * Defaults to **excluding CLOSED** since the verb's purpose is "what
 * is X currently working on?" and a closed task is no longer being
 * worked on. closeTask intentionally preserves `owner` as a
 * historical record (so audit/notes can attribute decisions); pass
 * `{ includeClosed: true }` to surface that history.
 *
 * Real bug found in real use: `mu task owned-by worker-1` was
 * returning CLOSED tasks alongside live ones, making it impossible
 * to tell at a glance what the agent was actually doing.
 */
export function listTasksByOwner(
  db: Db,
  owner: string,
  opts: { includeClosed?: boolean } = {},
): TaskRow[] {
  // 'Live work' = not in any terminal-or-parked state. CLOSED is the
  // obvious one; REJECTED and DEFERRED are also off the agent's plate
  // (the user has decided 'won't do' or 'not now'). includeClosed
  // re-includes ALL of those so historical attribution is recoverable.
  const sql = opts.includeClosed
    ? "SELECT * FROM tasks WHERE owner = ? ORDER BY workstream, local_id"
    : "SELECT * FROM tasks WHERE owner = ? AND status NOT IN ('CLOSED', 'REJECTED', 'DEFERRED') ORDER BY workstream, local_id";
  const rows = db.prepare(sql).all(owner) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export interface SearchTasksOptions {
  /** Restrict to one workstream; undefined = search across all. */
  workstream?: string;
  /** Also search `task_notes.content` (default false: titles + ids only). */
  includeNotes?: boolean;
}

/**
 * Substring search on task `title` and `local_id`, case-insensitive.
 * With `includeNotes: true` also searches `task_notes.content`. The
 * pattern is wrapped in `%...%` automatically so callers don't need
 * SQL LIKE knowledge — for explicit globs (or regex), use `mu sql`.
 */
export function searchTasks(db: Db, pattern: string, opts: SearchTasksOptions = {}): TaskRow[] {
  const like = `%${pattern.toLowerCase()}%`;
  const wsClause = opts.workstream === undefined ? "" : "t.workstream = ? AND";
  const wsParams = opts.workstream === undefined ? [] : [opts.workstream];
  const orderBy =
    opts.workstream === undefined ? "ORDER BY t.workstream, t.local_id" : "ORDER BY t.local_id";

  if (opts.includeNotes) {
    const sql = `SELECT DISTINCT t.* FROM tasks t
                 LEFT JOIN task_notes n ON n.task_id = t.local_id
                 WHERE ${wsClause} (
                   LOWER(t.title) LIKE ?
                   OR LOWER(t.local_id) LIKE ?
                   OR LOWER(n.content) LIKE ?
                 )
                 ${orderBy}`;
    return (db.prepare(sql).all(...wsParams, like, like, like) as RawTaskRow[]).map(rowFromDb);
  }

  const sql = `SELECT t.* FROM tasks t
               WHERE ${wsClause} (LOWER(t.title) LIKE ? OR LOWER(t.local_id) LIKE ?)
               ${orderBy}`;
  return (db.prepare(sql).all(...wsParams, like, like) as RawTaskRow[]).map(rowFromDb);
}

export interface TaskEdges {
  /** Tasks that must close before this one can start (blockers). */
  blockers: string[];
  /** Tasks that this one blocks (dependents). */
  dependents: string[];
}

/**
 * Direct (one-hop) edges for a task. For transitive prerequisites, use
 * `getPrerequisites()`; this helper is the immediate-neighbour view used
 * by `mu task show`.
 */
export function getTaskEdges(db: Db, taskId: string): TaskEdges {
  const blockers = (
    db
      .prepare("SELECT from_task FROM task_edges WHERE to_task = ? ORDER BY from_task")
      .all(taskId) as { from_task: string }[]
  ).map((r) => r.from_task);
  const dependents = (
    db
      .prepare("SELECT to_task FROM task_edges WHERE from_task = ? ORDER BY to_task")
      .all(taskId) as { to_task: string }[]
  ).map((r) => r.to_task);
  return { blockers, dependents };
}

/**
 * All tasks transitively reachable from `taskId` via reverse-edge
 * traversal (i.e. the set of tasks that block this one), including the
 * task itself.
 */
export function getPrerequisites(db: Db, taskId: string): Set<string> {
  const rows = db
    .prepare(
      `WITH RECURSIVE reach(node) AS (
         SELECT ?
         UNION
         SELECT from_task FROM task_edges, reach WHERE to_task = reach.node
       )
       SELECT node FROM reach`,
    )
    .all(taskId) as { node: string }[];
  return new Set(rows.map((r) => r.node));
}

// ─── Internal: cycle check ─────────────────────────────────────────────

/**
 * Adding edge `from -> to` creates a cycle iff there's already a path
 * `to -> ... -> from`. SQL recursive CTE expresses this exactly.
 */
function wouldCreateCycle(db: Db, from: string, to: string): boolean {
  if (from === to) return true;
  const result = db
    .prepare(
      `WITH RECURSIVE forward(node) AS (
         SELECT ?
         UNION
         SELECT to_task FROM task_edges, forward WHERE from_task = forward.node
       )
       SELECT 1 AS hit FROM forward WHERE node = ? LIMIT 1`,
    )
    .get(to, from) as { hit: number } | undefined;
  return result !== undefined;
}

// ─── addTask (verb) ────────────────────────────────────────────────────

export interface AddTaskOptions {
  localId: string;
  workstream: string;
  title: string;
  /** 1..100; enforced by schema CHECK. */
  impact: number;
  /** > 0; enforced by schema CHECK. */
  effortDays: number;
  /**
   * Tasks that block this one. Edges inserted as `blocker -> newTask`.
   * Each blocker must already exist AND share this task's workstream
   * (cross-workstream edges are forbidden); cycle check guards each
   * edge. The CLI surfaces this as `--blocked-by`; the SDK key matches.
   */
  blockedBy?: string[];
}

/**
 * Atomically create a task and (optionally) its incoming blocked-by
 * edges.
 *
 * The task insert + every edge insert + cycle check happen inside one
 * SQLite transaction. If any blocker is missing or any edge would
 * create a cycle, the entire add rolls back.
 *
 * Cycle check for `addTask` is structurally trivial (a fresh task has
 * no outgoing edges, so `to -> ... -> from` is impossible). It's still
 * called here so the same primitive is exercised by tests.
 */
export function addTask(db: Db, opts: AddTaskOptions): TaskRow {
  if (opts.localId.startsWith("mu_")) {
    throw new TaskIdInvalidError(opts.localId, "reserved-prefix");
  }
  if (!isValidTaskId(opts.localId)) {
    throw new TaskIdInvalidError(opts.localId, "syntax");
  }
  if (getTask(db, opts.localId) !== undefined) {
    throw new TaskExistsError(opts.localId);
  }

  return db.transaction(() => {
    // Auto-create the workstream row so tasks.workstream FK is satisfied
    // (preserves the spawn-without-init ergonomics; see ensureWorkstream's docstring).
    ensureWorkstream(db, opts.workstream);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (local_id, workstream, title, status, impact, effort_days, created_at, updated_at)
       VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
    ).run(opts.localId, opts.workstream, opts.title, opts.impact, opts.effortDays, now, now);

    if (opts.blockedBy && opts.blockedBy.length > 0) {
      const blockerLookup = db.prepare("SELECT workstream FROM tasks WHERE local_id = ?");
      const insertEdge = db.prepare(
        "INSERT INTO task_edges (from_task, to_task, created_at) VALUES (?, ?, ?)",
      );
      for (const blocker of opts.blockedBy) {
        const row = blockerLookup.get(blocker) as { workstream: string } | undefined;
        if (!row) {
          throw new TaskNotFoundError(blocker);
        }
        if (row.workstream !== opts.workstream) {
          throw new CrossWorkstreamEdgeError(
            blocker,
            row.workstream,
            opts.localId,
            opts.workstream,
          );
        }
        if (wouldCreateCycle(db, blocker, opts.localId)) {
          throw new CycleError(blocker, opts.localId);
        }
        insertEdge.run(blocker, opts.localId, now);
      }
    }

    const row = getTask(db, opts.localId);
    if (!row) throw new Error(`addTask: row missing after insert: ${opts.localId}`);
    const blockedBy =
      opts.blockedBy && opts.blockedBy.length > 0 ? `, blocked-by=${opts.blockedBy.join(",")}` : "";
    emitEvent(
      db,
      opts.workstream,
      `task add ${opts.localId} (impact=${opts.impact}, effort=${opts.effortDays}${blockedBy})`,
    );
    return row;
  })();
}

// ─── addNote (verb) ────────────────────────────────────────────────────

export interface AddNoteOptions {
  /** Free-form author label. Convention: agent name, "user", or "orchestrator". */
  author?: string;
}

export function addNote(
  db: Db,
  taskId: string,
  content: string,
  opts: AddNoteOptions = {},
): TaskNoteRow {
  const task = getTask(db, taskId);
  if (!task) {
    throw new TaskNotFoundError(taskId);
  }
  const now = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)")
    .run(taskId, opts.author ?? null, content, now);
  const noteId = Number(result.lastInsertRowid);
  emitEvent(
    db,
    task.workstream,
    `task note ${taskId} (note #${noteId} by ${opts.author ?? "orchestrator"})`,
    opts.author ?? "system",
  );
  return {
    id: noteId,
    taskId,
    author: opts.author ?? null,
    content,
    createdAt: now,
  };
}

// ─── addBlockEdge / removeBlockEdge ────────────────────────────────────────

export interface BlockEdgeResult {
  /** True iff a row was actually inserted (vs. already present). */
  added: boolean;
}

/**
 * Add the edge `blocker → blocked` ('blocker blocks blocked').
 * Idempotent (existing edge → `added: false`). Validates:
 *
 *   - both tasks exist
 *   - same workstream (cross-workstream edges forbidden)
 *   - no cycle (the new edge wouldn't form a path blocked → ... → blocker)
 *   - blocker ≠ blocked (no self-reference)
 */
export function addBlockEdge(db: Db, blocked: string, blocker: string): BlockEdgeResult {
  if (blocked === blocker) {
    // Surface as a typed CycleError so the CLI maps it to exit 4 (conflict)
    // rather than letting the schema CHECK fire as a generic SQL error.
    throw new CycleError(blocker, blocked);
  }
  const blockedRow = getTask(db, blocked);
  if (!blockedRow) throw new TaskNotFoundError(blocked);
  const blockerRow = getTask(db, blocker);
  if (!blockerRow) throw new TaskNotFoundError(blocker);
  if (blockedRow.workstream !== blockerRow.workstream) {
    throw new CrossWorkstreamEdgeError(
      blocker,
      blockerRow.workstream,
      blocked,
      blockedRow.workstream,
    );
  }
  if (wouldCreateCycle(db, blocker, blocked)) {
    throw new CycleError(blocker, blocked);
  }
  const result = db
    .prepare("INSERT OR IGNORE INTO task_edges (from_task, to_task, created_at) VALUES (?, ?, ?)")
    .run(blocker, blocked, new Date().toISOString());
  const added = result.changes > 0;
  if (added) emitEvent(db, blockedRow.workstream, `task block ${blocked} by ${blocker}`);
  return { added };
}

export interface RemoveBlockEdgeResult {
  /** True iff a row was actually deleted (vs. no such edge). */
  removed: boolean;
}

/**
 * Remove the edge `blocker → blocked`. Idempotent (no edge →
 * `removed: false`). Does NOT validate task existence — if the
 * edge is gone there's nothing to do, regardless of whether the
 * tasks are gone too.
 */
export function removeBlockEdge(db: Db, blocked: string, blocker: string): RemoveBlockEdgeResult {
  const result = db
    .prepare("DELETE FROM task_edges WHERE from_task = ? AND to_task = ?")
    .run(blocker, blocked);
  const removed = result.changes > 0;
  if (removed) {
    // Use the blocked task's workstream as the channel (both tasks must
    // be in the same workstream by the addBlockEdge invariant).
    const blockedRow = getTask(db, blocked);
    const ws = blockedRow?.workstream ?? null;
    emitEvent(db, ws, `task unblock ${blocked} by ${blocker}`);
  }
  return { removed };
}

// ─── deleteTask ───────────────────────────────────────────────────────────

export interface DeleteTaskResult {
  /** True iff the row existed and was deleted. */
  deleted: boolean;
  /** Number of `task_edges` rows cascaded out (informational). */
  deletedEdges: number;
  /** Number of `task_notes` rows cascaded out (informational). */
  deletedNotes: number;
}

/**
 * Delete a task. FK CASCADE on `task_edges` (from + to) and
 * `task_notes` cleans the joined rows automatically. Idempotent on
 * a missing task (returns `deleted: false`).
 *
 * Pre-counts the cascade victims for reporting because SQLite's
 * `changes()` only reports rows directly affected by the DELETE.
 */
export function deleteTask(db: Db, localId: string): DeleteTaskResult {
  const before = getTask(db, localId);
  // Pre-mutation snapshot. delete cascades into task_edges and
  // task_notes; no per-row history can reconstruct it. Skip when the
  // row doesn't exist (the verb is idempotent on missing).
  if (before) {
    captureSnapshot(db, `task delete ${localId}`, before.workstream);
  }
  const edgesBefore = (
    db
      .prepare("SELECT COUNT(*) AS n FROM task_edges WHERE from_task = ? OR to_task = ?")
      .get(localId, localId) as { n: number }
  ).n;
  const notesBefore = (
    db.prepare("SELECT COUNT(*) AS n FROM task_notes WHERE task_id = ?").get(localId) as {
      n: number;
    }
  ).n;
  const result = db.prepare("DELETE FROM tasks WHERE local_id = ?").run(localId);
  const deleted = result.changes > 0;
  if (deleted && before) {
    emitEvent(
      db,
      before.workstream,
      `task delete ${localId} (cascade: ${edgesBefore} edges, ${notesBefore} notes)`,
    );
  }
  return { deleted, deletedEdges: edgesBefore, deletedNotes: notesBefore };
}

// ─── updateTask ───────────────────────────────────────────────────────────

export interface UpdateTaskOptions {
  title?: string;
  /** 1..100; enforced by schema CHECK. */
  impact?: number;
  /** > 0; enforced by schema CHECK. */
  effortDays?: number;
}

export interface UpdateTaskResult {
  /** True iff at least one field actually changed. */
  updated: boolean;
  /** The fields whose values differ post-update (in `UpdateTaskOptions`'s
   *  camelCase shape). Empty when `updated: false`. */
  changedFields: string[];
}

/**
 * Update scalar fields on a task. Each option is independently optional;
 * passing none is a typed no-op (returns `updated: false, changedFields: []`).
 * Fields whose new value equals the current value are skipped (no row change).
 *
 * NOT for status (use `closeTask` / `openTask` / `setTaskStatus`), owner
 * (use `claimTask` / `releaseTask`), local_id (rename is deferred), or
 * workstream (cross-workstream moves are deferred).
 */
export function updateTask(db: Db, localId: string, opts: UpdateTaskOptions): UpdateTaskResult {
  const before = getTask(db, localId);
  if (!before) throw new TaskNotFoundError(localId);

  const setters: string[] = [];
  const params: unknown[] = [];
  const changedFields: string[] = [];

  if (opts.title !== undefined && opts.title !== before.title) {
    setters.push("title = ?");
    params.push(opts.title);
    changedFields.push("title");
  }
  if (opts.impact !== undefined && opts.impact !== before.impact) {
    setters.push("impact = ?");
    params.push(opts.impact);
    changedFields.push("impact");
  }
  if (opts.effortDays !== undefined && opts.effortDays !== before.effortDays) {
    setters.push("effort_days = ?");
    params.push(opts.effortDays);
    changedFields.push("effortDays");
  }

  if (setters.length === 0) {
    return { updated: false, changedFields: [] };
  }

  setters.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(localId);

  db.prepare(`UPDATE tasks SET ${setters.join(", ")} WHERE local_id = ?`).run(...params);
  emitEvent(db, before.workstream, `task update ${localId} (changed: ${changedFields.join(", ")})`);
  return { updated: true, changedFields };
}

// ─── reparentTask ─────────────────────────────────────────────────────────

export interface ReparentTaskResult {
  /** Edges removed (i.e. all incoming `to_task = taskId` edges). */
  removedEdges: number;
  /** Edges added (== blockers.length on success). */
  addedEdges: number;
}

/**
 * Atomically replace every incoming edge of `taskId` with new ones
 * `blocker[i] → taskId`. Pass an empty `blockers` array to clear all
 * incoming edges (the task becomes ready iff its status allows).
 *
 * Validates ALL new blockers up-front (existence + same workstream +
 * cycle check); if any fails, no DELETE happens — the call is fully
 * atomic via a single transaction.
 *
 * Cycle reasoning: removing the existing incoming edges to `taskId`
 * doesn't change `taskId`'s OUTGOING reachability, so
 * `wouldCreateCycle(db, blocker, taskId)` evaluated against the
 * pre-state gives the right answer for each new edge.
 */
export function reparentTask(
  db: Db,
  taskId: string,
  blockers: readonly string[],
): ReparentTaskResult {
  const task = getTask(db, taskId);
  if (!task) throw new TaskNotFoundError(taskId);

  for (const blockerId of blockers) {
    if (blockerId === taskId) {
      throw new CycleError(blockerId, taskId);
    }
    const blocker = getTask(db, blockerId);
    if (!blocker) throw new TaskNotFoundError(blockerId);
    if (blocker.workstream !== task.workstream) {
      throw new CrossWorkstreamEdgeError(blockerId, blocker.workstream, taskId, task.workstream);
    }
    if (wouldCreateCycle(db, blockerId, taskId)) {
      throw new CycleError(blockerId, taskId);
    }
  }

  return db.transaction(() => {
    const removed = db.prepare("DELETE FROM task_edges WHERE to_task = ?").run(taskId);
    const insertEdge = db.prepare(
      "INSERT INTO task_edges (from_task, to_task, created_at) VALUES (?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const blockerId of blockers) {
      insertEdge.run(blockerId, taskId, now);
    }
    const blockersBit = blockers.length > 0 ? `, new=${[...blockers].join(",")}` : "";
    emitEvent(
      db,
      task.workstream,
      `task reparent ${taskId} (removed ${removed.changes} edges, added ${blockers.length}${blockersBit})`,
    );
    return { removedEdges: removed.changes, addedEdges: blockers.length };
  })();
}
