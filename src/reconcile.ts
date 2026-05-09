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
  deleteAgent,
  listAgents,
  refreshAgentTitle,
  resolveCliCommand,
  shouldOverwriteAgentStatus,
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
  /**
   * Read-only mode: report drift WITHOUT mutating any row. `mu undo`
   * uses this to honour its contract ("the restore brings back the
   * snapshot's rows verbatim; reconcile reports drift but MUST NOT
   * delete a row that was just restored"). Discovered via
   * snap_undo_reconcile_destroys_recovered_agents (snap_dogfood
   * Finding 2): a `workstream destroy --yes` followed by `mu undo
   * --yes` was silently dropping the restored agent row because
   * its pane had been killed by the destroy, and the post-restore
   * reconcile then pruned the now-recovered row + cascaded its
   * vcs_workspaces row away via FK ON DELETE CASCADE.
   *
   * Effect:
   *   - prune step counts ghosts but does NOT delete them
   *     (`prunedGhosts` becomes "would-be-pruned" semantically)
   *   - status-detect step does NOT run (no scrollback capture, no
   *     title refresh, no DB writes)
   *   - orphan-surface step still runs (it's pure read)
   *
   * Default: false. `mu agent list` and `mu doctor` keep the
   * mutating behaviour they always had.
   */
  dryRun?: boolean;
}

export interface ReconcileReport {
  /** Number of registry rows whose pane was gone. In dryRun mode this
   *  is the count of rows that WOULD have been pruned; in normal
   *  mode it's the count actually deleted. */
  prunedGhosts: number;
  /** Number of agents whose status was changed by scrollback detection.
   *  Always 0 in dryRun mode (status detection is skipped). */
  statusChanges: number;
  /** Panes in the workstream's tmux session that look like agents but
   *  aren't in the registry. NOT auto-adopted. */
  orphans: TmuxPane[];
  /** True iff this report was generated in dryRun mode. Lets callers
   *  switch their output text ("agents pruned" vs "would-be-pruned
   *  (suppressed)") without re-deriving from options. */
  dryRun: boolean;
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
  const dryRun = opts.dryRun ?? false;
  const dbAgents = listAgents(db, { workstream: opts.workstream });
  const tmuxPanes = await listPanesInSession(sessionName);
  const tmuxByPaneId = new Map(tmuxPanes.map((p) => [p.paneId, p]));

  let prunedGhosts = 0;
  let statusChanges = 0;
  const orphans: TmuxPane[] = [];

  // 1. Prune ghosts (DB row references a pane that no longer exists).
  //    In dryRun mode, COUNT them but don't delete. The orphan-surface
  //    step still treats them as "not-in-tmux" so the orphan list
  //    semantics don't change.
  const survivors: AgentRow[] = [];
  for (const agent of dbAgents) {
    if (tmuxByPaneId.has(agent.paneId)) {
      survivors.push(agent);
    } else {
      if (!dryRun) deleteAgent(db, agent.name);
      prunedGhosts++;
    }
  }

  // 2. Detect status from scrollback for survivors. capturePane uses the
  //    last 100 lines, which is the same window the detector operates on.
  //    Skipped in dryRun mode — status detection writes to the DB
  //    (updateAgentStatus + refreshAgentTitle), and the dryRun contract
  //    is "no mutation".
  if (!dryRun) {
    for (const agent of survivors) {
      const scrollback = await capturePane(agent.paneId, { lines: 100 });
      const detected = detectPiStatus(scrollback);
      if (shouldOverwriteAgentStatus(agent.status, detected) && detected !== agent.status) {
        updateAgentStatus(db, agent.name, detected);
        statusChanges++;
      }
      // ALWAYS refresh the pane title (even when status didn't change),
      // so that:
      //   1. Inner CLIs that self-set their pane title (pi, pi-meta, vim,
      //      tmux's default 'host - dir') get overwritten with mu's
      //      composed title.
      //   2. Task-ownership changes that happen between reconciles
      //      (claim / release / close) re-propagate even if the status
      //      detector didn't flip.
      // Best-effort: a tmux failure here never blocks the reconcile report.
      await refreshAgentTitle(db, agent.name);
    }
  }

  // 3. Surface orphan panes. `looksLikeAgentPane` is conservative:
  //    pane.command must be one we recognise as an agent CLI. A bash
  //    pane the user spawned for their own use is never an orphan.
  //    Pure read; runs in dryRun mode too.
  const dbPaneIds = new Set(survivors.map((a) => a.paneId));
  for (const pane of tmuxPanes) {
    if (dbPaneIds.has(pane.paneId)) continue;
    if (looksLikeAgentPane(pane)) orphans.push(pane);
  }

  return { prunedGhosts, statusChanges, orphans, dryRun };
}

function looksLikeAgentPane(pane: TmuxPane): boolean {
  return knownAgentCommands().has(pane.command);
}
