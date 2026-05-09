// mu — TaskStatus enum + helpers.
//
// Single source of truth for "what statuses can a task have". The
// schema (db.ts) has a CHECK clause that mirrors TASK_STATUSES; if you
// add a status, update both places.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

export type TaskStatus = "OPEN" | "IN_PROGRESS" | "CLOSED" | "REJECTED" | "DEFERRED";

/** Every legal task status, in canonical order (matches the schema
 *  CHECK clause). Exported so CLI surfaces (`--status` validators,
 *  --help text, error messages) name them all in one place; missing
 *  one used to silently lie about the supported set. */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "CLOSED",
  "REJECTED",
  "DEFERRED",
];

/** Statuses that count as 'no longer scheduled work' — used by the
 *  goals view and by the dependent-check on reject/defer.
 *
 *  (The complement — 'statuses that satisfy a blocked-by edge' — is
 *  just `["CLOSED"]` and is hardcoded inline in the SQL views in
 *  src/db.ts. A constant for it was tried and reverted: a one-element
 *  array doesn't earn its keep, and parameterising the SQL views from
 *  a TS const would be brittle.) */
export const STATUSES_TERMINAL_OR_PARKED: readonly TaskStatus[] = [
  "CLOSED",
  "REJECTED",
  "DEFERRED",
];

export function isTaskStatus(s: string): s is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(s);
}

/** Pipe-separated list of every legal status, e.g.
 *  'OPEN | IN_PROGRESS | CLOSED | REJECTED | DEFERRED'. Single source
 *  of truth for --help text and error messages so adding a new status
 *  doesn't leave stale lists rotting in the CLI surface. */
export const TASK_STATUS_LIST = TASK_STATUSES.join(" | ");
