// mu — agent error classes.
//
// Every agent verb that can fail in a typed way has its own error class
// here. The CLI's classifyError() (src/cli.ts) maps them to exit codes:
//   not found  → 3   (AgentNotFoundError)
//   conflict   → 4   (AgentExistsError, AgentNotInWorkstreamError,
//                     AgentDiedOnSpawnError, AgentSpawnStartupError,
//                     WorkspacePreservedError)
//
// AgentDiedOnSpawnError + AgentSpawnStartupError reach into spawn.ts for
// defaultSpawnLivenessMs — a single, narrow cross-cluster import that
// documents itself in the error message ("agent died within Nms of
// spawn" / "agent reported a startup error within Nms of spawn").
//
// AgentSpawnCliNotFoundError is the pre-flight cousin of the two
// post-spawn-detect errors above: thrown BEFORE prestageWorkspace when
// the resolved `--cli` command's first token doesn't exist on PATH.
// Distinct from AgentSpawnStartupError so the operator can tell
// 'I never had a working CLI' from 'CLI started but parked at an error'.
//
// Extracted from src/agents.ts as part of refactor_split_large_src_files.

import type { HasNextSteps, NextStep } from "../output.js";
import { defaultSpawnLivenessMs } from "./spawn.js";

/**
 * Pre-flight failure: the command mu would have spawned in the new
 * pane doesn't resolve to a binary on PATH (and isn't an absolute /
 * relative path that exists + is executable). Thrown by `spawnAgent`
 * BEFORE `prestageWorkspace` so a typo in `--cli` never leaves an
 * orphan workspace dir behind.
 *
 * Source: feedback ws task `fb_agent_spawn_no_validation`. Live
 * dogfood report: `mu agent spawn worker-1 --cli pi-meta` on a host
 * where the `pi-meta` binary wasn't on PATH printed `Spawned worker-1
 * (pi-meta)` and the pane immediately died with `command not found`;
 * the existing 1.5s liveness check sometimes missed it (the shell
 * stays alive after the failed exec). Pre-flighting the PATH lookup
 * surfaces the typo before any side effects (workspace, pane, DB row).
 *
 * Distinct from `AgentSpawnStartupError` (pane alive but parked at an
 * error prompt) and `AgentDiedOnSpawnError` (pane vanished within the
 * liveness window). All three carry different remediation hints, so
 * they're separate types.
 */
export class AgentSpawnCliNotFoundError extends Error implements HasNextSteps {
  override readonly name = "AgentSpawnCliNotFoundError";
  constructor(
    public readonly cli: string,
    /** First whitespace-separated token of the resolved command — the
     *  thing actually missing on PATH. Surfaced verbatim in the
     *  message so the operator sees what mu searched for (which may
     *  differ from `cli` when `$MU_<UPPER_CLI>_COMMAND` rewrites it). */
    public readonly binary: string,
    /** Name of the env var that mu consulted before falling back to
     *  the bare `cli` value (e.g. `MU_PI_META_COMMAND`). Always set
     *  to the conventional name so the nextSteps hint can recommend
     *  exporting it. */
    public readonly envVarChecked: string,
  ) {
    super(
      `--cli ${cli} resolved to binary "${binary}" which is not on PATH (and not an executable absolute/relative path). Refusing to spawn — would create a pane that dies immediately on "command not found".`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Try the default CLI (the one mu's substrate ships against)",
        command: "mu agent spawn <name> --cli pi",
      },
      {
        intent: "If you meant a custom alias, set the env var to its real path",
        command: `export ${this.envVarChecked}="<absolute-path-to-binary> [args...]"`,
      },
      {
        intent: "List installed CLIs typically supported by mu",
        command: "which pi pi-meta claude codex",
      },
    ];
  }
}

