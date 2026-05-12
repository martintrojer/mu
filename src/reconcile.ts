// mu — the canonical "reality wins" reconciliation routine.
//
// Three steps, in order:
//
//   1. Prune ghost rows whose pane no longer exists in tmux.
//   2. Detect status from pane scrollback for surviving agents.
//   3. Surface orphan panes that look like agents but have no DB row.
//      Do NOT auto-adopt — `mu list` shows orphans under a separate
//      section and the user runs `mu agent adopt` (roadmap) to formally claim.
//
// `mu list` and `mu doctor` both call this. It's the only place where
// the registry's view of the world is reconciled against tmux's view.

import {
  type AgentRow,
  deleteAgent,
  isPendingPaneId,
  listAgents,
  refreshAgentTitle,
  resolveCliCommand,
  shouldOverwriteAgentStatus,
  updateAgentStatus,
} from "./agents.js";
import type { Db } from "./db.js";
import { detectPiStatus } from "./detect.js";
import { type TmuxPane, capturePane, listPanesInSession } from "./tmux.js";

/**
 * What kind of reconciliation pass to run.
 *
 *   "full"        Default for `mu agent list`. Prunes ghosts (deleting
 *                 the registry row, which fires the deleteAgent reaper
 *                 that flips IN_PROGRESS tasks back to OPEN with
 *                 [reaper] notes), runs status detection against
 *                 surviving panes, surfaces orphans.
 *
 *   "status-only" The "freshen the operator's view" mode. Runs status
 *                 detection (DB writes that update agent status +
 *                 pane title — desired side-effects of a refresh) and
 *                 orphan surface. Does NOT prune (so a dead pane's
 *                 row stays visible until a real `mu agent list`) and
 *                 does NOT reap. Used by `mu state`, bare `mu`, and
 *                 `mu agent attach` — the verbs an operator polls to
 *                 answer "is worker-X busy or idle right
 *                 now?". Status detection skips placeholder agents
 *                 whose pane id starts with `%pending-` (mid-spawn,
 *                 no usable scrollback yet).
 *
 *   "report-only" Pure observation. Counts would-be-pruned ghosts
 *                 without deleting; skips status detection entirely
 *                 (no DB writes, no tmux title writes); surfaces
 *                 orphans (pure read). Used by `mu undo` (the
 *                 post-restore pass MUST NOT delete rows the snapshot
 *                 just restored — see
 *                 snap_undo_reconcile_destroys_recovered_agents) and
 *                 `mu doctor` (read-only diagnostic).
 *
 * Surfaced live by bug_pane_title_glyph_stuck_at_needs_input: the
 * old `dryRun: boolean` flag conflated "don't prune" with "don't
 * detect status", so state-card pollers showed stale status
 * indefinitely. Splitting prune-suppression from status-suppression
 * is the fix.
 */
export type ReconcileMode = "full" | "status-only" | "report-only";

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
   * Which kind of pass to run. Default is `"full"` (the documented
   * mutating behaviour `mu agent list` has always had). See
   * `ReconcileMode` for the full per-mode contract.
   *
   * BREAKING: this replaces the previous `dryRun?: boolean` flag.
   * Migration: `dryRun: true` → `mode: "report-only"`; default
   * (`dryRun: false` / unset) → `mode: "full"`.
   */
  mode?: ReconcileMode;
}

export interface ReconcileReport {
  /** Number of registry rows whose pane was gone. In status-only and
   *  report-only modes this is the count of rows that WOULD have
   *  been pruned; in `full` mode it's the count actually deleted. */
  prunedGhosts: number;
  /** Number of agents whose status was changed by scrollback detection.
   *  Always 0 in `report-only` mode (status detection is skipped). */
  statusChanges: number;
  /** Panes in the workstream's tmux session that look like agents but
   *  aren't in the registry. NOT auto-adopted. */
  orphans: TmuxPane[];
  /** Which mode this report was generated in. Lets callers switch their
   *  output text ("agents pruned" vs "would-be-pruned (suppressed)")
   *  without re-deriving from options. */
  mode: ReconcileMode;
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
  const mode: ReconcileMode = opts.mode ?? "full";
  const dbAgents = listAgents(db, { workstream: opts.workstream });
  const tmuxPanes = await listPanesInSession(sessionName);
  const tmuxByPaneId = new Map(tmuxPanes.map((p) => [p.paneId, p]));

  let prunedGhosts = 0;
  let statusChanges = 0;
  const orphans: TmuxPane[] = [];

  // 1. Prune ghosts (DB row references a pane that no longer exists).
  //    Only `full` mode actually deletes; `status-only` and
  //    `report-only` count the would-be-prunes so callers can surface
  //    drift, but leave the row in place. The orphan-surface step
  //    always treats them as "not-in-tmux" so the orphan list
  //    semantics don't change.
  const survivors: AgentRow[] = [];
  for (const agent of dbAgents) {
    if (tmuxByPaneId.has(agent.paneId)) {
      survivors.push(agent);
    } else {
      if (mode === "full") deleteAgent(db, agent.name, agent.workstreamName);
      prunedGhosts++;
    }
  }

  // 2. Detect status from scrollback for survivors. capturePane uses the
  //    last 100 lines, which is the same window the detector operates on.
  //
  //    `report-only` skips this entirely — status detection writes to
  //    the DB (updateAgentStatus + refreshAgentTitle), and the
  //    report-only contract is "no mutation".
  //
  //    `status-only` runs detection but skips placeholder agents
  //    whose pane id starts with `%pending-` — those have no usable
  //    scrollback yet (mid-spawn) and the placeholder pane id won't
  //    resolve to a real tmux pane anyway. The pending sentinel is
  //    documented in src/agents.ts (PENDING_PANE_PREFIX). Without
  //    this skip, status-only would still try to capturePane on a
  //    fake id and tmux would error.
  if (mode !== "report-only") {
    for (const agent of survivors) {
      if (isPendingPaneId(agent.paneId)) continue;
      const scrollback = await capturePane(agent.paneId, { lines: 100 });
      const detected = detectPiStatus(scrollback);
      if (shouldOverwriteAgentStatus(agent.status, detected) && detected !== agent.status) {
        updateAgentStatus(db, agent.name, detected, agent.workstreamName);
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
      await refreshAgentTitle(db, agent.name, agent.workstreamName);
    }
  }

  // 3. Surface orphan panes. `looksLikeAgentPane` is conservative:
  //    pane.command must be one we recognise as an agent CLI. A bash
  //    pane the user spawned for their own use is never an orphan.
  //    Pure read; runs in every mode.
  const dbPaneIds = new Set(survivors.map((a) => a.paneId));
  for (const pane of tmuxPanes) {
    if (dbPaneIds.has(pane.paneId)) continue;
    if (looksLikeAgentPane(pane)) orphans.push(pane);
  }

  return { prunedGhosts, statusChanges, orphans, mode };
}

function looksLikeAgentPane(pane: TmuxPane): boolean {
  return knownAgentCommands().has(pane.command);
}
