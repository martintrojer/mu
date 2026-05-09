// mu — task lifecycle verbs: setTaskStatus, closeTask, openTask,
// rejectTask, deferTask + supporting types.
//
// Lifecycle = "transition a task from one status to another, with
// the right side effects (auto-snapshot before mutating, emit
// agent_logs event, refresh pane title via the caller, validate
// guard rails like 'reject would strand dependents')".
//
// EvidenceOption is shared with claim/release (in tasks/claim.ts) and
// re-exported here as the canonical home; claim.ts imports from this
// file.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { captureSnapshot } from "../snapshots.js";
import { getTask } from "../tasks.js";
import { TaskHasOpenDependentsError, TaskNotFoundError } from "./errors.js";
import type { TaskStatus } from "./status.js";

export interface SetStatusResult {
  /** Status before the call. */
  previousStatus: TaskStatus;
  /** Status after the call (== requested status). */
  status: TaskStatus;
  /** True iff the row actually changed. False on idempotent no-op. */
  changed: boolean;
}

/**
 * Optional evidence string carried on lifecycle verbs (close / open /
 * claim / release). Lands in the auto-emitted `kind='event'` payload
 * verbatim, prefixed with `evidence=`. The first inch of distinguishing
 * "observed" from "claimed" state per an internal critique: the
 * verb still trusts the caller (it's not a verifier), but the audit
 * trail records what the caller said it relied on.
 */
export interface EvidenceOption {
  evidence?: string;
}

/** Render the optional `--evidence "<text>"` payload as the trailing
 *  ' evidence="..."' on every state-changing event. Exported because
 *  claimTask/releaseTask in src/tasks/claim.ts also use it. */
export function evidenceSuffix(opts: EvidenceOption | undefined): string {
  if (!opts || opts.evidence === undefined) return "";
  return ` evidence=${JSON.stringify(opts.evidence)}`;
}

/**
 * Flip a task's status to any of OPEN / IN_PROGRESS / CLOSED.
 * Idempotent: setting a task to its current status is a no-op (returns
 * `changed: false`) rather than throwing. Owner is unchanged.
 */
export function setTaskStatus(
  db: Db,
  localId: string,
  status: TaskStatus,
  opts: EvidenceOption & { workstream: string },
): SetStatusResult {
  const before = getTask(db, localId, opts.workstream);
  if (!before) throw new TaskNotFoundError(localId);
  if (before.status === status) {
    return { previousStatus: before.status, status, changed: false };
  }
  // v5: tasks.local_id is per-workstream unique. Scope to the row's
  // workstream so the UPDATE doesn't accidentally touch a same-named
  // task in another workstream.
  db.prepare(
    `UPDATE tasks SET status = ?, updated_at = ?
      WHERE local_id = ?
        AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)`,
  ).run(status, new Date().toISOString(), localId, before.workstreamName);
  emitEvent(
    db,
    before.workstreamName,
    `task status ${localId} (${before.status} → ${status})${evidenceSuffix(opts)}`,
  );
  return { previousStatus: before.status, status, changed: true };
}

/** Convenience: setTaskStatus(db, id, "CLOSED"). Accepts evidence.
 *  Pre-snapshots the DB (snap_design §CAPTURE STRATEGY > WHEN). Skipped
 *  for the idempotent no-op (already CLOSED) so we don't accumulate
 *  empty-delta snapshots on retry loops. */
export function closeTask(
  db: Db,
  localId: string,
  opts: EvidenceOption & { workstream: string },
): SetStatusResult {
  const before = getTask(db, localId, opts.workstream);
  if (before && before.status !== "CLOSED") {
    captureSnapshot(db, `task close ${localId}`, before.workstreamName);
  }
  return setTaskStatus(db, localId, "CLOSED", opts);
}

/** Convenience: setTaskStatus(db, id, "OPEN"). Owner intentionally NOT
 *  cleared — use `releaseTask` for that. Accepts evidence. */