export class AgentExistsError extends Error implements HasNextSteps {
  override readonly name = "AgentExistsError";
  constructor(public readonly agentName: string) {
    // v5: agent names are UNIQUE per (workstream, name) — the same
    // name can legitimately exist in two different workstreams. The
    // pre-v5 message claimed global uniqueness, which (a) lied about
    // the schema and (b) misled operators into closing the existing
    // agent when the actual fix is `-w <other-ws>`.
    super(`agent already exists in this workstream: ${agentName}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        // v5: agents.workstream_id → workstreams.id; there is no
        // `agents.workstream` column. Use the join so this hint
        // actually runs against a v5 DB.
        intent: "List which workstream(s) already have an agent by this name",
        command: `mu sql "SELECT a.name, ws.name AS workstream FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.name = '${this.agentName}'"`,
      },
      {
        intent: "Spawn it in a different workstream (per-workstream unique → no clash)",
        command: `mu agent spawn ${this.agentName} -w <other-workstream>`,
      },
      {
        intent: "Or close the existing agent in this workstream and re-spawn",
        command: `mu agent close ${this.agentName}  &&  mu agent spawn ${this.agentName}`,
      },
      { intent: "Or pick a different name", command: "mu agent spawn <new-name>" },
    ];
  }
}

export class AgentNotFoundError extends Error implements HasNextSteps {
  override readonly name = "AgentNotFoundError";
  constructor(
    public readonly agentName: string,
    /** Optional workstream context. When set, the message is enriched
     *  with `(in workstream <ws>)` so the verb that hit the miss
     *  (e.g. `mu workspace create <agent> -w <ws>`) doesn't leave the
     *  operator guessing which scope was searched. Optional so existing
     *  call sites that only know the agent name keep their original
     *  one-line message. */
    public readonly workstream?: string,
  ) {
    super(
      workstream === undefined
        ? `no such agent: ${agentName}`
        : `no such agent: ${agentName} (in workstream ${workstream})`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List agents in current workstream", command: "mu agent list" },
      { intent: "List workstreams to choose the right scope", command: "mu workstream list" },
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
        // agent_spawn_liveness_check_trips_on: per-spawn override is
        // the right scope for one-offs (e.g. wrapper CLIs blocking
        // on a per-project solo lock). Listed first so operators
        // reach for it before exporting an env var that leaks into
        // every subsequent spawn in the shell.
        intent: "Override per spawn (one-off; no env-var leak)",
        command: `mu agent spawn ${this.agentName} --command "<cli> <bypass-flag>"   (e.g. pi-meta --no-solo)`,
      },
      {
        intent:
          "Make the override the default for this CLI (applies to every subsequent spawn in this shell)",
        command: 'export MU_PI_COMMAND="pi-alt --some-flag"',
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
 * Thrown when an agent's pane is alive AND staying alive after the
 * liveness window, but its first burst of output matches a known
 * provider-startup-failure pattern (missing API key, auth rejected, …).
 * Source: feedback ws task `agent_spawn_model_auth_failure_counts_as_live`.
 * Live dogfood report: `pi-meta --no-solo --model sonnet:high` printed
 * `Error: No API key found for amazon-bedrock` and parked at a prompt.
 * The pane stayed alive (1.5s liveness check passed) but the worker
 * could never do work — the orchestrator only discovered this when
 * `mu task wait` stalled minutes later.
 *
 * Distinct from `AgentDiedOnSpawnError`:
 *   - `AgentDiedOnSpawnError` → pane vanished within the liveness window
 *     (CLI exited fast).
 *   - `AgentSpawnStartupError` → pane alive, but the captured scrollback
 *     tail contains a curated provider-auth-failure pattern.
 * The two carry different remediation hints (CLI override vs. fix the
 * env var), so they're separate types instead of one with a flag.
 *
 * The pattern list is curated and short to keep false-positive risk low
 * — the scan only looks at the last ~30 lines of the 50-line capture
 * taken right after the liveness sleep, so matches naturally come from
 * the CLI's first ~1.5s of output (not arbitrary later prompts the
 * agent might type into).
 */
export class AgentSpawnStartupError extends Error implements HasNextSteps {
  override readonly name = "AgentSpawnStartupError";
  constructor(
    public readonly agentName: string,
    public readonly paneId: string,
    /** The single scrollback line that matched a known startup-error
     *  pattern. Surfaced verbatim in the message so the operator sees
     *  what mu saw. */
    public readonly matchedLine: string,
    /** Full captured scrollback (tail-trimmed already by
     *  awaitSpawnLiveness). Attached to the message for context. */
    public readonly scrollback: string,
  ) {
    super(
      `agent ${agentName} reported a startup error within ${defaultSpawnLivenessMs()}ms of spawn (pane ${paneId}). The pane is alive but the spawned CLI parked at an error prompt instead of becoming a working agent.\n\nMatched line: ${matchedLine.trim()}\n\n--- pane scrollback ---\n${scrollback.trim()}\n--- end scrollback ---`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Inspect the parked pane's scrollback for the full error",
        command: `mu agent read ${this.agentName} -n 100`,
      },
      {
        // Most common today: the operator picked a model whose
        // provider has no credentials in this env. Default Anthropic
        // is the safe fallback for pi-meta.
        intent: "Re-spawn with a CLI command whose provider credentials are present",
        command: `mu agent spawn ${this.agentName} --command "pi-meta --no-solo"   # default Anthropic`,
      },
      {
        intent: "Or set the missing API key env var for the provider you wanted, then re-spawn",
        command:
          "export ANTHROPIC_API_KEY=...   # or AWS_BEARER_TOKEN_BEDROCK, OPENAI_API_KEY, ...",
      },
      {
        intent:
          "Disable the startup-error scan if you actually wanted that prompt (CI / scripted recovery)",
        command: "export MU_SPAWN_LIVENESS_MS=0",
      },
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
