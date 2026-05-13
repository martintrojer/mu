// mu — task error classes.
//
// Every task verb that can fail in a typed way has its own error class
// here. The CLI's `classifyError()` (src/cli.ts) maps them to exit codes:
//   not found  → 3   (TaskNotFoundError)
//   conflict   → 4   (TaskExistsError, TaskNotInWorkstreamError,
//                     TaskAlreadyOwnedError, TaskHasOpenDependentsError,
//                     ClaimerNotRegisteredError, CrossWorkstreamEdgeError,
//                     TaskIdInvalidError)
//   cycle      → 4   (CycleError — also a conflict)
//
// Each error implements HasNextSteps so the CLI can render a per-error
// `Next:` block with the most useful follow-up commands.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import type { HasNextSteps, NextStep } from "../output.js";
import { WORKSPACE_STALE_THRESHOLD, type WorkspaceStaleness } from "../workspace.js";
import { sanitiseTaskId } from "./id.js";

export class TaskNotFoundError extends Error implements HasNextSteps {
  override readonly name = "TaskNotFoundError";
  constructor(public readonly taskId: string) {
    super(`no such task: ${taskId}`);
  }
  errorNextSteps(): NextStep[] {
    // v5: tasks.workstream (TEXT) was replaced by tasks.workstream_id
    // (FK → workstreams.id). The pre-v5 recipe SELECTed a column that
    // no longer exists and crashed at runtime — and this is THE first
    // hint a user sees on a missed-task lookup, so the breakage was
    // high-traffic. Mirror the join pattern used by AgentExistsError.
    const idLit = this.taskId.replace(/'/g, "''").toLowerCase();
    const recipe = `mu sql "SELECT ws.name AS workstream, t.local_id, t.status, t.title FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id WHERE LOWER(t.local_id) LIKE '%${idLit}%' OR LOWER(t.title) LIKE '%${idLit}%'"`;
    return [
      { intent: "List tasks in workstream", command: "mu task list -w <workstream>" },
      { intent: "Search by substring (id + title)", command: recipe },
      { intent: "Find which workstream owns it", command: recipe },
    ];
  }
}

/**
 * Thrown by `addTask` when `localId` violates the schema regex
 * `/^[a-z][a-z0-9_-]{0,63}$/`. Replaces a bare `TypeError` so the
 * CLI's `handle()` wrapper can map it to exit code 4 (validation /
 * conflict) and surface a `--json` `nextSteps` block pointing at
 * the auto-derived-id workflow and a sanitised candidate.
 */
export class TaskIdInvalidError extends Error implements HasNextSteps {
  override readonly name = "TaskIdInvalidError";
  constructor(public readonly attempted: string) {
    super(`invalid task id: ${JSON.stringify(attempted)} (expected /^[a-z][a-z0-9_-]{0,63}$/)`);
  }
  errorNextSteps(): NextStep[] {
    const sanitised = sanitiseTaskId(this.attempted);
    return [
      {
        intent: "Use the auto-derived id (drop --id and pass --title)",
        command: 'mu task add --title "..." --impact <n> --effort-days <n>',
      },
      {
        intent: "Sanitise to a valid id",
        command: `mu task add ${sanitised} --title "..." --impact <n> --effort-days <n>`,
      },
    ];
  }
}

export class TaskExistsError extends Error implements HasNextSteps {
  override readonly name = "TaskExistsError";
  constructor(public readonly taskId: string) {
    super(`task already exists: ${taskId}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Show the existing task", command: `mu task show ${this.taskId}` },
      {
        intent: "Update fields on the existing task",
        command: `mu task update ${this.taskId} --title "..." --impact <n> --effort-days <n>`,
      },
      {
        intent: "Pick a different id",
        command: 'mu task add <new-id> --title "..." --impact <n> --effort-days <n>',
      },
    ];
  }
}

/**
 * Thrown when a verb is invoked with `-w/--workstream <name>` but the
 * named task lives in a different workstream. Distinguishes "the user
 * typo'd the workstream" from "the task doesn't exist anywhere"
 * (which surfaces as `TaskNotFoundError`). Maps to exit code 4
 * (conflict / wrong scope).
 */
export class TaskNotInWorkstreamError extends Error implements HasNextSteps {
  override readonly name = "TaskNotInWorkstreamError";
  constructor(
    public readonly taskId: string,
    public readonly expectedWorkstream: string,
    public readonly actualWorkstream: string,
  ) {
    super(`task ${taskId} is in workstream ${actualWorkstream}, not ${expectedWorkstream}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Use the correct workstream",
        command: `mu task show ${this.taskId} -w ${this.actualWorkstream}`,
      },
      {
        intent: "List tasks in the requested workstream",
        command: `mu task list -w ${this.expectedWorkstream}`,
      },
    ];
  }
}

