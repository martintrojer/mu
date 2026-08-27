// mu — TaskStatus enum + helpers.
//
// Single source of truth for "what statuses can a task have". The
// schema (db.ts) has a CHECK clause that mirrors TASK_STATUSES; if you
// add a status, update both places.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

export type TaskStatus = "OPEN" | "IN_PROGRESS" | "CLOSED";

/** Every legal task status, in canonical order (matches the schema
 *  CHECK clause). Exported so CLI surfaces (`--status` validators,
 *  --help text, error messages) name them all in one place; missing
 *  one used to silently lie about the supported set. */
export const TASK_STATUSES: readonly TaskStatus[] = ["OPEN", "IN_PROGRESS", "CLOSED"];

export function isTaskStatus(s: string): s is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(s);
}

/** Pipe-separated list of every legal status, e.g.
 *  'OPEN | IN_PROGRESS | CLOSED'. Single source of truth for
 *  --help text and error messages so adding a new status doesn't
 *  leave stale lists rotting in the CLI surface. */
export const TASK_STATUS_LIST = TASK_STATUSES.join(" | ");
