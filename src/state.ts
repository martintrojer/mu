// SDK seam for `mu state` (static) and the interactive TUI.
//
// Both renderers (the legacy cli-table3-based static fallback in
// src/cli/state.ts and the new ink-based TUI in src/cli/tui/) consume
// the same WorkstreamSnapshot. Pure data + a few small derivation
// helpers — no rendering. See design_sdk_seam in workstream `tui` for
// the rationale (`mu task notes design_sdk_seam -w tui`).

import { type AgentRow, type AgentStatus, type LiveAgentsView, listLiveAgents } from "./agents.js";
import type { Db } from "./db.js";
import { type DoctorSummary, loadDoctorSummary } from "./doctor-summary.js";
import { type LogRow, listLogs } from "./logs.js";
import {
  type TaskRow,
  listBlocked,
  listInProgress,
  listReady,
  listRecentClosed,
  listTasks,
  listTasksByOwner,
} from "./tasks.js";
import { type Track, getParallelTracks } from "./tracks.js";
import { type CommitSummary, type VcsBackendName, detectBackend } from "./vcs.js";
import {
  type WorkspaceOrphan,
  type WorkspaceRow,
  decorateWithDirty,
  decorateWithStaleness,
  listWorkspaceOrphans,
  listWorkspaces,
} from "./workspace.js";

// ─── WorkstreamSnapshot ───────────────────────────────────────────

export interface WorkstreamSnapshot {
  workstreamName: string;
  view: LiveAgentsView;
  tracks: Track[];
  ready: TaskRow[];
  inProgress: TaskRow[];
  blocked: TaskRow[];
  recentClosed: TaskRow[];
  /** Populated only when callers explicitly pass `withAllTasks: true`.
   *  The TUI dashboard fast tick leaves this empty and the all-tasks
   *  popup reads its exhaustive list directly from SQLite while open. */
  allTasks: TaskRow[];
  workspaces: WorkspaceRow[];
  workspaceOrphans: WorkspaceOrphan[];
  recent: LogRow[];
  /** Last N commits from the project root (process.cwd()), populated
   *  when `loadWorkstreamSnapshot` is called with withRecentCommits.
   *  This is intentionally NOT a per-agent workspace log. */
  recentCommits: CommitSummary[];
  /** Backend that produced recentCommits. Null when recent commits were
   *  not requested or no VCS backend was detected. */
  commitsBackend?: VcsBackendName | null;
  /** Populated when `loadWorkstreamSnapshot` is called with
   *  `withDoctor: true`. Used by the TUI's slot-9 Doctor card to
   *  render a glanceable health badge on the dashboard
   *  (feat_card_9_doctor, workstream `tui-impl`). The static `mu
   *  state` card and `mu doctor` itself don't consume it — they
   *  read the textual doctor card directly. Null when not requested. */
  doctor: DoctorSummary | null;
}

export interface LoadWorkstreamSnapshotOptions {
  /** Recent-events cap (default 200). */
  eventLimit?: number;
  /** When true, slow snapshot loading also populates `WorkspaceRow.dirty`
   *  via decorateWithDirty (one `git status --porcelain` shellout per row,
   *  capped at DECORATE_CONCURRENCY). The TUI caches this slow-tier value
   *  and merges it into every fast SQL tick. */
  withDirty?: boolean;
  /** When true, slow snapshot loading also populates
   *  `WorkstreamSnapshot.doctor` via `loadDoctorSummary`. The summary is
   *  cheap SQL, but it reports tmux/workspace drift from slow-tier fields,
   *  so the TUI refreshes it with the subprocess tier. */
  withDoctor?: boolean;
  /** Optional full task list for the TUI all-tasks popup. */
  withAllTasks?: true;
  /** Optional recent-project-commits slice for the TUI Commits card /
   *  popup. Uses process.cwd() as the project root on purpose: the TUI
   *  is launched from the project checkout, while worker workspaces live
   *  elsewhere under the mu state dir. */
  withRecentCommits?: { limit: number };
}

export interface WorkstreamSnapshotSlowFields {
  view: LiveAgentsView;
  /** Workspace rows decorated with slow-tier VCS observations
   *  (`commitsBehindMain`, and `dirty` when requested). */
  workspaces: WorkspaceRow[];
  recentCommits: CommitSummary[];
  commitsBackend?: VcsBackendName | null;
  doctor: DoctorSummary | null;
}