export class TaskAlreadyOwnedError extends Error implements HasNextSteps {
  override readonly name = "TaskAlreadyOwnedError";
  constructor(
    public readonly taskId: string,
    public readonly currentOwner: string,
  ) {
    super(`task ${taskId} is already owned by ${currentOwner}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "See the current owner's task list",
        command: `mu task owned-by ${this.currentOwner}`,
      },
      {
        intent: "Release the current claim (if you ARE the owner)",
        command: `mu task release ${this.taskId}`,
      },
      { intent: "Show full task state", command: `mu task show ${this.taskId}` },
    ];
  }
}

/**
 * Thrown by `rejectTask` / `deferTask` when the target task has
 * dependents that are still OPEN or IN_PROGRESS. Rejecting or
 * deferring such a task would silently strand the dependents (they'd
 * remain blocked by a prereq that's never going to satisfy the edge),
 * so we refuse and force an explicit decision: pass `--cascade` to
 * apply the same status to every transitive dependent, drop the
 * blocking edge first with `mu task unblock`, or address the
 * dependents individually. Maps to exit code 4.
 */
export class TaskHasOpenDependentsError extends Error implements HasNextSteps {
  override readonly name = "TaskHasOpenDependentsError";
  constructor(
    public readonly taskId: string,
    public readonly verb: "reject" | "defer",
    public readonly dependents: readonly string[],
  ) {
    super(
      `cannot ${verb} ${taskId}: ${dependents.length} open dependent(s) would be stranded (${dependents.slice(0, 5).join(", ")}${dependents.length > 5 ? ", …" : ""}). Pick one resolution and re-run.`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: `Preview the cascade (lists dependents that would be ${this.verb}ed; --cascade alone is dry-run)`,
        command: `mu task ${this.verb} ${this.taskId} --cascade`,
      },
      {
        intent: `${this.verb.charAt(0).toUpperCase() + this.verb.slice(1)} the whole sub-tree (commit; rerun with --yes after previewing)`,
        command: `mu task ${this.verb} ${this.taskId} --cascade --yes`,
      },
      {
        intent: "Drop the blocking edge from a dependent first",
        command: `mu task unblock <dep> --by ${this.taskId}`,
      },
      {
        intent: "Address dependents individually first",
        command: `mu task ${this.verb} <dep>`,
      },
    ];
  }
}

/**
 * Thrown when `mu task claim` resolves a claimer agent name (from the
 * pane title or --for) that has no matching row in the agents table.
 *
 * The FK on `tasks.owner` references `agents.name`; without this guard
 * the claim attempt would fail with the unhelpful 'FOREIGN KEY constraint
 * failed' from SQLite. This typed error gives the user actionable next
 * steps (run `mu agent adopt <pane-id>` to register, or use --for to pick a
 * different agent).
 *
 * Maps to exit code 4 (conflict) via the cli.ts handler.
 */
export class ClaimerNotRegisteredError extends Error implements HasNextSteps {
  override readonly name = "ClaimerNotRegisteredError";
  constructor(
    public readonly agentName: string,
    public readonly paneId: string | null,
  ) {
    const paneHint = paneId !== null ? ` (pane ${paneId})` : "";
    super(
      `claimer '${agentName}'${paneHint} is not a registered mu agent (no row in agents table)`,
    );
  }

  /**
   * Three actionable resolutions in expected-frequency order:
   *   1. --self  : orchestrator pattern (working directly)
   *   2. --for   : dispatcher pattern (assigning to a worker)
   *   3. mu agent adopt: registration pattern (promote pane to worker)
   */
  errorNextSteps(): NextStep[] {
    const steps: NextStep[] = [
      { intent: "Work directly (anonymous)", command: "mu task claim <id> --self" },
      { intent: "Dispatch to a worker", command: "mu task claim <id> --for <worker>" },
    ];
    steps.push(
      this.paneId !== null
        ? { intent: "Register this pane", command: `mu agent adopt ${this.paneId}` }
        : {
            intent: "Register a pane",
            command: "mu agent adopt <pane-id>  (must be in mu-<workstream> tmux session)",
          },
    );
    return steps;
  }
}

export class TaskClaimStaleWorkspaceError extends Error implements HasNextSteps {
  override readonly name = "TaskClaimStaleWorkspaceError";
  constructor(public readonly staleness: WorkspaceStaleness) {
    super(
      `${staleness.agentName} workspace is ${staleness.commitsBehindMain} commits behind main (≥${WORKSPACE_STALE_THRESHOLD} = stale); refresh before dispatch or rerun without --strict-staleness`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Refresh first",
        command: `mu workspace refresh ${this.staleness.agentName} -w ${this.staleness.workstreamName}`,
      },
    ];
  }
}

export class CycleError extends Error implements HasNextSteps {
  override readonly name = "CycleError";
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`adding edge ${from} -> ${to} would create a cycle`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Show the dependency tree",
        command: `mu task tree ${this.to} --down`,
      },
      {
        intent: "Show the prereq tree (what blocks the from-task)",
        command: `mu task tree ${this.from}`,
      },
      {
        intent: "Remove an edge in the path to break the cycle",
        command: "mu task unblock <blocked> --by <blocker>",
      },
    ];
  }
}

/**
 * Thrown by the `mu task wait` CLI wrapper when the per-poll
 * reconciler detects that a watched task transitioned
 * `IN_PROGRESS → OPEN` between polls (the reaper saw the owner's
 * pane was gone and flipped the task back). With `--status CLOSED`
 * (the default) the wait can never satisfy by progress — the worker
 * is dead — so we abort fast instead of running out the operator's
 * `--timeout`.
 *
 * Maps to exit code 6 (REAPER_DETECTED) via the cli.ts handler. The
 * suppression rule (only fire when target=CLOSED) lives in the
 * caller; this error type is a pure data carrier.
 *
 * Surfaced live by task_wait_reconcile_dead_panes (twice in one
 * v0.3 dispatch wave: tmux restart killed worker panes; `mu task
 * wait --timeout 1800` blocked silently for 25 min instead of
 * failing in seconds).
 */
export class ReaperDetectedDuringWaitError extends Error implements HasNextSteps {
  override readonly name = "ReaperDetectedDuringWaitError";
  constructor(
    public readonly taskId: string,
    public readonly previousOwner: string | null,
    public readonly workstream: string,
  ) {
    const ownerBit = previousOwner !== null ? `owner=${previousOwner}` : "owner=<unknown>";
    super(
      `task ${taskId} was IN_PROGRESS ${ownerBit} until just now; reaper detected dead pane and flipped to OPEN. wait abandoned. Re-dispatch a worker and retry.`,
    );
  }
  errorNextSteps(): NextStep[] {
    const ws = this.workstream;
    return [
      {
        intent: "Inspect the task's current state",
        command: `mu task show ${this.taskId} -w ${ws}`,
      },
      {
        intent: "List live agents in the workstream (post-reap)",
        command: `mu agent list -w ${ws}`,
      },
      {
        intent: "Re-dispatch a fresh worker, then re-run the wait",
        command: `mu agent spawn <name> -w ${ws}  &&  mu task claim ${this.taskId} --for <name> -w ${ws}`,
      },
    ];
  }
}

/**
 * Thrown by the `mu task wait` CLI wrapper when `--on-stall exit` is
 * in effect and the existing `--stuck-after` predicate fires on a
 * watched task — the task is IN_PROGRESS, owned by a registered
 * agent whose detected status is `needs_input` for `>= stuckAfterMs`.
 *
 * Pairs with `ReaperDetectedDuringWaitError` (exit 6, dead pane).
 * Stall is the AMBIGUOUS sibling: the worker is alive but not
 * progressing — the operator decides whether it's transient (poke +
 * retry) or terminal (release + reopen). Exit code 7 = STALL_DETECTED
 * via classifyError, distinct from 6 so consumer scripts can branch.
 *
 * Carve-out (lives at the call site, not here): only fires when the
 * wait target is CLOSED — same logic as exit-6's reaper-flip
 * suppression. With `--status OPEN`/etc the worker reaching
 * needs_input might BE the success path.
 *
 * Surfaced by task_wait_stall_action_flag (the warn-only behaviour
 * pre-dates this; the typed-throw path is the new escape hatch for
 * unattended orchestrators).
 */
export class StallDetectedDuringWaitError extends Error implements HasNextSteps {
  override readonly name = "StallDetectedDuringWaitError";
  constructor(
    public readonly taskName: string,
    public readonly owner: string | null,
    public readonly workstream: string,
    public readonly ageSecs: number,
  ) {
    const ownerBit = owner !== null ? owner : "<unknown>";
    super(
      `task ${taskName} owned by ${ownerBit} has been needs_input for ${ageSecs}s; exiting per --on-stall exit. Re-dispatch a worker or send a poke (mu agent send ${ownerBit} "...") and re-run wait.`,
    );
  }
  errorNextSteps(): NextStep[] {
    const ws = this.workstream;
    const ownerBit = this.owner !== null ? this.owner : "<owner>";
    return [
      {
        intent: "Poke the worker (often unblocks a transient stall)",
        command: `mu agent send ${ownerBit} '<retry-instruction>' -w ${ws}`,
      },
      {
        intent: "Inspect the worker's recent scrollback",
        command: `mu agent show ${ownerBit} -w ${ws} -n 60`,
      },
      {
        intent: "Release the task back to OPEN (declare the stall terminal)",
        command: `mu task release ${this.taskName} --reopen -w ${ws}`,
      },
      {
        intent: "Inspect the task's current state",
        command: `mu task show ${this.taskName} -w ${ws}`,
      },
    ];
  }
}

export class CrossWorkstreamEdgeError extends Error implements HasNextSteps {
  override readonly name = "CrossWorkstreamEdgeError";
  constructor(
    public readonly blocker: string,
    public readonly blockerWorkstream: string,
    public readonly dependent: string,
    public readonly dependentWorkstream: string,
  ) {
    super(
      `cross-workstream edge: blocker '${blocker}' is in workstream '${blockerWorkstream}', dependent '${dependent}' is in workstream '${dependentWorkstream}'`,
    );
  }
  errorNextSteps(): NextStep[] {
    // schema v5+: tasks.workstream_id is an INTEGER FK to
    // workstreams.id (no tasks.workstream column), and (workstream_id,
    // local_id) is the per-workstream unique key — so the move-blocker
    // recipe must scope by BOTH the source workstream's id AND set the
    // destination workstream's id via subselects. The v4-shaped
    // `UPDATE tasks SET workstream='…' WHERE local_id='…'` recipe we
    // used to print here errored at runtime ("no such column:
    // workstream") and was also ambiguous across workstreams.
    //
    // We also dropped the "rename one workstream to the other" hint:
    // it silently moves *every* task in the source workstream and
    // fails outright when the destination name already exists
    // (UNIQUE violation). Operators almost always want to move just
    // the blocker — or duplicate it — not merge whole workstreams.
    return [
      {
        intent: "Move the blocker into the dependent's workstream",
        command: `mu sql "UPDATE tasks SET workstream_id=(SELECT id FROM workstreams WHERE name='${this.dependentWorkstream}') WHERE local_id='${this.blocker}' AND workstream_id=(SELECT id FROM workstreams WHERE name='${this.blockerWorkstream}')"`,
      },
      {
        intent: "Or duplicate the blocker (typed verb deferred)",
        command: `mu task add <new-id> -w ${this.dependentWorkstream} --title "<copy of ${this.blocker}>" --impact <n> --effort-days <n>`,
      },
    ];
  }
}