export function openTask(
  db: Db,
  localId: string,
  opts: EvidenceOption & { workstream: string },
): SetStatusResult {
  return setTaskStatus(db, localId, "OPEN", opts);
}

// ─── rejectTask / deferTask (terminal-but-blocking transitions) ────
//
// REJECTED and DEFERRED both leave the task off the active scheduler
// (gone from `ready`, `goals`, track count) but, unlike CLOSED, do NOT
// satisfy a `--blocked-by` edge. A REJECTED / DEFERRED task therefore
// silently strands every OPEN/IN_PROGRESS dependent. We refuse the
// transition unless either there are no open dependents OR the caller
// passes `--cascade` to apply the same status to every transitive
// dependent.

export interface RejectDeferOptions extends EvidenceOption {
  /** Workstream context for the root task. All internal task lookups
   *  (including the dependent walk) scope to this workstream. */
  workstream: string;
  /** If true, walk the transitive dependent closure and (with `yes`)
   *  apply the same status to every dependent, atomically. Without
   *  `yes`, runs as a dry-run: returns the list of tasks that WOULD
   *  be swept (changedIds) with `dryRun: true` and changes nothing.
   *  Logs one event per task (via setTaskStatus) on commit. */
  cascade?: boolean;
  /** Required to actually commit a `cascade` operation. Without it,
   *  cascade is dry-run only — prints the affected dependents so the
   *  caller can verify before sweeping. Mirrors `mu workstream destroy
   *  --yes`. Surfaced in mufeedback bug_cascade_reject_too_aggressive
   *  when an accidentally-cascaded reject swept hud_dogfood (which had
   *  independent merit and needed reopening). */
  yes?: boolean;
}

export interface RejectDeferResult {
  /** Tasks that actually changed status, in cascade order (root first). */
  changedIds: string[];
  /** The status now stamped on every changedId. */
  status: TaskStatus;
  /** True iff anything changed. False on a clean idempotent no-op
   *  (root task already in target status, no dependents). */
  changed: boolean;
  /** True iff this was a `cascade` dry-run (cascade requested without
   *  `yes`). In that case `changedIds` lists tasks that WOULD be
   *  swept; the DB is unchanged. */
  dryRun: boolean;
  /** Tasks that would be touched by a cascade. Same as `changedIds`
   *  on a dry-run; populated even on a commit so the caller can
   *  report what was swept. */
  affectedIds: string[];
}

/** Reject a task: terminal 'won't do' (out of scope, duplicate, wontfix).
 *  Refuses if dependents are open unless `--cascade`.
 *  Pre-snapshots once at the verb level so a cascade onto N children
 *  produces a single snapshot, not N. Skipped for the idempotent no-op. */
export function rejectTask(db: Db, localId: string, opts: RejectDeferOptions): RejectDeferResult {
  const before = getTask(db, localId, opts.workstream);
  if (before && before.status !== "REJECTED") {
    captureSnapshot(db, `task reject ${localId}`, before.workstreamName);
  }
  return setTerminalOrParked(db, localId, "REJECTED", opts);
}

/** Defer a task: parked, may revisit. Same dependent-stranding semantics
 *  as reject (DEFERRED also doesn't satisfy a `--blocked-by` edge).
 *  Pre-snapshots once at the verb level. Skipped for the idempotent no-op. */
export function deferTask(db: Db, localId: string, opts: RejectDeferOptions): RejectDeferResult {
  const before = getTask(db, localId, opts.workstream);
  if (before && before.status !== "DEFERRED") {
    captureSnapshot(db, `task defer ${localId}`, before.workstreamName);
  }
  return setTerminalOrParked(db, localId, "DEFERRED", opts);
}

