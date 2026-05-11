// SDK seam for `mu state` (static) and the interactive TUI.
//
// Both renderers (the legacy cli-table3-based static fallback in
// src/cli/state.ts and the new ink-based TUI in src/cli/tui/) consume
// the same WorkstreamSnapshot. Pure data + a few small derivation
// helpers — no rendering. See design_sdk_seam in workstream `tui` for
// the rationale (`mu task notes design_sdk_seam -w tui`).

import { type AgentRow, type AgentStatus, type LiveAgentsView, listLiveAgents } from "./agents.js";
import type { Db } from "./db.js";
import { type LogRow, listLogs } from "./logs.js";
import {
  type TaskRow,
  listBlocked,
  listInProgress,
  listReady,
  listRecentClosed,
  listTasksByOwner,
} from "./tasks.js";
import { type Track, getParallelTracks } from "./tracks.js";
import {
  type WorkspaceOrphan,
  type WorkspaceRow,
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
  workspaces: WorkspaceRow[];
  workspaceOrphans: WorkspaceOrphan[];
  recent: LogRow[];
}

export interface LoadWorkstreamSnapshotOptions {
  /** Recent-events cap (default 200). */
  eventLimit?: number;
}

/**
 * One synchronous-feeling read pass over the SDK for everything `mu state`
 * (static + TUI) needs to render. Lifted from the previous private
 * loadWorkstreamData in src/cli/state.ts; behaviour preserved verbatim.
 *
 * status-only refresh: don't prune mid-spawn placeholders or reap
 * unreachable agents — every render-mode is a polling read surface.
 */
export async function loadWorkstreamSnapshot(
  db: Db,
  workstream: string,
  opts: LoadWorkstreamSnapshotOptions = {},
): Promise<WorkstreamSnapshot> {
  const eventLimit = opts.eventLimit ?? 200;
  const view = await listLiveAgents(db, { workstream, mode: "status-only" });
  const tracks = getParallelTracks(db, workstream);
  const ready = listReady(db, workstream).sort(byRoiDesc);
  const inProgress = listInProgress(db, workstream);
  const blocked = listBlocked(db, workstream);
  const recentClosed = listRecentClosed(db, workstream);
  const workspaces = await decorateWithStaleness(listWorkspaces(db, workstream));
  const workspaceOrphans = listWorkspaceOrphans(db, workstream);
  const recent = listLogs(db, { workstream, kind: "event", limit: eventLimit });
  return {
    workstreamName: workstream,
    view,
    tracks,
    ready,
    inProgress,
    blocked,
    recentClosed,
    workspaces,
    workspaceOrphans,
    recent,
  };
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
