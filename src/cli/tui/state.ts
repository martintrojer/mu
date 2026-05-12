// React hook + tick-rate constants for the TUI's poll loop.
//
// Per design_poll_loop (workstream `tui`): simple poll, single
// setInterval owned by <Dashboard>, synchronous better-sqlite3 reads
// (no race possible by construction), tick rate adjustable live with
// +/- (floor 100ms, ceiling 10s, default 1s), no persistence.
//
// The hook pauses fetches when `enabled === false` so the dashboard
// can stop ticking while a popup is open. Popups can run their own
// fetch loops if they need data not in the dashboard snapshot.
//
// Re-render guard (bug_tui_flicker_on_every_tick, workstream
// `tui-impl`):
//
//   The naive unconditional setData on every tick was the bug;
//   forced React/ink to diff a brand-new top-level state object,
//   which in turn re-rendered every card body — a perceptible
//   full-frame flash 1×/sec on any stable workstream.
//
//   Two-layer fix lives here:
//     LAYER A: stringify a `snapshotKey()` of the visible-affecting
//              fields and short-circuit setData when the key is
//              byte-equal to the previous one. The hook returns the
//              SAME `data` reference across no-op ticks so ink's
//              prop-diff bottoms out at the cards.
//     LAYER B: lastTickMs lives in its OWN useState, so the
//              StatusBar's tick-rate display can update every tick
//              without dragging the cards along.
//
//   Layer C (per-card useMemo) is intentionally skipped — Layer A
//   stops the new-prop cascade at the top-level `data` reference,
//   which is enough in practice. Revisit only if visible flicker
//   regresses against a stable workstream.

import { useEffect, useRef, useState } from "react";
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
  /** Card 8 — recent project commits (feat_tui_commits_card,
   *  workstream `tui-impl`). Reads snapshot.recentCommits populated
   *  by the withRecentCommits opt-in. */
  commits: boolean;
  /** Card 9 — doctor health-check summary (feat_card_9_doctor,
   *  workstream `tui-impl`). Reads `snapshot.doctor` (populated by
   *  loadWorkstreamSnapshot when called with `withDoctor: true`).
   *  See src/doctor-summary.ts for the SDK seam. */
  doctor: boolean;
}

export const DEFAULT_CARD_VISIBILITY: CardVisibility = {
  agents: true,
  tracks: true,
  ready: true,
  log: true,
  workspaces: true,
  inProgress: true,
  blocked: true,
  commits: true,
  doctor: true,
};

export interface DashboardSnapshot {
  data: WorkstreamSnapshot | null;
  /** Measured fetch duration of the most recent tick (ms). Lives in
   *  its OWN useState (Layer B); decoupled from `data` so the
   *  StatusBar's tick display can refresh without re-rendering the
   *  cards. */
  lastTickMs: number;
  error: string | null;
}

/**
 * Subscribe to the workstream snapshot via a setInterval-owned poll
 * loop. Re-fetches every `tickMs` while `enabled` is true.
 *
 * Re-render guard: returns the SAME `data` reference across ticks
 * whose visible content (`snapshotKey`) is unchanged, so React/ink
 * diff against the cards bottoms out cheaply. `lastTickMs` is in a
 * separate useState (Layer B) so its 1×/sec update does not force a
 * card re-render.
 *
 * `refreshNonce` is the optional refresh-now signal
 * (review_dead_code_refresh_now): every distinct value forces an
 * immediate re-fetch by re-running the effect. Wired through to the
 * effect's dep list so bumping it from <App> on the `r` / F5
 * keypress restarts the interval and runs `tick()` synchronously.
 * Defaults to 0 when unwired so existing callers keep working.
 */
