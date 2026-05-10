// mu — task graph: CRUD primitives, verbs (addTask, addNote, claimTask),
// view reads (ready / blocked / goals), and DAG traversal helpers.
//
// The schema (db.ts) does the heavy lifting: PRIMARY KEYs, CHECK
// constraints on impact/effort/status, FK cascades on edges and notes.
// This module adds:
//   - the cycle check on edge insertion (SQL CHECK can't express it)
//   - the claim protocol (atomic CAS on tasks.owner via single UPDATE)
//   - row-shape mapping (snake_case columns → camelCase TS)

import { type Db, resolveWorkstreamId, tryResolveWorkstreamId } from "./db.js";
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
  ReaperDetectedDuringWaitError,
  StallDetectedDuringWaitError,
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
  setWaitStuckWarnForTests,
  type TaskWaitOptions,
  type TaskWaitRef,
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
  /** Per-workstream-unique TEXT name. The operator-facing identifier. */
  name: string;
  /** Alias for `name` — the per-workstream-unique TEXT id. Emitted alongside
   *  `name` so JSON consumers can dot-access the canonical field name without
   *  having to know that, for tasks specifically, `name` plays the localId
   *  role. Always equal to `name`. */
  localId: string;
  /** Foreign-name reference to the owning workstream. */
  workstreamName: string;
  title: string;
  status: TaskStatus;
  impact: number;
  effortDays: number;
  /** Foreign-name reference to the owning agent (NULL when unowned). */
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskNoteRow {
  author: string | null;
  content: string;
  createdAt: string;
}

interface RawTaskRow {
  /** Surrogate id (v5). */
  id: number;
  local_id: string;
  /** Joined from workstreams.name. */
  workstream: string;
  title: string;
  status: string;
  impact: number;
  effort_days: number;
  /** Joined from agents.name via owner_id. NULL when unowned. */
  owner: string | null;
  created_at: string;
  updated_at: string;
}

interface RawTaskNoteRow {
  author: string | null;
  content: string;
  created_at: string;
}

// SELECT clause for v5 task reads. Joins workstreams + agents to expose
// the operator-facing names as `workstream` and `owner`. Used by every
// read path so callers don't see surrogate ids.
const SELECT_TASK_COLS = `
  t.id AS id,
  t.local_id AS local_id,
  ws.name AS workstream,
  t.title AS title,
  t.status AS status,
  t.impact AS impact,
  t.effort_days AS effort_days,
  ag.name AS owner,
  t.created_at AS created_at,
  t.updated_at AS updated_at
`;

const TASK_FROM_JOIN = `
  FROM tasks t
  JOIN workstreams ws ON ws.id = t.workstream_id
  LEFT JOIN agents ag ON ag.id = t.owner_id
`;

const SELECT_NOTE_COLS = `
  n.author AS author,
  n.content AS content,
  n.created_at AS created_at
`;

