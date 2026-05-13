// mu — task read/query primitives.

import type { Db } from "../db.js";
import { tryResolveWorkstreamId } from "../db.js";
import { lastClaimEventAt } from "../logs.js";
import {
  type RawTaskNoteRow,
  type RawTaskRow,
  SELECT_NOTE_COLS,
  SELECT_TASK_COLS,
  TASK_FROM_JOIN,
  type TaskNoteRow,
  type TaskRow,
  noteFromDb,
  rowFromDb,
  taskIdFor,
} from "./core.js";
import type { TaskStatus } from "./status.js";

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
 *  Used by `mu state` to populate its in-progress slice; exposed as a
 *  named SDK helper so CLI renderers don't re-derive the row-shape
 *  conversion (review_code_raw_task_state_duplicate). */
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

/** Optional filter knobs for `listNotes`. Default-everything-undefined
 *  preserves the historical "return every note, oldest-first" shape so
 *  every existing caller (cmdTaskShow's notes block, exporting.ts's
 *  bucket renderer, agents.test.ts) keeps working unchanged.
 *
 *  Filters compose multiplicatively when both apply (`since` AND
 *  `tail`): the timestamp filter is applied first, then `tail` slices
 *  the last N of what survived. The CLI surface (`mu task notes
 *  --tail / --since / --since-claim`) lives in src/cli/tasks/edit.ts;
 *  the mutex between `--since` and `--since-claim` is a CLI concern,
 *  not enforced here — if both arrive at the SDK, `since` wins (it's
 *  the explicit one) and `sinceClaim` is ignored. The auto-resolve
 *  for `sinceClaim` (look up the most recent `task claim` event in
 *  agent_logs) happens here so the SDK is self-contained for scripted
 *  callers. */
export interface ListNotesOptions {
  /** Print only the last N notes (after any timestamp filter). Must
   *  be a positive integer; a value of 0 returns no rows but is not
   *  an error here — CLI-side validation rejects `--tail 0`. */
  tail?: number;
  /** ISO-8601 cutoff: only notes with `created_at > since` survive.
   *  Comparison is lexicographic on the ISO string (matches the way
   *  the rest of the codebase compares ISO timestamps). */
  since?: string;
  /** When true and `since` is unset, look up the `created_at` of the
   *  most recent `task claim` event for this task and use it as the
   *  cutoff. Falls back to no filter when no claim event exists
   *  (equivalent to `--since-beginning`). */
  sinceClaim?: boolean;
}

/** List notes for a task. Operator-facing local_id; resolves to the
 *  surrogate task id via taskIdFor (with optional workstream scope).
 *
 *  Optional filters: see {@link ListNotesOptions}. Default behaviour
 *  (no opts) is unchanged — every note, oldest-first. */
export function listNotes(
  db: Db,
  taskLocalId: string,
  workstream: string,
  opts: ListNotesOptions = {},
): TaskNoteRow[] {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return [];
  // Resolve the cutoff once: explicit `since` wins; otherwise
  // `sinceClaim` resolves via lastClaimEventAt (null → no filter).
  let cutoff: string | undefined = opts.since;
  if (cutoff === undefined && opts.sinceClaim === true) {
    const at = lastClaimEventAt(db, workstream, taskLocalId);
    if (at !== null) cutoff = at;
  }
  const rows =
    cutoff !== undefined
      ? (db
          .prepare(
            `SELECT ${SELECT_NOTE_COLS} FROM task_notes n JOIN tasks t ON t.id = n.task_id
              WHERE n.task_id = ? AND n.created_at > ? ORDER BY n.id`,
          )
          .all(taskId, cutoff) as RawTaskNoteRow[])
      : (db
          .prepare(
            `SELECT ${SELECT_NOTE_COLS} FROM task_notes n JOIN tasks t ON t.id = n.task_id
              WHERE n.task_id = ? ORDER BY n.id`,
          )
          .all(taskId) as RawTaskNoteRow[]);
  const mapped = rows.map(noteFromDb);
  if (opts.tail !== undefined && opts.tail >= 0) {
    return opts.tail === 0 ? [] : mapped.slice(-opts.tail);
  }
  return mapped;
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