export function useDashboardSnapshot(
  db: Db,
  workstream: string,
  tickMs: number,
  enabled: boolean,
  refreshNonce = 0,
): DashboardSnapshot {
  // Layer A: data + error (the stuff the cards read).
  const [data, setData] = useState<{ data: WorkstreamSnapshot | null; error: string | null }>({
    data: null,
    error: null,
  });
  // Layer B: tick duration lives by itself so its update doesn't
  // ripple into the card render path.
  const [lastTickMs, setLastTickMs] = useState(0);

  // Snap-to-null on workstream change
  // (bug_tui_tab_switch_stale_render, workstream `tui-impl`).
  //
  //   Without this, Tab/Shift-Tab on the multi-ws TUI flips the
  //   `workstream` prop but the hook still has the OLD ws's
  //   WorkstreamSnapshot in `data` until the new effect's first
  //   tick resolves (~10-50ms for the SQLite read). React renders
  //   the cards against the stale snapshot in that gap → a mixed
  //   frame whose CARDS are old-ws but whose TAB STRIP is new-ws.
  //
  //   Fix: when the workstream prop changes, synchronously reset
  //   data to null during render. Cards already handle the null /
  //   loading-state case. The next tick (started by the effect's
  //   re-run on the workstream dep) repopulates fresh data within
  //   one tick.
  //
  //   This is the React-officially-blessed pattern for "derive
  //   state from props": store the previous value in a ref, compare
  //   during render, and call setState if they diverge. React
  //   re-renders immediately with the new state and skips any
  //   intervening commit, so cards never see the stale snapshot.
  const lastWsRef = useRef(workstream);
  if (shouldDiscardForWorkstream(lastWsRef.current, workstream)) {
    lastWsRef.current = workstream;
    setData({ data: null, error: null });
    setLastTickMs(0);
  }

  useEffect(() => {
    if (!enabled) return;
    // Touch refreshNonce so biome's useExhaustiveDependencies sees
    // it as read-inside-effect; the actual purpose of listing it in
    // the dep array is to force the effect to re-run on every bump
    // from <App> (the `r` / F5 keypress), which tears down the
    // setInterval and synchronously fires `tick()` below — i.e.
    // an immediate refresh. (review_dead_code_refresh_now)
    void refreshNonce;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const t0 = performance.now();
      try {
        const fresh = await loadWorkstreamSnapshot(db, workstream, {
          eventLimit: 200,
          // Workspaces card (feat_card_5_workspaces) needs the dirty
          // marker; the cost is one `git status --porcelain` per row,
          // capped at DECORATE_CONCURRENCY in workspace.ts.
          withDirty: true,
          // Doctor card (feat_card_9_doctor) needs the health-check
          // summary. loadDoctorSummary is cheap (synchronous DB
          // pragmas + COUNT-shape SELECTs; ghosts/orphans come
          // straight from the snapshot we already built).
          withDoctor: true,
          // Commits card / popup need the project-root commit log.
          // Uses process.cwd() in loadWorkstreamSnapshot by design:
          // the TUI launches from the project checkout, not from a
          // per-agent worker workspace.
          withRecentCommits: { limit: 25 },
        });
        if (cancelled) return;
        const dur = performance.now() - t0;
        setLastTickMs(dur);
        const freshKey = snapshotKeyString(fresh);
        setData((prev) => {
          const prevKey = prev.data === null ? "" : snapshotKeyString(prev.data);
          if (prev.error === null && prevKey === freshKey) {
            // Visible content unchanged — return the SAME object
            // reference so React/ink skip the cascade. (`fresh` is
            // discarded; that's the point.)
            return prev;
          }
          return { data: fresh, error: null };
        });
      } catch (err) {
        if (cancelled) return;
        const msg = String(err);
        setData((prev) => (prev.error === msg ? prev : { ...prev, error: msg }));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), tickMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // `refreshNonce` participates in the dep list so the `r` / F5
    // keypress (App bumps the nonce) tears down the interval and
    // re-runs the effect, which fires `tick()` immediately. Without
    // this, the binding existed but never poked the poll loop
    // (review_dead_code_refresh_now).
  }, [db, workstream, tickMs, enabled, refreshNonce]);

  return { data: data.data, lastTickMs, error: data.error };
}

