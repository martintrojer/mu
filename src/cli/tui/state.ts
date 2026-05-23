// React hook + tick-rate constants for the TUI's poll loop.
//
// Per design_poll_loop (workstream `tui`): simple poll, single
// setInterval owned by <Dashboard>, synchronous better-sqlite3 reads
// (no race possible by construction), tick rate adjustable live with
// +/- (floor 100ms, ceiling 10s, default 1s), no persistence.
//
// The hook pauses fetches when `enabled === false`. <App> keeps it
// enabled while popups are open so visible drill-down views can share
// the same fast/slow refresh cadence as the dashboard.
//
// Re-render guard (bug_tui_flicker_on_every_tick, workstream
// `tui-impl`):
//
//   The naive unconditional setData on every tick was the bug;
//   forced React/ink to diff a brand-new top-level state object,
//   which in turn re-rendered every card body — a perceptible
//   full-frame flash 1×/sec on any stable workstream.
//
//   Three-layer fix lives here:
//     LAYER A: stringify a `snapshotKey()` of the visible-affecting
//              fields and short-circuit setData when the key is
//              byte-equal to the previous one. The hook returns the
//              SAME `data` reference across no-op ticks so ink's
//              prop-diff bottoms out at the cards.
//     LAYER B: tick-duration and drill-refresh nonces publish only
//              when the snapshot key changes (or an error clears), so
//              no-op poll intervals do not force a whole-App render.
//     LAYER C: the dashboard fast tick does NOT preload the exhaustive
//              all-tasks list; the All-tasks popup reads SQLite
//              directly while open.
//
//   Per-card useMemo is intentionally skipped — Layers A/B stop the
//   new-prop cascade at the top-level `data` reference, which is
//   enough in practice. Revisit only if visible flicker regresses
//   against a stable workstream.

import { useEffect, useRef, useState } from "react";
import type { Db } from "../../db.js";
import {
  type LoadWorkstreamSnapshotOptions,
  type WorkstreamSnapshot,
  type WorkstreamSnapshotSlowFields,
  loadWorkstreamSnapshotFast,
  loadWorkstreamSnapshotSlow,
  mergeSnapshotFastSlow,
} from "../../state.js";
import type { CardId } from "./layout.js";

export const TICK_DEFAULT_MS = 1000;
export const TICK_FLOOR_MS = 100;
export const TICK_CEILING_MS = 10_000;
export const SLOW_TICK_MS = 10_000;

/**
 * Per-card on/off state for the dashboard. Keyed by numeric CardId
 * (0..9) — the same key that CARD_CONFIGS, CARD_REGISTRY,
 * POPUP_REGISTRY, and dataCountForCard already use.
 *
 * Pre-review_tui_card_key_from_id_redundant this was keyed by
 * string ("agents", "tracks", "ready", …), which forced a
 * 24-line `cardKeyFromId` switch every keystroke and every render
 * to bridge to the numeric id. Folding the keys back into the
 * shared CardId space eliminates the bridge and keeps the per-card
 * `name` string as the human-friendly identifier on CARD_CONFIGS.
 */
export type CardVisibility = Record<CardId, boolean>;

export const DEFAULT_CARD_VISIBILITY: CardVisibility = {
  0: true,
  1: true,
  2: true,
  3: true,
  4: true,
  5: true,
  6: true,
  7: true,
  8: true,
  9: true,
};

export interface DashboardSnapshot {
  data: WorkstreamSnapshot | null;
  /** Increments after a fast SQL-only tick publishes a changed
   *  snapshot. Drill views that read SQLite directly include this in
   *  memo deps, while no-op ticks stay render-silent. */
  fastTickNonce: number;
  /** Increments after a slow subprocess tick publishes a changed
   *  snapshot. Drill views that shell out (tmux scrollback, VCS show)
   *  include this instead of fastTickNonce to avoid 1s subprocess
   *  churn; no-op slow ticks stay render-silent. */
  slowTickNonce: number;
  /** Measured fetch duration of the most recent published fast tick
   *  (ms). No-op ticks intentionally leave this unchanged so the
   *  status path does not repaint an otherwise stable frame. */
  lastTickMs: number;
  error: string | null;
}

export interface DashboardSnapshotLoaders {
  fast: (
    db: Db,
    workstream: string,
    opts?: LoadWorkstreamSnapshotOptions,
  ) => Promise<WorkstreamSnapshot>;
  slow: (
    db: Db,
    workstream: string,
    opts?: LoadWorkstreamSnapshotOptions,
    baseSnapshot?: WorkstreamSnapshot,
  ) => Promise<WorkstreamSnapshotSlowFields>;
}

const DEFAULT_LOADERS: DashboardSnapshotLoaders = {
  fast: loadWorkstreamSnapshotFast,
  slow: loadWorkstreamSnapshotSlow,
};

const FAST_OPTS: LoadWorkstreamSnapshotOptions = {
  eventLimit: 200,
};

const SLOW_OPTS: LoadWorkstreamSnapshotOptions = {
  withDirty: true,
  withDoctor: true,
  withRecentCommits: { limit: 25 },
};

