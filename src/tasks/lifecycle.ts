// mu — task lifecycle verbs: setTaskStatus, closeTask, openTask.
//
// Lifecycle = "transition a task from one status to another, with
// the right captured-op and evidence-note side effects".
//
// EvidenceOption is shared with claim/release (in tasks/claim.ts) and
// re-exported here as the canonical home; claim.ts imports from this
// file.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import type { Db } from "../db.js";
import { withOpContext } from "../op-context.js";
import { getTaskEdgesWithStatus } from "./edges.js";
import { addNote } from "./edit.js";
import { TaskNotFoundError } from "./errors.js";
import { getTask } from "./queries.js";
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

/**
 * Persist `--evidence` as a task note, so it survives as a captured op.
 *
 * mu once put evidence in the prose event payload AND (for close only) in a
 * synthetic note. v2-retire-log-shim deleted the prose events, which
 * would have silently dropped evidence on open/release. The note is now
 * the single home for it: notes are portable and sync, whereas the prose
 * event was machine-local and unparseable.
 *
 * Only fires when the verb actually changed something (an idempotent
 * re-close attests nothing new) and the evidence is a non-empty string.
 */
export function recordEvidenceNote(
  db: Db,
  localId: string,
  workstream: string,
  label: string,
  opts: (EvidenceOption & { author?: string }) | undefined,
): void {
  if (!opts || opts.evidence === undefined || opts.evidence === "") return;
  const noteOpts: { author?: string; workstream: string } = { workstream };
  if (opts.author !== undefined && opts.author !== "") noteOpts.author = opts.author;
  addNote(db, localId, `${label}: ${opts.evidence}`, noteOpts);
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
  // NOTE: no `group` here, so a nested call inherits the enclosing
  // group. A direct call with no enclosing context still gets its own
  // group (withOpContext mints one).
  //
  // `intentIfUnset` (not `intent`): when reached via closeTask, the
  // outer verb is the label the operator recognises, so it must win.
  // Only a direct setTaskStatus call labels itself.
  return withOpContext(db, { intentIfUnset: `task.set-${status.toLowerCase()}` }, () =>
    setTaskStatusImpl(db, localId, status, opts),
  );
}

function setTaskStatusImpl(
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
  // No emitEvent: the UPDATE fired the capture trigger, whose intent is
  // the specific verb (task.close / task.open, or task.set-<status> for
  // a bare status set) and whose payload names the new status. Evidence,
  // when passed, lands as a task note — itself a captured op.
  return { previousStatus: before.status, status, changed: true };
}

/** Result of `closeTask` when called with `ifReady: true` and the
 *  task is NOT yet ready to close (still has at least one OPEN /
 *  IN_PROGRESS blocker). Distinguished from a regular `SetStatusResult`
 *  by the literal `skipped` field; the CLI keys on it to switch
 *  between the "closed" and "waiting" rendering paths.
 *
 *  Surfaced in `fb_umbrella_no_auto_close` (impact=60): a wave umbrella
 *  with N blockers stayed OPEN after every blocker reached a terminal
 *  status. `--if-ready` is the cheap fix: bare `mu task close` is
 *  unchanged (closes regardless), `--if-ready` is a no-op unless every
 *  blocker is CLOSED. */
export interface CloseSkippedResult {
  /** Always 'not_ready' when set; future cause-codes can extend this
   *   without reshaping the JSON payload (the literal-union narrows
   *   safely in the CLI rendering path). */
  skipped: "not_ready";
  /** Status before the call (always the current status, no change). */
  previousStatus: TaskStatus;
  /** Status after the call (== previousStatus, since we no-op). */
  status: TaskStatus;
  /** Always false on a skip (no row mutated). */
  changed: false;
  /** Local ids of every blocker still in OPEN or IN_PROGRESS, sorted
   *   alphabetically for deterministic rendering. Empty list is
   *   impossible on this branch — the no-op only fires when ≥1
   *   blocker is non-terminal. */
  blockingIds: string[];
}

