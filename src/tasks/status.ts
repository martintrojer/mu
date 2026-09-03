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

/** Lifecycle values v10 removed. History and v9 peers still carry
 *  them, and the schema CHECK clause rejects them, so any path that
 *  REPLAYS a stored status has to fold them onto a live one. */
const RETIRED_STATUSES: ReadonlySet<string> = new Set(["REJECTED", "DEFERRED"]);

/**
 * Coerce a possibly-historical status onto one the schema accepts.
 *
 * Both retired values meant "not being worked on and not finished",
 * which is `OPEN`. Only the decoded projection is normalized — callers
 * record the original payload unchanged, so the historical evidence
 * survives in the ops log.
 *
 * Shared by the two replay paths that can meet a v8/v9 payload: the
 * apply path (`applyTaskPut`, for peer ops and rebuilds) and the undo
 * path (`restoreRow`, for reverting an old destroy). Both used to be
 * responsible for knowing the retired set; undo did not, so undoing a
 * pre-v10 `workstream destroy` died on the CHECK constraint.
 */
export function normalizeTaskStatus(value: string): string {
  return RETIRED_STATUSES.has(value) ? "OPEN" : value;
}

/** Pipe-separated list of every legal status, e.g.
 *  'OPEN | IN_PROGRESS | CLOSED'. Single source of truth for
 *  --help text and error messages so adding a new status doesn't
 *  leave stale lists rotting in the CLI surface. */
export const TASK_STATUS_LIST = TASK_STATUSES.join(" | ");
