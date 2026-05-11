// React hook + tick-rate constants for the TUI's poll loop.
//
// Per design_poll_loop (workstream `tui`): F1 simple poll, single
// setInterval owned by <Dashboard>, synchronous better-sqlite3 reads
// (no race possible by construction), tick rate adjustable live with
// +/- (floor 100ms, ceiling 10s, default 1s), no persistence.
//
// The hook pauses fetches when `enabled === false` so the dashboard
// can stop ticking while a popup is open. Popups can run their own
// fetch loops if they need data not in the dashboard snapshot.

import { useEffect, useState } from "react";
import type { Db } from "../../db.js";
import { type WorkstreamSnapshot, loadWorkstreamSnapshot } from "../../state.js";

export const TICK_DEFAULT_MS = 1000;
export const TICK_FLOOR_MS = 100;
export const TICK_CEILING_MS = 10_000;

export interface CardVisibility {
  agents: boolean;
  tracks: boolean;
  ready: boolean;
  log: boolean;
  workspaces: boolean;
  /** Card 6 — IN_PROGRESS tasks (feat_card_6_inprogress, workstream
   *  `tui-impl`). Reads snapshot.inProgress directly; no SDK extension. */
  inProgress: boolean;
  /** Card 7 — OPEN tasks with still-gating blockers (feat_card_7_blocked,
   *  workstream `tui-impl`). Reads snapshot.blocked directly; the per-row
   *  blocker counts come from getTaskEdgesWithStatus (≤8 cheap sync reads
   *  per tick). No SDK extension. */
  blocked: boolean;
  /** Card 8 — recently-CLOSED tasks (feat_card_8_recent, workstream
   *  `tui-impl`). Reads snapshot.recentClosed directly; no SDK extension. */
  recent: boolean;
}

export const DEFAULT_CARD_VISIBILITY: CardVisibility = {
  agents: true,
  tracks: true,
  ready: true,
  log: true,
  workspaces: true,
  inProgress: true,
  blocked: true,
  recent: true,
};

export interface DashboardSnapshot {
  data: WorkstreamSnapshot | null;
  lastTickMs: number;
  error: string | null;
}

/**
 * Subscribe to the workstream snapshot via a setInterval-owned poll
 * loop. Re-fetches every `tickMs` while `enabled` is true.
 */
export function useDashboardSnapshot(
  db: Db,
  workstream: string,
  tickMs: number,
  enabled: boolean,
): DashboardSnapshot {
  const [snap, setSnap] = useState<DashboardSnapshot>({
    data: null,
    lastTickMs: 0,
    error: null,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const t0 = performance.now();
      try {
        const data = await loadWorkstreamSnapshot(db, workstream, {
          eventLimit: 200,
          // Workspaces card (feat_card_5_workspaces) needs the dirty
          // marker; the cost is one `git status --porcelain` per row,
          // capped at DECORATE_CONCURRENCY in workspace.ts.
          withDirty: true,
        });
        if (cancelled) return;
        const dur = performance.now() - t0;
        setSnap({ data, lastTickMs: dur, error: null });
      } catch (err) {
        if (cancelled) return;
        setSnap((s) => ({ ...s, error: String(err) }));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), tickMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [db, workstream, tickMs, enabled]);

  return snap;
}

/** Clamp a desired tick rate to [floor, ceiling]. */
export function clampTick(ms: number): number {
  return Math.max(TICK_FLOOR_MS, Math.min(TICK_CEILING_MS, ms));
}

/** Compute the next-faster tick (halve, floor 100ms). */
export function fasterTick(current: number): number {
  return clampTick(Math.floor(current / 2));
}

/** Compute the next-slower tick (double, ceiling 10s). */
export function slowerTick(current: number): number {
  return clampTick(current * 2);
}
