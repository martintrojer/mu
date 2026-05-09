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
import { sanitiseTaskId } from "../tasks.js";

export class TaskNotFoundError extends Error implements HasNextSteps {
  override readonly name = "TaskNotFoundError";
  constructor(public readonly taskId: string) {
    super(`no such task: ${taskId}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List tasks in workstream", command: "mu task list -w <workstream>" },
      {
        intent: "Search by substring (id + title)",
        command: `mu task search ${this.taskId} --all`,
      },
      { intent: "Find which workstream owns it", command: `mu task search ${this.taskId} --all` },
    ];
  }
}

/**
 * Thrown by `addTask` when `localId` violates the id rules — either
 * the reserved `mu_` prefix or the schema regex
 * `/^[a-z][a-z0-9_-]{0,63}$/`. Replaces a bare `TypeError` so the
 * CLI's `handle()` wrapper can map it to exit code 4 (validation /
 * conflict) and surface a `--json` `nextSteps` block pointing at
 * the auto-derived-id workflow and a sanitised candidate.
 */
export class TaskIdInvalidError extends Error implements HasNextSteps {
  override readonly name = "TaskIdInvalidError";
  constructor(
    public readonly attempted: string,
    public readonly reason: "reserved-prefix" | "syntax",
  ) {
    const detail =
      reason === "reserved-prefix"
        ? 'the "mu_" prefix is reserved for system-generated IDs'
        : "expected /^[a-z][a-z0-9_-]{0,63}$/";
    super(`invalid task id: ${JSON.stringify(attempted)} (${detail})`);
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
        command: `mu task unblock <dep> --not-blocked-by ${this.taskId}`,
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
 * steps (run `mu adopt <pane-id>` to register, or use --for to pick a
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
   *   3. mu adopt: registration pattern (promote pane to worker)
   */
  errorNextSteps(): NextStep[] {
    const steps: NextStep[] = [
      { intent: "Work directly (anonymous)", command: "mu task claim <id> --self" },
      { intent: "Dispatch to a worker", command: "mu task claim <id> --for <worker>" },
    ];
    steps.push(
      this.paneId !== null
        ? { intent: "Register this pane", command: `mu adopt ${this.paneId}` }
        : {
            intent: "Register a pane",
            command: "mu adopt <pane-id>  (must be in mu-<workstream> tmux session)",
          },
    );
    return steps;
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
    return [
      {
        intent: "Move the blocker into the dependent's workstream",
        command: `mu sql "UPDATE tasks SET workstream='${this.dependentWorkstream}' WHERE local_id='${this.blocker}'"`,
      },
      {
        intent: "Or merge the two workstreams (rename one to the other)",
        command: `mu sql "UPDATE workstreams SET name='${this.dependentWorkstream}' WHERE name='${this.blockerWorkstream}'"`,
      },
      {
        intent: "Or duplicate the blocker (typed verb deferred)",
        command: `mu task add <new-id> -w ${this.dependentWorkstream} --title "<copy of ${this.blocker}>" --impact <n> --effort-days <n>`,
      },
    ];
  }
}