function setTerminalOrParked(
  db: Db,
  localId: string,
  status: "REJECTED" | "DEFERRED",
  opts: RejectDeferOptions,
): RejectDeferResult {
  const before = getTask(db, localId, opts.workstream);
  if (!before) throw new TaskNotFoundError(localId);

  // Find all open (OPEN or IN_PROGRESS) tasks that transitively depend
  // on this one. Forward-edge recursive CTE from localId, scoped by
  // the root task's workstream.
  const openDependents = findOpenDependents(db, localId, before.workstreamName);

  if (openDependents.length > 0 && !opts.cascade) {
    const verb = status === "REJECTED" ? "reject" : "defer";
    throw new TaskHasOpenDependentsError(localId, verb, openDependents);
  }

  const affectedIds =
    openDependents.length > 0 && opts.cascade ? [localId, ...openDependents] : [localId];

  // Cascade dry-run: cascade requested but --yes missing. Don't touch
  // the DB; return the would-be-affected list so the CLI can render
  // a 'about to sweep these N tasks; rerun with --yes' preview.
  // Mirrors `mu workstream destroy` semantics. Single-task case
  // (openDependents == 0, cascade flag irrelevant) skips the dry-run
  // since there's nothing to preview.
  if (opts.cascade && !opts.yes && openDependents.length > 0) {
    return {
      changedIds: affectedIds,
      status,
      changed: false,
      dryRun: true,
      affectedIds,
    };
  }

  // Apply to root first, then dependents in BFS order. setTaskStatus
  // emits one event per task and is idempotent (no-op if already in
  // target status). Every UPDATE scopes to the root's workstream
  // (dependents must share it — cross-ws edges are forbidden).
  const childOpts: EvidenceOption & { workstream: string } = {
    workstream: before.workstreamName,
    ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
  };
  const changedIds: string[] = [];
  for (const id of affectedIds) {
    const r = setTaskStatus(db, id, status, childOpts);
    if (r.changed) changedIds.push(id);
  }

  return {
    changedIds,
    status,
    changed: changedIds.length > 0,
    dryRun: false,
    affectedIds,
  };
}

/** Open dependents that would be stranded if `taskId` were rejected /
 *  deferred. The walk PRUNES at CLOSED nodes: a CLOSED intermediate
 *  has already satisfied its blocked-by edge, so its downstream is
 *  independent of whatever happens to `taskId` and must NOT be swept.
 *  REJECTED / DEFERRED intermediates also stop the walk — their
 *  downstream is already stranded by them, not by `taskId`, and a
 *  cascade from here would (a) double-flip them or (b) overwrite a
 *  previous explicit decision.
 *
 *  Ordering: BFS-equivalent via DISTINCT + ORDER BY local_id; cascade
 *  applies one row at a time so each setTaskStatus is logged. */
function findOpenDependents(db: Db, taskLocalId: string, workstream: string): string[] {
  // Resolve the seed task to its surrogate id, then walk forward
  // edges in surrogate-id space; project back to local_id at the end.
  // Scope the seed by workstream (v5 per-workstream local_id) so a
  // same-named task elsewhere can't seed a cascade in this workstream
  // (bug_v5_name_clash_silent_misroute).
  const seed = db
    .prepare(
      `SELECT id FROM tasks WHERE local_id = ?
        AND workstream_id = (SELECT id FROM workstreams WHERE name = ?)`,
    )
    .get(taskLocalId, workstream) as { id: number } | undefined;
  if (!seed) return [];
  const rows = db
    .prepare(
      `WITH RECURSIVE forward(node) AS (
         SELECT e.to_task_id
           FROM task_edges e
           JOIN tasks      t ON t.id = e.to_task_id
          WHERE e.from_task_id = ?
            AND t.status IN ('OPEN', 'IN_PROGRESS')
         UNION
         SELECT e.to_task_id
           FROM task_edges e
           JOIN forward    f ON f.node = e.from_task_id
           JOIN tasks      t ON t.id = e.to_task_id
          WHERE t.status IN ('OPEN', 'IN_PROGRESS')
       )
       SELECT DISTINCT t.local_id AS local_id FROM forward f
         JOIN tasks t ON t.id = f.node
        ORDER BY t.local_id`,
    )
    .all(seed.id) as { local_id: string }[];
  return rows.map((r) => r.local_id);
}