function rowFromDb(row: RawTaskRow): TaskRow {
  return {
    name: row.local_id,
    localId: row.local_id,
    workstreamName: row.workstream,
    title: row.title,
    status: row.status as TaskStatus,
    impact: row.impact,
    effortDays: row.effort_days,
    ownerName: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function noteFromDb(row: RawTaskNoteRow): TaskNoteRow {
  return {
    author: row.author,
    content: row.content,
    createdAt: row.created_at,
  };
}

/** Look up a task by local_id across every workstream. Returns the
 *  first match (sorted by workstream name for determinism). Used by
 *  edge verbs (addBlockEdge / reparentTask) to resolve a blocker so a
 *  cross-workstream blocker can surface `CrossWorkstreamEdgeError`
 *  rather than the less-actionable `TaskNotFoundError`. NOT for
 *  operator-facing reads — use `getTask(db, localId, workstream)`
 *  for those. */
function lookupTaskAnyWorkstream(db: Db, localId: string): TaskRow | undefined {
  const row = db
    .prepare(
      `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE t.local_id = ? ORDER BY ws.name LIMIT 1`,
    )
    .get(localId) as RawTaskRow | undefined;
  return row ? rowFromDb(row) : undefined;
}

/** Resolve a (workstream, localId) pair to the surrogate task id.
 *  Returns null on miss. */
function taskIdFor(db: Db, localId: string, workstream: string): number | null {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return null;
  const row = db
    .prepare("SELECT id FROM tasks WHERE workstream_id = ? AND local_id = ?")
    .get(wsId, localId) as { id: number } | undefined;
  return row ? row.id : null;
}

/**
 * Bump `tasks.updated_at` on a surrogate task id. Used by every write
 * that mutates a child row (notes, edges) without touching the task
 * row itself, so `mu task list --sort recency` reflects 'last write of
 * any kind' rather than only 'last status/field change'
 * (task_updatedat_not_bumped_by_reparent). Status changes, field
 * updates, and claim/release already update `updated_at` directly in
 * their own UPDATE statements; don't double-bump from here.
 *
 * Always called inside the same transaction as the child-row mutation
 * so the bump rolls back together with the mutation on error.
 */
export function touchTask(db: Db, taskId: number, now?: string): void {
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(
    now ?? new Date().toISOString(),
    taskId,
  );
}

// ─── ID validation ─────────────────────────────────────────────────────

/** Lowercase alpha first, then alnum / underscore / hyphen, ≤64 chars. */
const TASK_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_RE.test(id);
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
 * 64 keeps ids comfortable in tables, JSON, and tmux pane titles.
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
  // First char must be a letter → prefix `t_` if it isn't. v5 has no
  // global namespace and no reserved prefix; `mu_foo` is a perfectly
  // valid local_id (per-workstream unique).
  return /^[a-z]/.test(trimmed)
    ? trimmed.slice(0, SLUG_HARD_CAP)
    : `t_${trimmed}`.slice(0, SLUG_HARD_CAP);
}

/**
 * Generate a unique task id from a title. v5: tasks.local_id is
 * per-workstream unique, so the collision check scopes to one
 * workstream. On collision, appends `_2`, `_3`, … until unique.
 */
export function idFromTitle(db: Db, workstream: string, title: string): string {
  const base = slugifyTitle(title);
  if (getTask(db, base, workstream) === undefined) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`.slice(0, SLUG_HARD_CAP);
    if (getTask(db, candidate, workstream) === undefined) return candidate;
  }
  throw new Error(`could not derive a unique id from title in workstream ${workstream}: ${title}`);
}

/**
 * Sanitise a free-form string into a candidate task id.
 *
 * Lowercases, replaces every non-`[a-z0-9_-]` char with `_`, trims any
 * leading non-letter (the schema requires the first char to be a
 * letter), truncates to 64 chars. Returns `"task"` when the input has
 * no usable letters at all so the suggestion in
 * `TaskIdInvalidError.errorNextSteps()` is always a runnable command.
 *
 * Mirrors `slugifyTitle`'s prefix corrections so suggested ids will
 * pass `isValidTaskId` if the user runs them verbatim. Lives next to
 * `slugifyTitle` rather than in `tasks/errors.ts` because it's a slug
 * helper, not an error helper — the only caller happens to be
 * `TaskIdInvalidError.errorNextSteps()`.
 */
export function sanitiseTaskId(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, SLUG_HARD_CAP);
  return s.length === 0 ? "task" : s;
}

// ─── Read primitives ───────────────────────────────────────────────────

export function getTask(db: Db, localId: string, workstream: string): TaskRow | undefined {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return undefined;
  const row = db
    .prepare(
      `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE t.workstream_id = ? AND t.local_id = ?`,
    )
    .get(wsId, localId) as RawTaskRow | undefined;
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
    const wsId = tryResolveWorkstreamId(db, workstream);
    if (wsId === null) return [];
    where.push("t.workstream_id = ?");
    params.push(wsId);
  }
  if (statuses !== undefined) {
    where.push(`t.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  const sql =
    where.length === 0
      ? `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} ORDER BY t.local_id`
      : `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE ${where.join(" AND ")} ORDER BY t.local_id`;
  const rows = db.prepare(sql).all(...params) as RawTaskRow[];
  return rows.map(rowFromDb);
}

// The three views (ready, blocked, goals) project tasks.* directly,
// so they expose v5 columns (id, workstream_id, owner_id). We wrap
// them with the same JOINs as TASK_FROM_JOIN to translate back to the
// operator-facing TaskRow shape (workstream + owner as TEXT names).
const VIEW_FROM_JOIN = (view: string) => `
  FROM ${view} v
  JOIN workstreams ws ON ws.id = v.workstream_id
  LEFT JOIN agents ag ON ag.id = v.owner_id
`;
const SELECT_VIEW_COLS = `
  v.id AS id,
  v.local_id AS local_id,
  ws.name AS workstream,
  v.title AS title,
  v.status AS status,
  v.impact AS impact,
  v.effort_days AS effort_days,
  ag.name AS owner,
  v.created_at AS created_at,
  v.updated_at AS updated_at
`;

/** Options for listReady. The optional `statuses` filter composes
 *  on top of the `ready` view (which itself constrains to
 *  `status='OPEN'`); passing only OPEN is identical to today's no-
 *  filter shape, passing only non-OPEN values returns []. Exists so
 *  `mu task next --status` can mirror the multi-status flag shape
 *  shipped on `mu task list` (task_list_multi_status_union). */
export interface ListReadyOptions {
  status?: TaskStatus | readonly TaskStatus[];
}

export function listReady(db: Db, workstream: string, opts: ListReadyOptions = {}): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const statuses =
    opts.status === undefined
      ? undefined
      : Array.isArray(opts.status)
        ? (opts.status as TaskStatus[])
        : [opts.status as TaskStatus];
  const where: string[] = ["v.workstream_id = ?"];
  const params: unknown[] = [wsId];
  if (statuses !== undefined && statuses.length > 0) {
    where.push(`v.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  const rows = db
    .prepare(
      `SELECT ${SELECT_VIEW_COLS} ${VIEW_FROM_JOIN("ready")} WHERE ${where.join(" AND ")} ORDER BY v.local_id`,
    )
    .all(...params) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listBlocked(db: Db, workstream: string): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_VIEW_COLS} ${VIEW_FROM_JOIN("blocked")} WHERE v.workstream_id = ? ORDER BY v.local_id`,
    )
    .all(wsId) as RawTaskRow[];
  return rows.map(rowFromDb);
}

export function listGoals(db: Db, workstream: string): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_VIEW_COLS} ${VIEW_FROM_JOIN("goals")} WHERE v.workstream_id = ? ORDER BY v.local_id`,
    )
    .all(wsId) as RawTaskRow[];
  return rows.map(rowFromDb);
}

/** All IN_PROGRESS tasks in a workstream, most-recently-touched first.
 *  Used by `mu state` and `mu hud` to populate their in-progress slice;
 *  exposed as a named SDK helper so those CLI verbs don't re-derive
 *  the row-shape conversion (review_code_raw_task_state_duplicate). */
export function listInProgress(db: Db, workstream: string): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE t.workstream_id = ? AND t.status = 'IN_PROGRESS' ORDER BY t.updated_at DESC`,
    )
    .all(wsId) as RawTaskRow[];
  return rows.map(rowFromDb);
}