/**
 * Pure helper: returns true when a workstream-prop change must
 * discard the cached snapshot. Today this is just an identity
 * check, but factoring it out (a) makes the snap-to-null branch in
 * useDashboardSnapshot unit-testable without driving the hook, and
 * (b) gives future work (e.g. ws-aliases / case-insensitive
 * matching) a single seam to extend. See bug_tui_tab_switch_stale_render.
 */
export function shouldDiscardForWorkstream(prev: string, next: string): boolean {
  return prev !== next;
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

// ─── snapshotKey ───────────────────────────────────────────────────
//
// Pure projection of the WorkstreamSnapshot fields that actually
// affect what the user sees on screen. Two snapshots with the same
// snapshotKey() are guaranteed to render identical frames — so the
// hook can safely skip setData for them.
//
// Design notes:
//   - Picks ONE of every visible-affecting field per row, no more.
//     Adding a field that DOES affect rendering but ISN'T listed
//     here is a regression (cards will lag a tick); adding a field
//     that DOESN'T affect rendering is a regression (we'll re-render
//     unnecessarily).
//   - tracks[i].taskIds is a Set<string>; serialise it as a sorted
//     array so JSON.stringify is deterministic.
//   - We DO NOT include workspaceOrphans because no card surfaces
//     them today (the TUI shows orphans only on the static
//     `mu state` card). If a future card reads them, add it here.
//   - We DO NOT include reconcile report counters (prunedGhosts,
//     statusChanges) — they are diagnostic, not rendered.

/**
 * Pure projection of the visible-affecting fields of a snapshot.
 * Two snapshots that produce equal `snapshotKey` render identical
 * frames. Exported for unit tests; consumers should prefer
 * `snapshotKeyString` (which JSON-encodes the result for cheap
 * byte-equality checks).
 */
export function snapshotKey(s: WorkstreamSnapshot): unknown {
  return {
    workstreamName: s.workstreamName,
    agents: s.view.agents.map((a) => [a.name, a.status, a.role, a.idle === true ? 1 : 0]),
    orphanPaneIds: s.view.orphans.map((o) => o.paneId).sort(),
    tracks: s.tracks.map((t) => ({
      roots: t.roots.map((r) => r.name),
      readyCount: t.readyCount,
      // Set → sorted array; deterministic JSON.
      taskIds: [...t.taskIds].sort(),
    })),
    ready: s.ready.map(taskKey),
    inProgress: s.inProgress.map(taskKey),
    blocked: s.blocked.map(taskKey),
    recentClosed: s.recentClosed.map(taskKey),
    commitsBackend: s.commitsBackend ?? null,
    recentCommits: s.recentCommits.map((c) => [c.sha, c.subject, c.author, c.relTime]),
    workspaces: s.workspaces.map((w) => [
      w.agentName,
      w.backend,
      w.parentRef ?? "",
      w.commitsBehindMain ?? "",
      w.dirty === true ? 1 : 0,
    ]),
    // Recent log entries: seq is monotonic, so eq-by-seq is enough
    // for ordered membership; payload bytes drive what shows.
    recent: s.recent.map((l) => [l.seq, l.source, l.kind, l.payload]),
  };
}

/** Stable JSON encoding of `snapshotKey`. Cheap byte-equal check. */
export function snapshotKeyString(s: WorkstreamSnapshot): string {
  return JSON.stringify(snapshotKey(s));
}

// One row of every visible-affecting task field. impact + effortDays
// drive the ROI bucket / sort; status drives glyph + colour;
// updatedAt drives the relative-time column (task cards such as
// InProgress); ownerName + title are rendered verbatim.
function taskKey(t: {
  name: string;
  status: string;
  impact: number;
  effortDays: number;
  ownerName: string | null;
  title: string;
  updatedAt: string;
}): (string | number)[] {
  return [t.name, t.status, t.impact, t.effortDays, t.ownerName ?? "", t.title, t.updatedAt];
}