/**
 * Fast TUI/state snapshot tier: pure SQLite reads only. Subprocess-backed
 * fields are intentionally empty placeholders so callers can merge the last
 * slow-tier values without blocking a 1s render tick on tmux or VCS probes.
 */
export async function loadWorkstreamSnapshotFast(
  db: Db,
  workstream: string,
  opts: LoadWorkstreamSnapshotOptions = {},
): Promise<WorkstreamSnapshot> {
  const eventLimit = opts.eventLimit ?? 200;
  return {
    workstreamName: workstream,
    view: emptyLiveAgentsView(),
    tracks: getParallelTracks(db, workstream),
    ready: listReady(db, workstream).sort(byRoiDesc),
    inProgress: listInProgress(db, workstream),
    blocked: listBlocked(db, workstream),
    recentClosed: listRecentClosed(db, workstream),
    allTasks: opts.withAllTasks === true ? listTasks(db, workstream) : [],
    workspaces: listWorkspaces(db, workstream),
    workspaceOrphans: listWorkspaceOrphans(db, workstream),
    recent: listLogs(db, { workstream, kind: "event", limit: eventLimit }),
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
}

/**
 * Slow snapshot tier: fields backed by tmux / VCS subprocess probes (plus
 * doctor, which reports over those slow-tier observations). Returns only the
 * fields the fast snapshot deliberately leaves empty or undecorated.
 *
 * status-only refresh: don't prune mid-spawn placeholders or reap
 * unreachable agents — every render-mode is a polling read surface.
 */
export async function loadWorkstreamSnapshotSlow(
  db: Db,
  workstream: string,
  opts: LoadWorkstreamSnapshotOptions = {},
  baseSnapshot?: WorkstreamSnapshot,
): Promise<WorkstreamSnapshotSlowFields> {
  const view = await listLiveAgents(db, { workstream, mode: "status-only" });
  let workspaces = listWorkspaces(db, workstream);
  if (opts.withDirty === true) workspaces = await decorateWithDirty(workspaces);
  const commits = await loadRecentCommits(opts.withRecentCommits);
  const slow: WorkstreamSnapshotSlowFields = {
    view,
    workspaces,
    recentCommits: commits.items,
    commitsBackend: commits.backend,
    doctor: null,
  };
  if (opts.withDoctor === true) {
    slow.doctor = loadDoctorSummary(
      db,
      mergeSnapshotFastSlow(baseSnapshot ?? minimalSnapshot(workstream), slow),
    );
  }
  return slow;
}

/** Merge the latest slow-tier subprocess observations into a fresh fast tier. */
export function mergeSnapshotFastSlow(
  fast: WorkstreamSnapshot,
  slow: WorkstreamSnapshotSlowFields | null,
): WorkstreamSnapshot {
  if (slow === null) return fast;
  return {
    ...fast,
    view: slow.view,
    workspaces: mergeWorkspaceSlowFields(fast.workspaces, slow.workspaces),
    recentCommits: slow.recentCommits,
    commitsBackend: slow.commitsBackend ?? null,
    doctor: slow.doctor,
  };
}

/**
 * Back-compat wrapper for non-TUI callers: return the historical union shape
 * by composing the new fast SQL tier with one slow subprocess tier.
 */
export async function loadWorkstreamSnapshot(
  db: Db,
  workstream: string,
  opts: LoadWorkstreamSnapshotOptions = {},
): Promise<WorkstreamSnapshot> {
  const fast = await loadWorkstreamSnapshotFast(db, workstream, opts);
  const fastWithStaleness: WorkstreamSnapshot = {
    ...fast,
    workspaces: await decorateWithStaleness(fast.workspaces),
  };
  const slow = await loadWorkstreamSnapshotSlow(db, workstream, opts, fastWithStaleness);
  return mergeSnapshotFastSlow(fastWithStaleness, slow);
}

function emptyLiveAgentsView(): LiveAgentsView {
  return {
    agents: [],
    orphans: [],
    report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
  };
}

function minimalSnapshot(workstream: string): WorkstreamSnapshot {
  return {
    workstreamName: workstream,
    view: emptyLiveAgentsView(),
    tracks: [],
    ready: [],
    inProgress: [],
    blocked: [],
    recentClosed: [],
    allTasks: [],
    workspaces: [],
    workspaceOrphans: [],
    recent: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
}

function mergeWorkspaceSlowFields(
  fastRows: readonly WorkspaceRow[],
  slowRows: readonly WorkspaceRow[],
): WorkspaceRow[] {
  const slowByAgent = new Map(slowRows.map((row) => [row.agentName, row]));
  return fastRows.map((fast) => {
    const slow = slowByAgent.get(fast.agentName);
    if (slow === undefined) return fast;
    return {
      ...fast,
      commitsBehindMain: slow.commitsBehindMain ?? fast.commitsBehindMain,
      dirty: slow.dirty,
    };
  });
}

async function loadRecentCommits(
  opt: LoadWorkstreamSnapshotOptions["withRecentCommits"],
): Promise<{ backend: VcsBackendName | null; items: CommitSummary[] }> {
  if (opt === undefined) return { backend: null, items: [] };
  const projectRoot = process.cwd();
  const backend = await detectBackend(projectRoot);
  if (backend.name === "none") return { backend: null, items: [] };
  return { backend: backend.name, items: await backend.recentCommits(projectRoot, opt.limit) };
}

// ─── ROI helpers ───────────────────────────────────────────────────

/**
 * ROI tiers used to colour task rows. Pure: returns the bucket name; the
 * consumer maps bucket → picocolors function (or ink text colour).
 * Magic numbers (≥100 high, ≥50 mid) lifted from the previous HUD impl.
 */
export type RoiBucket = "high" | "mid" | "low" | "infinite";

export function roiBucket(impact: number, effortDays: number): RoiBucket {
  const r = effortDays > 0 ? impact / effortDays : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(r)) return "infinite";
  if (r >= 100) return "high";
  if (r >= 50) return "mid";
  return "low";
}

/** ROI sort comparator (descending). Used by loadWorkstreamSnapshot.ready. */
function byRoiDesc(a: TaskRow, b: TaskRow): number {
  const ra = a.effortDays > 0 ? a.impact / a.effortDays : Number.POSITIVE_INFINITY;
  const rb = b.effortDays > 0 ? b.impact / b.effortDays : Number.POSITIVE_INFINITY;
  if (rb !== ra) return rb - ra;
  if (a.effortDays !== b.effortDays) return a.effortDays - b.effortDays;
  return a.name.localeCompare(b.name);
}

// ─── Agent helpers ─────────────────────────────────────────────────

/** Histogram of agents by status. Pure derivation (no colour render). */
export function agentStatusHistogram(
  agents: readonly AgentRow[],
): ReadonlyMap<AgentStatus, number> {
  const out = new Map<AgentStatus, number>();
  for (const a of agents) {
    out.set(a.status, (out.get(a.status) ?? 0) + 1);
  }
  return out;
}

// ─── Task helpers ──────────────────────────────────────────────────

export interface OwnedTasksSummary {
  /** Display token: "—" (none) | "<task_id>" (one) | "⊕<N>" (many). */
  bit: string;
  /** Underlying count for callers that want their own format. */
  count: number;
  /** The single owned task's local id, when count===1. */
  onlyTaskId?: string;
}

/**
 * Per-agent task summary: condensed display token + raw count. Used by
 * both the static Agents table and the ink Agents card. Pure on the
 * input rows — caller (e.g. loadWorkstreamSnapshot consumer) does the
 * listTasksByOwner query upstream and feeds the rows in.
 */
export function summarizeOwnedTasks(owned: readonly TaskRow[]): OwnedTasksSummary {
  const count = owned.length;
  if (count === 0) return { bit: "—", count: 0 };
  if (count === 1) {
    const only = owned[0];
    if (!only) return { bit: "—", count: 0 };
    return { bit: only.name, count: 1, onlyTaskId: only.name };
  }
  return { bit: `⊕${count}`, count };
}

// Re-export for convenience: callers wanting to combine listTasksByOwner
// with summarizeOwnedTasks in one import.
export { listTasksByOwner };
