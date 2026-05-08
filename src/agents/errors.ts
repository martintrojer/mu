// mu — agent error classes.
//
// Every agent verb that can fail in a typed way has its own error class
// here. The CLI's classifyError() (src/cli.ts) maps them to exit codes:
//   not found  → 3   (AgentNotFoundError)
//   conflict   → 4   (AgentExistsError, AgentNotInWorkstreamError,
//                     AgentDiedOnSpawnError, WorkspacePreservedError)
//
// AgentDiedOnSpawnError reaches into spawn.ts for defaultSpawnLivenessMs
// — a single, narrow cross-cluster import that documents itself in the
// error message ("agent died within Nms of spawn").
//
// Extracted from src/agents.ts as part of refactor_split_large_src_files.

import type { HasNextSteps, NextStep } from "../output.js";
import { defaultSpawnLivenessMs } from "./spawn.js";

export class AgentExistsError extends Error implements HasNextSteps {
  override readonly name = "AgentExistsError";
  constructor(public readonly agentName: string) {
    super(
      `agent already exists: ${agentName} (agent names are globally unique across workstreams)`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Find which workstream the existing agent is in",
        command: `mu sql "SELECT name, workstream FROM agents WHERE name='${this.agentName}'"`,
      },
      {
        intent: "Close the existing agent and re-spawn",
        command: `mu agent close ${this.agentName}  &&  mu agent spawn ${this.agentName} -w <workstream>`,
      },
      { intent: "Pick a different name", command: "mu agent spawn <new-name> -w <workstream>" },
    ];
  }
}

export class AgentNotFoundError extends Error implements HasNextSteps {
  override readonly name = "AgentNotFoundError";
  constructor(public readonly agentName: string) {
    super(`no such agent: ${agentName}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List agents in current workstream", command: "mu agent list" },
      { intent: "List agents across ALL workstreams", command: "mu agent list -w *" },
      {
        intent: "Spawn it now",
        command: `mu agent spawn ${this.agentName} -w <workstream>`,
      },
    ];
  }
}

/**
 * Thrown when an entity-targeted verb is invoked with `-w/--workstream
 * <name>` but the named agent lives in a different workstream.
 * Mirrors `TaskNotInWorkstreamError`. Maps to exit code 4 (conflict /
 * wrong scope). Distinguishes "the user typo'd the workstream" from
 * "the agent doesn't exist anywhere" (which surfaces as
 * `AgentNotFoundError`).
 */
export class AgentNotInWorkstreamError extends Error implements HasNextSteps {
  override readonly name = "AgentNotInWorkstreamError";
  constructor(
    public readonly agentName: string,
    public readonly expectedWorkstream: string,
    public readonly actualWorkstream: string,
  ) {
    super(`agent ${agentName} is in workstream ${actualWorkstream}, not ${expectedWorkstream}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Use the agent's actual workstream",
        command: `mu agent show ${this.agentName} -w ${this.actualWorkstream}`,
      },
      {
        intent: "List agents in the requested workstream",
        command: `mu agent list -w ${this.expectedWorkstream}`,
      },
    ];
  }
}

/**
 * Thrown when an agent's pane is created and titled successfully but the
 * spawned process exits within the liveness window (default 1500ms;
 * configurable via `MU_SPAWN_LIVENESS_MS`). The most common cause is the
 * underlying CLI failing fast: a wrapper CLI blocking on a single-instance
 * lock, `claude` rejecting an invalid API key, etc. The agent's last
 * scrollback (when capturable) is attached to help diagnose.
 */
export class AgentDiedOnSpawnError extends Error implements HasNextSteps {
  override readonly name = "AgentDiedOnSpawnError";
  constructor(
    public readonly agentName: string,
    public readonly paneId: string,
    public readonly scrollback: string | undefined,
  ) {
    const tail = scrollback?.trim();
    const detail = tail ? `\n\n--- pane scrollback ---\n${tail}\n--- end scrollback ---` : "";
    super(
      `agent ${agentName} died within ${defaultSpawnLivenessMs()}ms of spawn (pane ${paneId}). Most common cause: the spawned CLI exited immediately (e.g. a wrapper CLI blocking on its instance lock; set MU_<UPPER_CLI>_COMMAND to a non-blocking variant to bypass).${detail}`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Inspect the dead pane's scrollback for the underlying error",
        command: `mu agent read ${this.agentName} -n 100`,
      },
      {
        intent: "Override the spawn command to a non-blocking variant",
        command: 'export MU_PI_COMMAND="pi-alt --some-flag"   (or pass --command "..." to spawn)',
      },
      {
        intent: "Disable the liveness check (CI / known long-lived sh subprocess)",
        command: "export MU_SPAWN_LIVENESS_MS=0",
      },
      { intent: "Run health check", command: "mu doctor" },
    ];
  }
}

/**
 * Thrown when `closeAgent` is called on an agent that has an associated
 * workspace AND the caller didn't explicitly opt into discarding it.
 *
 * Background: the FK on `vcs_workspaces.agent` cascades on agent
 * delete, so a naive `closeAgent` drops the workspace registry row
 * but leaves the on-disk dir orphaned (mu can't see it via
 * `mu workspace list / free / path` afterwards). Surfaced during
 * the multi-agent dogfood teardown when three workspaces went
 * orphaned silently.
 *
 * The fix: refuse close if a workspace exists; force the caller to
 * decide. Two actionable resolutions:
 *   - `mu workspace free <agent>` first, then close cleanly.
 *   - `mu agent close <agent> --discard-workspace` to free the
 *     workspace AND close the agent in one shot (lossy: pending
 *     changes in the workspace are gone).
 *
 * Maps to exit code 4 (conflict) via the cli.ts handler.
 */
export class WorkspacePreservedError extends Error implements HasNextSteps {
  override readonly name = "WorkspacePreservedError";
  constructor(
    public readonly agentName: string,
    public readonly workspacePath: string,
  ) {
    super(
      `agent ${agentName} has a workspace at ${workspacePath}; refusing to close (would orphan the on-disk dir)`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Free the workspace first (preserves agent for next step)",
        command: `mu workspace free ${this.agentName}  (--commit to commit pending changes first)`,
      },
      {
        intent: "Or close + discard the workspace in one shot (lossy)",
        command: `mu agent close ${this.agentName} --discard-workspace`,
      },
      {
        intent: "Or just inspect what's in the workspace",
        command: `cd ${this.workspacePath}`,
      },
    ];
  }
}
