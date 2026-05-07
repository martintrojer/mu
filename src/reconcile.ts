// mu — the canonical "reality wins" reconciliation routine.
//
// Three steps, in order:
//
//   1. Prune ghost rows whose pane no longer exists in tmux.
//   2. Detect status from pane scrollback for surviving agents.
//   3. Surface orphan panes that look like agents but have no DB row.
//      Do NOT auto-adopt — `mu list` shows orphans under a separate
//      section and the user runs `mu adopt` (roadmap) to formally claim.
//
// `mu list` and `mu doctor` both call this. It's the only place where
// the registry's view of the world is reconciled against tmux's view.

import {
  type AgentRow,
  type AgentStatus,
  deleteAgent,
  listAgents,
  resolveCliCommand,
  updateAgentStatus,
} from "./agents.js";
import type { Db } from "./db.js";
import { detectPiStatus } from "./detect.js";
import { type TmuxPane, capturePane, listPanesInSession } from "./tmux.js";

export interface ReconcileOptions {
  /** The workstream whose registry rows we're reconciling. */
  workstream: string;
  /**
   * Override the tmux session name. Defaults to `mu-<workstream>`. Useful
   * for tests and for the rare case where a workstream's tmux session was
   * created with a non-default name.
   */
  tmuxSession?: string;
}

export interface ReconcileReport {
  /** Number of registry rows whose pane was gone. */
  prunedGhosts: number;
  /** Number of agents whose status was changed by scrollback detection. */
  statusChanges: number;
  /** Panes in the workstream's tmux session that look like agents but
   *  aren't in the registry. NOT auto-adopted. */
  orphans: TmuxPane[];
}

/**
 * Pane commands that suggest "this is an agent, surface it as an orphan."
 * 0.1.0 scope: pi only is detected, but the orphan list will surface
 * claude/codex panes too so the user can adopt them later.
 *
 * Also includes any env-overridden binary names (e.g. `MU_PI_COMMAND=pi-alt`
 * makes "pi-alt" agent-worthy) so externally-spawned panes running the
 * user's actual pi binary are still surfaced as orphans.
 */
const BASE_AGENT_CLIS: readonly string[] = ["pi", "claude", "codex"];

function knownAgentCommands(): ReadonlySet<string> {
  const names = new Set<string>(BASE_AGENT_CLIS);
  for (const cli of BASE_AGENT_CLIS) {
    names.add(resolveCliCommand(cli));
  }
  return names;
}

export async function reconcile(db: Db, opts: ReconcileOptions): Promise<ReconcileReport> {
  const sessionName = opts.tmuxSession ?? `mu-${opts.workstream}`;
  const dbAgents = listAgents(db, { workstream: opts.workstream });
  const tmuxPanes = await listPanesInSession(sessionName);
  const tmuxByPaneId = new Map(tmuxPanes.map((p) => [p.paneId, p]));

  let prunedGhosts = 0;
  let statusChanges = 0;
  const orphans: TmuxPane[] = [];

  // 1. Prune ghosts (DB row references a pane that no longer exists).
  const survivors: AgentRow[] = [];
  for (const agent of dbAgents) {
    if (tmuxByPaneId.has(agent.paneId)) {
      survivors.push(agent);
    } else {
      deleteAgent(db, agent.name);
      prunedGhosts++;
    }
  }

  // 2. Detect status from scrollback for survivors. capturePane uses the
  //    last 100 lines, which is the same window the detector operates on.
  for (const agent of survivors) {
    const scrollback = await capturePane(agent.paneId, { lines: 100 });
    const detected = detectPiStatus(scrollback);
    if (shouldOverwrite(agent.status, detected) && detected !== agent.status) {
      updateAgentStatus(db, agent.name, detected);
      statusChanges++;
    }
  }

  // 3. Surface orphan panes. `looksLikeAgentPane` is conservative:
  //    pane.command must be one we recognise as an agent CLI. A bash
  //    pane the user spawned for their own use is never an orphan.
  const dbPaneIds = new Set(survivors.map((a) => a.paneId));
  for (const pane of tmuxPanes) {
    if (dbPaneIds.has(pane.paneId)) continue;
    if (looksLikeAgentPane(pane)) orphans.push(pane);
  }

  return { prunedGhosts, statusChanges, orphans };
}

/**
 * Decide whether a scrollback-detected status should overwrite the
 * persisted one.
 *
 * `free` is sticky until the agent shows real activity:
 *   - free + needs_input  → stay free   (user explicitly marked it free;
 *                                        idle prompt isn't activity)
 *   - free + busy         → flip to busy
 *   - free + needs_permission → flip   (a permission prompt IS activity)
 *
 * Every other persisted status is auto-derived; overwrite freely. This
 * lets `spawning → busy/needs_input/needs_permission` happen on the
 * first reconcile after spawn.
 */
function shouldOverwrite(current: AgentStatus, detected: AgentStatus): boolean {
  if (current === "free") {
    return detected === "busy" || detected === "needs_permission";
  }
  return true;
}

function looksLikeAgentPane(pane: TmuxPane): boolean {
  return knownAgentCommands().has(pane.command);
}