/** Most-recently-closed tasks in a workstream, newest first, capped at
 *  `limit` (default 5). Used by `mu state` for its 'recent closed'
 *  slice; exposed as a named SDK helper so the CLI no longer needs the
 *  raw-row type that was duplicating RawTaskRow
 *  (review_code_raw_task_state_duplicate). */
export function listRecentClosed(db: Db, workstream: string, limit = 5): TaskRow[] {
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE t.workstream_id = ? AND t.status = 'CLOSED' ORDER BY t.updated_at DESC LIMIT ?`,
    )
    .all(wsId, limit) as RawTaskRow[];
  return rows.map(rowFromDb);
}

/** List notes for a task. Operator-facing local_id; resolves to the
 *  surrogate task id via taskIdFor (with optional workstream scope). */
export function listNotes(db: Db, taskLocalId: string, workstream: string): TaskNoteRow[] {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return [];
  const rows = db
    .prepare(
      `SELECT ${SELECT_NOTE_COLS} FROM task_notes n JOIN tasks t ON t.id = n.task_id
        WHERE n.task_id = ? ORDER BY n.id`,
    )
    .all(taskId) as RawTaskNoteRow[];
  return rows.map(noteFromDb);
}

/**
 * All tasks currently owned by `agent` in a given workstream
 * (v5: agents.name is per-workstream unique). Sorted by local_id.
 *
 * Defaults to **excluding CLOSED** since the verb's purpose is "what
 * is X currently working on?" and a closed task is no longer being
 * worked on. closeTask intentionally preserves `owner` as a
 * historical record (so audit/notes can attribute decisions); pass
 * `{ includeClosed: true }` to surface that history.
 */
export function listTasksByOwner(
  db: Db,
  workstream: string,
  owner: string,
  opts: { includeClosed?: boolean } = {},
): TaskRow[] {
  // 'Live work' = not in any terminal-or-parked state. CLOSED is the
  // obvious one; REJECTED and DEFERRED are also off the agent's plate
  // (the user has decided 'won't do' or 'not now'). includeClosed
  // re-includes ALL of those so historical attribution is recoverable.
  // Filter on the joined ag.name so the operator-facing owner string
  // still drives the lookup; FK is now via owner_id.
  const filter = opts.includeClosed ? "" : "AND t.status NOT IN ('CLOSED', 'REJECTED', 'DEFERRED')";
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const sql = `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN}
               WHERE ag.name = ? AND t.workstream_id = ? ${filter}
               ORDER BY t.local_id`;
  return (db.prepare(sql).all(owner, wsId) as RawTaskRow[]).map(rowFromDb);
}

/**
 * Cross-workstream variant of `listTasksByOwner`. Returns tasks owned
 * by ANY agent of the given name across every workstream. Used by
 * `mu task owned-by --all` for the genuine cross-workstream view
 * (audit / dashboards). The bare name is the join key, so two
 * distinct same-named agents in different workstreams contribute
 * their tasks to the same result list.
 */
export function listTasksByOwnerCrossWorkstream(
  db: Db,
  owner: string,
  opts: { includeClosed?: boolean } = {},
): TaskRow[] {
  const filter = opts.includeClosed ? "" : "AND t.status NOT IN ('CLOSED', 'REJECTED', 'DEFERRED')";
  const sql = `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN}
               WHERE ag.name = ? ${filter}
               ORDER BY ws.name, t.local_id`;
  return (db.prepare(sql).all(owner) as RawTaskRow[]).map(rowFromDb);
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
  const wsClause = opts.workstream === undefined ? "" : "ws.name = ? AND";
  const wsParams = opts.workstream === undefined ? [] : [opts.workstream];
  const orderBy =
    opts.workstream === undefined ? "ORDER BY ws.name, t.local_id" : "ORDER BY t.local_id";

  if (opts.includeNotes) {
    const sql = `SELECT DISTINCT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN}
                 LEFT JOIN task_notes n ON n.task_id = t.id
                 WHERE ${wsClause} (
                   LOWER(t.title) LIKE ?
                   OR LOWER(t.local_id) LIKE ?
                   OR LOWER(n.content) LIKE ?
                 )
                 ${orderBy}`;
    return (db.prepare(sql).all(...wsParams, like, like, like) as RawTaskRow[]).map(rowFromDb);
  }

  const sql = `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN}
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
export function getTaskEdges(db: Db, taskLocalId: string, workstream: string): TaskEdges {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return { blockers: [], dependents: [] };
  const blockers = (
    db
      .prepare(
        `SELECT t.local_id AS id FROM task_edges e
           JOIN tasks t ON t.id = e.from_task_id
          WHERE e.to_task_id = ? ORDER BY t.local_id`,
      )
      .all(taskId) as { id: string }[]
  ).map((r) => r.id);
  const dependents = (
    db
      .prepare(
        `SELECT t.local_id AS id FROM task_edges e
           JOIN tasks t ON t.id = e.to_task_id
          WHERE e.from_task_id = ? ORDER BY t.local_id`,
      )
      .all(taskId) as { id: string }[]
  ).map((r) => r.id);
  return { blockers, dependents };
}