export interface CloseTaskOptions extends EvidenceOption {
  workstream: string;
  /** When true, no-op the close unless every blocker is CLOSED.
   *   Returns a `CloseSkippedResult` carrying the still-blocking ids;
   *   the CLI renders the skip with a Next: hint pointing at
   *   `mu task wait`. When false / omitted, behaves as bare `closeTask`
   *   (closes regardless of blocker status). */
  ifReady?: boolean;
  /** Optional actor identity attributed to the synthetic `CLOSE: …`
   *  note auto-inserted when `evidence` is non-empty (see closeTask
   *  body). The CLI resolves this via `resolveActorIdentity()` so the
   *  note carries the closing worker's name; SDK callers (tests,
   *  internal use) may omit it (the note then carries no author, same
   *  as a bare `addNote` without `--author`). Surfaced in mufeedback
   *  task_close_evidence_does_not_append_the. */
  author?: string;
}

/** Convenience: setTaskStatus(db, id, "CLOSED"). Accepts evidence.
 *  Skipped
 *  for the idempotent no-op (already CLOSED) so we don't accumulate
 *  empty-delta snapshots on retry loops.
 *
 *  With `ifReady: true`, returns a `CloseSkippedResult` (no mutation,
 *  no snapshot) when any blocker is still OPEN / IN_PROGRESS. Used by
 *  `mu task close --if-ready` so an orchestrator can fire-and-forget
 *  the umbrella close after every blocker resolves without first
 *  re-querying the graph. */
export function closeTask(
  db: Db,
  localId: string,
  opts: CloseTaskOptions,
): SetStatusResult | CloseSkippedResult {
  return withOpContext(db, { intent: "task.close", actor: opts.author, group: "new" }, () =>
    closeTaskImpl(db, localId, opts),
  );
}

function closeTaskImpl(
  db: Db,
  localId: string,
  opts: CloseTaskOptions,
): SetStatusResult | CloseSkippedResult {
  const before = getTask(db, localId, opts.workstream);
  if (opts.ifReady && before) {
    // Inspect direct blockers only — the umbrella convention is one
    // hop (umbrella -[blocked-by]→ each wave task). If any direct
    // blocker is not CLOSED, the umbrella isn't ready.
    const edges = getTaskEdgesWithStatus(db, localId, before.workstreamName);
    const blocking = edges.blockers
      .filter((e) => e.status !== "CLOSED")
      .map((e) => e.name)
      .sort();
    if (blocking.length > 0) {
      return {
        skipped: "not_ready",
        previousStatus: before.status,
        status: before.status,
        changed: false,
        blockingIds: blocking,
      };
    }
  }
  // No pre-mutation snapshot: v9 dropped the `snapshots` table and
  // rollback is inverse ops over the ops log (`mu undo`).
  const r = setTaskStatus(db, localId, "CLOSED", opts);
  // mufeedback task_close_evidence_does_not_append_the: evidence must
  // reach `mu task notes <id>` / `mu task show <id>`, not just the log.
  // Since v2-retire-log-shim the note is the ONLY home for it.
  if (r.changed && before) recordEvidenceNote(db, localId, before.workstreamName, "CLOSE", opts);
  return r;
}

/** Convenience: setTaskStatus(db, id, "OPEN"). Owner intentionally NOT
 *  cleared — use `releaseTask` for that. Accepts evidence. */
export function openTask(
  db: Db,
  localId: string,
  opts: EvidenceOption & { workstream: string },
): SetStatusResult {
  return withOpContext(db, { intent: "task.open", group: "new" }, () => {
    const before = getTask(db, localId, opts.workstream);
    const r = setTaskStatus(db, localId, "OPEN", opts);
    if (r.changed && before) recordEvidenceNote(db, localId, before.workstreamName, "OPEN", opts);
    return r;
  });
}
