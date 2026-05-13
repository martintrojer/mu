// mu — task graph shared row-shape helpers.
//
// This module owns the snake_case → camelCase task/note mappings and
// surrogate-id resolution helpers consumed by the task SDK cluster.
// It stays below the public hub (`src/tasks.ts`): cluster files import
// from this file or sibling files, never from the hub they're re-exported
// through.

import { type Db, tryResolveWorkstreamId } from "../db.js";
import type { TaskStatus } from "./status.js";

export interface TaskRow {
  /** Per-workstream-unique TEXT name. The operator-facing identifier. */
  name: string;
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

export interface RawTaskRow {
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

export interface RawTaskNoteRow {
  author: string | null;
  content: string;
  created_at: string;
}

// SELECT clause for v5 task reads. Joins workstreams + agents to expose
// the operator-facing names as `workstream` and `owner`. Used by every
// read path so callers don't see surrogate ids.
export const SELECT_TASK_COLS = `
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

export const TASK_FROM_JOIN = `
  FROM tasks t
  JOIN workstreams ws ON ws.id = t.workstream_id
  LEFT JOIN agents ag ON ag.id = t.owner_id
`;

export const SELECT_NOTE_COLS = `
  n.author AS author,
  n.content AS content,
  n.created_at AS created_at
`;

export function rowFromDb(row: RawTaskRow): TaskRow {
  return {
    name: row.local_id,
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

export function noteFromDb(row: RawTaskNoteRow): TaskNoteRow {
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
export function lookupTaskAnyWorkstream(db: Db, localId: string): TaskRow | undefined {
  const row = db
    .prepare(
      `SELECT ${SELECT_TASK_COLS} ${TASK_FROM_JOIN} WHERE t.local_id = ? ORDER BY ws.name LIMIT 1`,
    )
    .get(localId) as RawTaskRow | undefined;
  return row ? rowFromDb(row) : undefined;
}

/** Resolve a (workstream, localId) pair to the surrogate task id.
 *  Returns null on miss. */
export function taskIdFor(db: Db, localId: string, workstream: string): number | null {
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