/**
 * All tasks transitively reachable from `taskId` via reverse-edge
 * traversal (i.e. the set of tasks that block this one), including the
 * task itself.
 */
export function getPrerequisites(db: Db, taskLocalId: string, workstream: string): Set<string> {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return new Set([taskLocalId]);
  // Walk reverse edges in surrogate-id space, then translate back to
  // local_id strings. The seed must be the surrogate id; the result
  // includes the seed task itself (callers like the tracks union-find
  // rely on the inclusive set).
  const rows = db
    .prepare(
      `WITH RECURSIVE reach(node) AS (
         SELECT ?
         UNION
         SELECT from_task_id FROM task_edges, reach WHERE to_task_id = reach.node
       )
       SELECT t.local_id AS local_id FROM reach r JOIN tasks t ON t.id = r.node`,
    )
    .all(taskId) as { local_id: string }[];
  return new Set(rows.map((r) => r.local_id));
}

// ─── Internal: cycle check ─────────────────────────────────────────────

/**
 * Adding edge `from -> to` creates a cycle iff there's already a path
 * `to -> ... -> from`. SQL recursive CTE expresses this exactly.
 */
function wouldCreateCycle(db: Db, fromId: number, toId: number): boolean {
  if (fromId === toId) return true;
  const result = db
    .prepare(
      `WITH RECURSIVE forward(node) AS (
         SELECT ?
         UNION
         SELECT to_task_id FROM task_edges, forward WHERE from_task_id = forward.node
       )
       SELECT 1 AS hit FROM forward WHERE node = ? LIMIT 1`,
    )
    .get(toId, fromId) as { hit: number } | undefined;
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
  if (!isValidTaskId(opts.localId)) {
    throw new TaskIdInvalidError(opts.localId);
  }

  return db.transaction(() => {
    // Auto-create the workstream row so tasks.workstream_id FK is
    // satisfied (preserves spawn-without-init ergonomics).
    ensureWorkstream(db, opts.workstream);
    const wsId = resolveWorkstreamId(db, opts.workstream);

    // Per-workstream uniqueness: a duplicate local_id within the same
    // workstream throws TaskExistsError. Different workstreams may
    // legitimately share local_ids in v5.
    const existing = db
      .prepare("SELECT id FROM tasks WHERE workstream_id = ? AND local_id = ?")
      .get(wsId, opts.localId) as { id: number } | undefined;
    if (existing) {
      throw new TaskExistsError(opts.localId);
    }

    const now = new Date().toISOString();
    const insertResult = db
      .prepare(
        `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days, created_at, updated_at)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      )
      .run(wsId, opts.localId, opts.title, opts.impact, opts.effortDays, now, now);
    const newTaskId = Number(insertResult.lastInsertRowid);

    if (opts.blockedBy && opts.blockedBy.length > 0) {
      // Prefer the same-workstream blocker first (v5 per-workstream
      // local_id), then fall back to a global lookup so a cross-ws
      // blocker still surfaces CrossWorkstreamEdgeError (not
      // TaskNotFoundError). Without the same-ws preference, two
      // blockers of the same local_id (one in this ws, one elsewhere)
      // could silently bind to the wrong row
      // (bug_v5_name_clash_silent_misroute).
      const blockerLookupSameWs = db.prepare(
        `SELECT t.id AS id, ws.name AS workstream FROM tasks t
           JOIN workstreams ws ON ws.id = t.workstream_id
          WHERE t.local_id = ? AND t.workstream_id = ?`,
      );
      const blockerLookupAnyWs = db.prepare(
        `SELECT t.id AS id, ws.name AS workstream FROM tasks t
           JOIN workstreams ws ON ws.id = t.workstream_id
          WHERE t.local_id = ? LIMIT 1`,
      );
      const insertEdge = db.prepare(
        "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
      );
      for (const blocker of opts.blockedBy) {
        const row = (blockerLookupSameWs.get(blocker, wsId) ?? blockerLookupAnyWs.get(blocker)) as
          | { id: number; workstream: string }
          | undefined;
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
        if (wouldCreateCycle(db, row.id, newTaskId)) {
          throw new CycleError(blocker, opts.localId);
        }
        insertEdge.run(row.id, newTaskId, now);
      }
    }

    const row = getTask(db, opts.localId, opts.workstream);
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
  /** Workstream context (operator-facing name). v5: tasks.local_id is
   *  per-workstream unique, so this is required to disambiguate. */
  workstream: string;
}

export function addNote(
  db: Db,
  taskLocalId: string,
  content: string,
  opts: AddNoteOptions,
): TaskNoteRow {
  const task = getTask(db, taskLocalId, opts.workstream);
  if (!task) {
    throw new TaskNotFoundError(taskLocalId);
  }
  const taskId = taskIdFor(db, task.name, task.workstreamName);
  if (taskId === null) throw new TaskNotFoundError(taskLocalId);
  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const r = db
      .prepare("INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, opts.author ?? null, content, now);
    // Bump the parent task so `mu task list --sort recency` surfaces
    // freshly-noted tasks (task_updatedat_not_bumped_by_reparent).
    touchTask(db, taskId, now);
    return r;
  })();
  const noteId = Number(result.lastInsertRowid);
  emitEvent(
    db,
    task.workstreamName,
    `task note ${taskLocalId} (note #${noteId} by ${opts.author ?? "orchestrator"})`,
    opts.author ?? "system",
  );
  return {
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
export function addBlockEdge(
  db: Db,
  workstream: string,
  blocked: string,
  blocker: string,
): BlockEdgeResult {
  if (blocked === blocker) {
    // Surface as a typed CycleError so the CLI maps it to exit 4 (conflict)
    // rather than letting the schema CHECK fire as a generic SQL error.
    throw new CycleError(blocker, blocked);
  }
  const blockedRow = getTask(db, blocked, workstream);
  if (!blockedRow) throw new TaskNotFoundError(blocked);
  // Resolve the blocker globally so a cross-workstream blocker surfaces
  // CrossWorkstreamEdgeError (clearer than TaskNotFoundError). Cycle
  // check + same-workstream guard run after.
  const blockerRow = lookupTaskAnyWorkstream(db, blocker);
  if (!blockerRow) throw new TaskNotFoundError(blocker);
  if (blockedRow.workstreamName !== blockerRow.workstreamName) {
    throw new CrossWorkstreamEdgeError(
      blocker,
      blockerRow.workstreamName,
      blocked,
      blockedRow.workstreamName,
    );
  }
  const blockedId = taskIdFor(db, blocked, blockedRow.workstreamName);
  const blockerId = taskIdFor(db, blocker, blockerRow.workstreamName);
  if (blockedId === null || blockerId === null) throw new TaskNotFoundError(blocked);
  if (wouldCreateCycle(db, blockerId, blockedId)) {
    throw new CycleError(blocker, blocked);
  }
  const now = new Date().toISOString();
  const added = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
      )
      .run(blockerId, blockedId, now);
    if (result.changes > 0) {
      // Bump the BLOCKED task — its blocker set changed. The blocker
      // itself is unaffected. Aligned with reparentTask, which also
      // bumps the FROM_TASK side (the task whose blockers shifted).
      touchTask(db, blockedId, now);
      return true;
    }
    return false;
  })();
  if (added) emitEvent(db, blockedRow.workstreamName, `task block ${blocked} by ${blocker}`);
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
export function removeBlockEdge(
  db: Db,
  workstream: string,
  blocked: string,
  blocker: string,
): RemoveBlockEdgeResult {
  const blockedRow = getTask(db, blocked, workstream);
  if (!blockedRow) return { removed: false };
  const blockerRow = getTask(db, blocker, workstream);
  if (!blockerRow) return { removed: false };
  const blockedId = taskIdFor(db, blocked, blockedRow.workstreamName);
  const blockerId = taskIdFor(db, blocker, blockerRow.workstreamName);
  if (blockedId === null || blockerId === null) return { removed: false };
  const removed = db.transaction(() => {
    const result = db
      .prepare("DELETE FROM task_edges WHERE from_task_id = ? AND to_task_id = ?")
      .run(blockerId, blockedId);
    if (result.changes > 0) {
      // Bump the BLOCKED task — its blocker set just shrank.
      touchTask(db, blockedId);
      return true;
    }
    return false;
  })();
  if (removed) {
    emitEvent(db, blockedRow.workstreamName, `task unblock ${blocked} by ${blocker}`);
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
export function deleteTask(db: Db, localId: string, workstream: string): DeleteTaskResult {
  const before = getTask(db, localId, workstream);
  // Pre-mutation snapshot. delete cascades into task_edges and
  // task_notes; no per-row history can reconstruct it. Skip when the
  // row doesn't exist (the verb is idempotent on missing).
  if (before) {
    captureSnapshot(db, `task delete ${localId}`, before.workstreamName);
  }
  if (!before) {
    return { deleted: false, deletedEdges: 0, deletedNotes: 0 };
  }
  const taskId = taskIdFor(db, localId, before.workstreamName);
  if (taskId === null) {
    return { deleted: false, deletedEdges: 0, deletedNotes: 0 };
  }
  const edgesBefore = (
    db
      .prepare("SELECT COUNT(*) AS n FROM task_edges WHERE from_task_id = ? OR to_task_id = ?")
      .get(taskId, taskId) as { n: number }
  ).n;
  const notesBefore = (
    db.prepare("SELECT COUNT(*) AS n FROM task_notes WHERE task_id = ?").get(taskId) as {
      n: number;
    }
  ).n;
  const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  const deleted = result.changes > 0;
  if (deleted) {
    emitEvent(
      db,
      before.workstreamName,
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
export interface UpdateTaskScopeOption {
  workstream: string;
}

export function updateTask(
  db: Db,
  localId: string,
  opts: UpdateTaskOptions,
  scope: UpdateTaskScopeOption,
): UpdateTaskResult {
  const before = getTask(db, localId, scope.workstream);
  if (!before) throw new TaskNotFoundError(localId);
  const taskId = taskIdFor(db, before.name, before.workstreamName);
  if (taskId === null) throw new TaskNotFoundError(localId);

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
  params.push(taskId);

  db.prepare(`UPDATE tasks SET ${setters.join(", ")} WHERE id = ?`).run(...params);
  emitEvent(
    db,
    before.workstreamName,
    `task update ${localId} (changed: ${changedFields.join(", ")})`,
  );
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
  taskLocalId: string,
  blockers: readonly string[],
  scope: { workstream: string },
): ReparentTaskResult {
  const task = getTask(db, taskLocalId, scope.workstream);
  if (!task) throw new TaskNotFoundError(taskLocalId);
  const taskSurrogateId = taskIdFor(db, task.name, task.workstreamName);
  if (taskSurrogateId === null) throw new TaskNotFoundError(taskLocalId);

  // Resolve every blocker up-front to its surrogate id; do all
  // existence + same-workstream + cycle checks before any DELETE.
  // Look up blockers across all workstreams so a blocker that exists in
  // a DIFFERENT workstream surfaces CrossWorkstreamEdgeError (clearer
  // than TaskNotFoundError).
  const blockerIds: number[] = [];
  for (const blockerLocalId of blockers) {
    if (blockerLocalId === taskLocalId) {
      throw new CycleError(blockerLocalId, taskLocalId);
    }
    const blocker = lookupTaskAnyWorkstream(db, blockerLocalId);
    if (!blocker) throw new TaskNotFoundError(blockerLocalId);
    if (blocker.workstreamName !== task.workstreamName) {
      throw new CrossWorkstreamEdgeError(
        blockerLocalId,
        blocker.workstreamName,
        taskLocalId,
        task.workstreamName,
      );
    }
    const blockerId = taskIdFor(db, blocker.name, blocker.workstreamName);
    if (blockerId === null) throw new TaskNotFoundError(blockerLocalId);
    if (wouldCreateCycle(db, blockerId, taskSurrogateId)) {
      throw new CycleError(blockerLocalId, taskLocalId);
    }
    blockerIds.push(blockerId);
  }

  return db.transaction(() => {
    const removed = db.prepare("DELETE FROM task_edges WHERE to_task_id = ?").run(taskSurrogateId);
    const insertEdge = db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const blockerId of blockerIds) {
      insertEdge.run(blockerId, taskSurrogateId, now);
    }
    // Bump the reparented task itself — its blocker set just changed.
    // No-op when both removed and added were 0 (effectively a no-op
    // call); skip in that case so an idempotent `reparent --blocked-by
    // <same-set>` stays a true no-op for `--sort recency`.
    if (removed.changes > 0 || blockerIds.length > 0) {
      touchTask(db, taskSurrogateId, now);
    }
    const blockersBit = blockers.length > 0 ? `, new=${[...blockers].join(",")}` : "";
    emitEvent(
      db,
      task.workstreamName,
      `task reparent ${taskLocalId} (removed ${removed.changes} edges, added ${blockers.length}${blockersBit})`,
    );
    return { removedEdges: removed.changes, addedEdges: blockers.length };
  })();
}