export interface DashboardSnapshotOptions {
  /**
   * When true, slowTickNonce advances even if the slow-tier snapshot
   * is byte-equal. Used only for subprocess-backed popup drills
   * (agent scrollback / git show) whose body can change without a DB
   * snapshot change. Dashboard and task-list views keep this false so
   * stable frames stay render-silent.
   */
  publishNoopSlowTicks?: boolean;
}

/**
 * Subscribe to the workstream snapshot via a setInterval-owned poll
 * loop. Re-fetches every `tickMs` while `enabled` is true.
 *
 * Re-render guard: returns the SAME `data` reference across ticks
 * whose visible content (`snapshotKey`) is unchanged, so React/ink
 * diff against the cards bottoms out cheaply. Tick-duration and
 * drill-refresh nonces publish only when the visible snapshot changes
 * (or an error clears), so stable workstreams do not repaint once per
 * poll interval.
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
  loaders: DashboardSnapshotLoaders = DEFAULT_LOADERS,
  options: DashboardSnapshotOptions = {},
): DashboardSnapshot {
  const publishNoopSlowTicks = options.publishNoopSlowTicks === true;
  // Layer A: data + error (the stuff the cards read).
  const [data, setData] = useState<{ data: WorkstreamSnapshot | null; error: string | null }>({
    data: null,
    error: null,
  });
  // Layer B: tick duration + explicit nonces only publish when
  // snapshotKey changes, so no-op poll intervals do not force <App>
  // (and therefore the whole Ink tree) to repaint.
  const [lastTickMs, setLastTickMs] = useState(0);
  const [fastTickNonce, setFastTickNonce] = useState(0);
  const [slowTickNonce, setSlowTickNonce] = useState(0);
  const latestFastRef = useRef<WorkstreamSnapshot | null>(null);
  const slowRef = useRef<WorkstreamSnapshotSlowFields | null>(null);
  const publishedKeyRef = useRef("");
  const errorRef = useRef<string | null>(null);

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
    slowRef.current = null;
    latestFastRef.current = null;
    publishedKeyRef.current = "";
    errorRef.current = null;
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
        const fast = await loaders.fast(db, workstream, FAST_OPTS);
        if (cancelled) return;
        latestFastRef.current = fast;
        const fresh = mergeSnapshotFastSlow(fast, slowRef.current);
        const dur = performance.now() - t0;
        if (publishSnapshot(fresh, setData, publishedKeyRef, errorRef)) {
          setLastTickMs(dur);
          setFastTickNonce((n) => n + 1);
        }
      } catch (err) {
        if (cancelled) return;
        publishError(String(err), setData, errorRef);
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
  }, [db, workstream, tickMs, enabled, refreshNonce, loaders]);

  useEffect(() => {
    if (!enabled) return;
    void refreshNonce;
    let cancelled = false;
    const slowTick = async () => {
      if (cancelled) return;
      try {
        const slow = await loaders.slow(
          db,
          workstream,
          SLOW_OPTS,
          latestFastRef.current ?? undefined,
        );
        if (cancelled) return;
        slowRef.current = slow;
        const fast = latestFastRef.current;
        const changed =
          fast !== null &&
          publishSnapshot(mergeSnapshotFastSlow(fast, slow), setData, publishedKeyRef, errorRef);
        if (changed || (fast !== null && publishNoopSlowTicks)) {
          setSlowTickNonce((n) => n + 1);
        }
      } catch (err) {
        if (cancelled) return;
        publishError(String(err), setData, errorRef);
      }
    };
    void slowTick();
    const id = setInterval(() => void slowTick(), SLOW_TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [db, workstream, enabled, refreshNonce, loaders, publishNoopSlowTicks]);

  return { data: data.data, fastTickNonce, slowTickNonce, lastTickMs, error: data.error };
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

function publishSnapshot(
  fresh: WorkstreamSnapshot,
  writeData: (
    updater: (prev: { data: WorkstreamSnapshot | null; error: string | null }) => {
      data: WorkstreamSnapshot | null;
      error: string | null;
    },
  ) => void,
  publishedKeyRef: { current: string },
  errorRef: { current: string | null },
): boolean {
  const freshKey = snapshotKeyString(fresh);
  if (errorRef.current === null && publishedKeyRef.current === freshKey) return false;
  publishedKeyRef.current = freshKey;
  errorRef.current = null;
  writeData(() => ({ data: fresh, error: null }));
  return true;
}

function publishError(
  message: string,
  writeData: (
    updater: (prev: { data: WorkstreamSnapshot | null; error: string | null }) => {
      data: WorkstreamSnapshot | null;
      error: string | null;
    },
  ) => void,
  errorRef: { current: string | null },
): void {
  if (errorRef.current === message) return;
  errorRef.current = message;
  writeData((prev) => ({ ...prev, error: message }));
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
    allTasks: s.allTasks.map(taskKey),
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
// createdAt / updatedAt drive the all-tasks popup's age / recency
// sorts; ownerName + title are rendered verbatim.
function taskKey(t: {
  name: string;
  status: string;
  impact: number;
  effortDays: number;
  ownerName: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}): (string | number)[] {
  return [
    t.name,
    t.status,
    t.impact,
    t.effortDays,
    t.ownerName ?? "",
    t.title,
    t.createdAt,
    t.updatedAt,
  ];
}
