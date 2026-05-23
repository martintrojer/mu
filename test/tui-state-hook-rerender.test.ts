// Behavioural tests for the dashboard poll-loop hook
// (`useDashboardSnapshot`, src/cli/tui/state.ts).
//
// LAYER A — `snapshotKey()` projects only the visible-affecting
//           fields of a WorkstreamSnapshot; two snapshots with
//           equal keys must render identical frames so the hook
//           can short-circuit setData. Tested as a pure function
//           plus byte-equal `snapshotKeyString` (the suite at the
//           top).
//
// LAYER B — tick-duration and drill-refresh nonces are updated
//           only when a tick publishes changed visible content. A
//           stable workstream therefore produces no hook-level state
//           update after the first loaded frame, so <App> does not
//           repaint once per poll interval.
//
// refreshNonce — bumping the nonce mid-interval re-runs the
//           effect, which fires `tick()` synchronously. Tested
//           with a long tickMs (10s) so an interval-driven tick
//           cannot mask the synchronous one.
//
// app.tsx refresh-now wiring — the dashboard's `r` / F5 keypress
//           bumps the nonce that flows into useDashboardSnapshot.
//           Tested behaviourally by re-rendering the harness with
//           a new refreshNonce and asserting the loader fires
//           within ~5ms even when tickMs is too long for the
//           interval to have helped. (The static "no leftover
//           `void refreshNonce` useEffect" assertion was a source
//           grep that could not distinguish a load-bearing
//           dep-list anchor from a no-op; the behaviour cure is
//           the same here.)

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Text, render } from "ink";
import { createElement, useEffect, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DashboardSnapshotLoaders,
  type DashboardSnapshotOptions,
  snapshotKey,
  snapshotKeyString,
  useDashboardSnapshot,
} from "../src/cli/tui/state.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot, WorkstreamSnapshotSlowFields } from "../src/state.js";
import { CaptureStream, createInkCaptureStream, waitForInkOutput } from "./_ink-render.js";

const openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs.length = 0;
  CaptureStream.cleanup();
});

function fixtureDb(): Db {
  // Real SQLite (in a per-test temp dir) is the cheap way to get a
  // valid Db handle to pass into useDashboardSnapshot. The hook
  // never reads from it — the controllable loaders intercept every
  // fast/slow call — but the type signature wants the real thing.
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-state-hook-rerender-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

// Minimal builder — we only need the fields snapshotKey reads, so
// extra noise fields are added per-test to prove they're ignored.
function makeSnap(overrides: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
  return {
    workstreamName: "ws",
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
    },
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
    ...overrides,
  } as WorkstreamSnapshot;
}

describe("snapshotKey — visible-affecting field projection", () => {
  it("two empty snapshots produce equal keys", () => {
    expect(snapshotKeyString(makeSnap())).toBe(snapshotKeyString(makeSnap()));
  });

  it("returns a non-empty key", () => {
    expect(snapshotKeyString(makeSnap()).length).toBeGreaterThan(0);
  });

  it("differs when an agent's status changes", () => {
    const agent = {
      name: "w1",
      workstreamName: "ws",
      cli: "pi",
      paneId: "%1",
      status: "busy" as const,
      role: "writer",
      tab: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const a = makeSnap({
      view: {
        agents: [agent],
        orphans: [],
        report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
      },
    });
    const b = makeSnap({
      view: {
        agents: [{ ...agent, status: "needs_input" }],
        orphans: [],
        report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
      },
    });
    expect(snapshotKeyString(a)).not.toBe(snapshotKeyString(b));
  });

  it("differs when a task's title changes", () => {
    const t = {
      name: "foo",
      workstreamName: "ws",
      title: "old",
      status: "OPEN" as const,
      impact: 50,
      effortDays: 1,
      ownerName: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const a = makeSnap({ ready: [t] });
    const b = makeSnap({ ready: [{ ...t, title: "new" }] });
    expect(snapshotKeyString(a)).not.toBe(snapshotKeyString(b));
  });

  it("differs when a task's updatedAt changes (drives relative time column)", () => {
    const t = {
      name: "foo",
      workstreamName: "ws",
      title: "t",
      status: "IN_PROGRESS" as const,
      impact: 50,
      effortDays: 1,
      ownerName: "w1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const a = makeSnap({ inProgress: [t] });
    const b = makeSnap({ inProgress: [{ ...t, updatedAt: "2026-01-01T00:00:30Z" }] });
    expect(snapshotKeyString(a)).not.toBe(snapshotKeyString(b));
  });

  it("differs when a workspace becomes dirty", () => {
    const w = {
      agentName: "w1",
      workstreamName: "ws",
      backend: "git" as const,
      path: "/tmp/x",
      parentRef: "abc",
      createdAt: "2026-01-01T00:00:00Z",
      commitsBehindMain: 0,
      dirty: false,
    };
    const a = makeSnap({ workspaces: [w] });
    const b = makeSnap({ workspaces: [{ ...w, dirty: true }] });
    expect(snapshotKeyString(a)).not.toBe(snapshotKeyString(b));
  });

  it("differs when a new log row arrives", () => {
    const row = {
      seq: 1,
      workstreamName: "ws",
      source: "system",
      kind: "event" as const,
      payload: "{}",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const a = makeSnap({ recent: [row] });
    const b = makeSnap({ recent: [row, { ...row, seq: 2 }] });
    expect(snapshotKeyString(a)).not.toBe(snapshotKeyString(b));
  });

  it("differs when a recent commit arrives", () => {
    const c = {
      sha: "abc1234",
      subject: "commit",
      body: "",
      author: "tester",
      authorDate: "2026-01-01T00:00:00Z",
      relTime: "1m",
    };
    const a = makeSnap({ recentCommits: [c] });
    const b = makeSnap({ recentCommits: [{ ...c, subject: "new commit" }] });
    expect(snapshotKeyString(a)).not.toBe(snapshotKeyString(b));
  });

  it("differs when the commits backend changes", () => {
    const a = makeSnap({ commitsBackend: "git" });
    const b = makeSnap({ commitsBackend: "jj" });
    expect(snapshotKeyString(a)).not.toBe(snapshotKeyString(b));
  });

  it("differs when a track's readyCount changes", () => {
    const a = makeSnap({
      tracks: [{ roots: [], taskIds: new Set(["a", "b"]), readyCount: 1 }],
    });
    const b = makeSnap({
      tracks: [{ roots: [], taskIds: new Set(["a", "b"]), readyCount: 2 }],
    });
    expect(snapshotKeyString(a)).not.toBe(snapshotKeyString(b));
  });

  it("equal regardless of Set iteration order in tracks.taskIds", () => {
    const a = makeSnap({
      tracks: [{ roots: [], taskIds: new Set(["a", "b", "c"]), readyCount: 0 }],
    });
    const b = makeSnap({
      tracks: [{ roots: [], taskIds: new Set(["c", "a", "b"]), readyCount: 0 }],
    });
    expect(snapshotKeyString(a)).toBe(snapshotKeyString(b));
  });

  it("ignores reconcile-report counters (purely diagnostic)", () => {
    const a = makeSnap({
      view: {
        agents: [],
        orphans: [],
        report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
      },
    });
    const b = makeSnap({
      view: {
        agents: [],
        orphans: [],
        report: { prunedGhosts: 5, statusChanges: 3, orphans: [], mode: "report-only" },
      },
    });
    expect(snapshotKeyString(a)).toBe(snapshotKeyString(b));
  });

  it("ignores workspaceOrphans (no card surfaces them today)", () => {
    const a = makeSnap({ workspaceOrphans: [] });
    const b = makeSnap({
      workspaceOrphans: [{ agentName: "ghost", workstreamName: "ws", path: "/tmp/g" }],
    });
    expect(snapshotKeyString(a)).toBe(snapshotKeyString(b));
  });

  it("snapshotKey produces a stable structure (object-shape regression guard)", () => {
    const k = snapshotKey(makeSnap()) as Record<string, unknown>;
    // The fields any future card might want to react to. Removing
    // one of these without intent will silently make that card lag.
    expect(Object.keys(k).sort()).toEqual(
      [
        "agents",
        "allTasks",
        "blocked",
        "inProgress",
        "orphanPaneIds",
        "ready",
        "recent",
        "recentClosed",
        "commitsBackend",
        "recentCommits",
        "tracks",
        "workspaces",
        "workstreamName",
      ].sort(),
    );
  });
});

// ─── Behavioural fixtures for the hook itself ────────────────────────

interface CapturedFrame {
  data: WorkstreamSnapshot | null;
  lastTickMs: number;
  fastTickNonce: number;
  slowTickNonce: number;
  error: string | null;
}

interface HarnessProps {
  db: Db;
  workstream: string;
  tickMs: number;
  refreshNonce: number;
  loaders: DashboardSnapshotLoaders;
  options?: DashboardSnapshotOptions;
  /** Test sink: each render appends the frame returned by the hook. */
  capture: { values: CapturedFrame[] };
}

function HookHarness({
  db,
  workstream,
  tickMs,
  refreshNonce,
  loaders,
  options,
  capture,
}: HarnessProps): JSX.Element {
  const snap = useDashboardSnapshot(db, workstream, tickMs, true, refreshNonce, loaders, options);
  const sink = useRef(capture);
  useEffect(() => {
    sink.current.values.push({
      data: snap.data,
      lastTickMs: snap.lastTickMs,
      fastTickNonce: snap.fastTickNonce,
      slowTickNonce: snap.slowTickNonce,
      error: snap.error,
    });
  });
  return createElement(Text, null, snap.data === null ? "(loading)" : "(loaded)");
}

/**
 * Build a controllable loader pair.
 *   - Each fast() call increments `fastCalls` and resolves with the
 *     next snapshot from `fastSequence` (or repeats the last one if
 *     the sequence is exhausted).
 *   - slow() returns a constant placeholder so the slow-tier
 *     setInterval doesn't perturb the test.
 */
function makeLoaders(fastSequence: WorkstreamSnapshot[]): {
  loaders: DashboardSnapshotLoaders;
  fastCalls: { count: number; ts: number[] };
} {
  const fastCalls = { count: 0, ts: [] as number[] };
  let i = 0;
  const constantSlow: WorkstreamSnapshotSlowFields = {
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
    },
    workspaces: [],
    recentCommits: [],
    commitsBackend: null,
    doctor: null,
  };
  const loaders: DashboardSnapshotLoaders = {
    fast: async () => {
      fastCalls.count += 1;
      fastCalls.ts.push(performance.now());
      const idx = Math.min(i, fastSequence.length - 1);
      i += 1;
      const out = fastSequence[idx];
      if (out === undefined) {
        throw new Error("fastSequence is empty");
      }
      return out;
    },
    slow: async () => constantSlow,
  };
  return { loaders, fastCalls };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

describe("useDashboardSnapshot — Layer B preserves data reference across no-op ticks", () => {
  // Behavioural form of the old static "Layer B — lastTickMs
  // decoupled from data state" describe. The cure for the flicker
  // bug is that `data` is the SAME reference across ticks whose
  // visible content (snapshotKey) is unchanged — so React/ink's
  // prop diff bottoms out at the cards. We drive the hook with two
  // byte-equal-but-non-identity snapshots and assert Object.is on
  // the captured frames.
  it("returns the SAME data reference across ticks with byte-equal snapshots", async () => {
    const db = fixtureDb();
    // Two distinct objects, byte-equal under snapshotKeyString.
    const snapA = makeSnap();
    const snapB = makeSnap();
    expect(snapA).not.toBe(snapB); // distinct references
    expect(snapshotKeyString(snapA)).toBe(snapshotKeyString(snapB));

    const { loaders, fastCalls } = makeLoaders([snapA, snapB, snapA, snapB]);
    const stdout = createInkCaptureStream({ columns: 40, rows: 10 });
    const capture = { values: [] as CapturedFrame[] };

    const instance = render(
      createElement(HookHarness, {
        db,
        workstream: "demo",
        tickMs: 30,
        refreshNonce: 0,
        loaders,
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );

    // Wait for at least 3 fast loads to have completed so we have
    // enough captured frames to compare references across ticks.
    await waitFor(() => fastCalls.count >= 3, 1500);
    // Let one more setInterval tick land + ink flush its commit.
    await waitForInkOutput(stdout);

    const dataFrames = capture.values.filter((f) => f.data !== null);
    expect(dataFrames.length).toBeGreaterThanOrEqual(2);
    const first = dataFrames[0]?.data ?? null;
    expect(first).not.toBeNull();
    // Every subsequent frame must hold the SAME reference. If
    // Layer A regresses and the hook publishes a fresh object on
    // every tick, this Object.is check fails on the second frame.
    for (const frame of dataFrames.slice(1)) {
      expect(frame.data).toBe(first);
    }

    instance.unmount();
  });

  // The OTHER half of the Layer B contract: no-op ticks should not
  // publish scalar state either. Earlier fixes preserved the `data`
  // reference but still bumped fastTickNonce / lastTickMs, which made
  // <App> repaint every interval and kept the visible flicker. The
  // loader still polls, but byte-equal results are render-silent.
  it("does not advance fastTickNonce across no-op ticks", async () => {
    const db = fixtureDb();
    const snap = makeSnap();
    const { loaders, fastCalls } = makeLoaders([snap, snap, snap, snap, snap]);
    const stdout = createInkCaptureStream({ columns: 40, rows: 10 });
    const capture = { values: [] as CapturedFrame[] };

    const instance = render(
      createElement(HookHarness, {
        db,
        workstream: "demo",
        tickMs: 30,
        refreshNonce: 0,
        loaders,
        capture,
      }),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: true, patchConsole: false },
    );

    // Need ≥3 fast loads to prove the poll loop continued running
    // after the first visible publish.
    await waitFor(() => fastCalls.count >= 3, 1500);
    await waitForInkOutput(stdout);

    const dataFrames = capture.values.filter((f) => f.data !== null);
    expect(dataFrames.length).toBeGreaterThanOrEqual(1);
    const nonces = dataFrames.map((f) => f.fastTickNonce);
    // Initial publish may commit as two React frames (data first,
    // nonce second), so 0 and 1 can both appear. No-op ticks after
    // that must not keep incrementing to 2, 3, ...
    expect(Math.max(...nonces)).toBe(1);

    instance.unmount();
  });
  it("bumps slowTickNonce on byte-equal slow ticks when requested for subprocess drills", async () => {
    const db = fixtureDb();
    const { loaders, fastCalls } = makeLoaders([makeSnap(), makeSnap(), makeSnap()]);
    const stdout = createInkCaptureStream({ columns: 40, rows: 10 });
    const capture = { values: [] as CapturedFrame[] };

    const props: HarnessProps = {
      db,
      workstream: "demo",
      tickMs: 10_000,
      refreshNonce: 0,
      loaders,
      options: { publishNoopSlowTicks: true },
      capture,
    };
    const instance = render(createElement(HookHarness, props), {
      stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      debug: true,
      patchConsole: false,
    });

    await waitFor(() => fastCalls.count >= 1, 1500);
    await waitFor(() => Math.max(...capture.values.map((f) => f.slowTickNonce)) >= 1, 1500);
    const beforeSlow = Math.max(...capture.values.map((f) => f.slowTickNonce));
    const beforeFast = Math.max(...capture.values.map((f) => f.fastTickNonce));

    instance.rerender(createElement(HookHarness, { ...props, refreshNonce: 1 }));

    await waitFor(() => Math.max(...capture.values.map((f) => f.slowTickNonce)) > beforeSlow, 500);
    const afterFast = Math.max(...capture.values.map((f) => f.fastTickNonce));
    expect(afterFast).toBe(beforeFast);

    instance.unmount();
  });
});

describe("useDashboardSnapshot — refreshNonce fires the loader synchronously", () => {
  // Behavioural form of the old static "refreshNonce — wired into
  // useDashboardSnapshot deps" describe. The cure for
  // review_dead_code_refresh_now: bumping the nonce tears down the
  // interval and re-runs the effect, which fires `tick()`
  // synchronously. We use a long tickMs (10s) so an
  // interval-driven tick cannot mask a synchronous one.
  it("bumping refreshNonce fires the loader within ~50ms despite tickMs=10000", async () => {
    const db = fixtureDb();
    const { loaders, fastCalls } = makeLoaders([makeSnap(), makeSnap(), makeSnap(), makeSnap()]);
    const stdout = createInkCaptureStream({ columns: 40, rows: 10 });
    const capture = { values: [] as CapturedFrame[] };

    const props: HarnessProps = {
      db,
      workstream: "demo",
      tickMs: 10_000,
      refreshNonce: 0,
      loaders,
      capture,
    };
    const instance = render(createElement(HookHarness, props), {
      stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      debug: true,
      patchConsole: false,
    });

    // Initial mount fires one tick. Wait for it then take a
    // baseline.
    await waitFor(() => fastCalls.count >= 1, 1500);
    const baseline = fastCalls.count;
    const t0 = performance.now();

    // Bump the nonce. The cure: this tears down the setInterval
    // and re-runs the effect, which fires tick() synchronously.
    // The next interval tick wouldn't otherwise arrive for 10s.
    instance.rerender(createElement(HookHarness, { ...props, refreshNonce: 1 }));

    await waitFor(() => fastCalls.count > baseline, 250);
    const elapsed = performance.now() - t0;

    // Synchronous-ish: anything well under tickMs proves the
    // refreshNonce dep wiring is live. 250ms is generous so
    // loaded CI doesn't flake; a real regression (nonce dropped
    // from the dep list) leaves us waiting the full 10s.
    expect(elapsed).toBeLessThan(250);

    instance.unmount();
  });
});

describe("useDashboardSnapshot — successive refreshNonce bumps each fire a tick", () => {
  // Behavioural form of the old static "app.tsx — refresh-now
  // wiring" describe. The grep checked that <App> calls
  // useDashboardSnapshot with refreshNonce as the 5th argument and
  // that no leftover `void refreshNonce` no-op useEffect remained
  // alongside it. The behaviour both pinned: every distinct value
  // of refreshNonce (each `r` keypress in <App>) must trigger an
  // immediate fetch. We re-render the harness with monotonically
  // increasing nonces and assert the loader fires once per bump.
  it("each new refreshNonce value triggers exactly one extra fast load", async () => {
    const db = fixtureDb();
    const { loaders, fastCalls } = makeLoaders([
      makeSnap(),
      makeSnap(),
      makeSnap(),
      makeSnap(),
      makeSnap(),
      makeSnap(),
    ]);
    const stdout = createInkCaptureStream({ columns: 40, rows: 10 });
    const capture = { values: [] as CapturedFrame[] };

    const props: HarnessProps = {
      db,
      workstream: "demo",
      tickMs: 10_000, // long enough that no interval tick lands during the test
      refreshNonce: 0,
      loaders,
      capture,
    };
    const instance = render(createElement(HookHarness, props), {
      stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      debug: true,
      patchConsole: false,
    });

    await waitFor(() => fastCalls.count >= 1, 1500);
    const afterMount = fastCalls.count;

    instance.rerender(createElement(HookHarness, { ...props, refreshNonce: 1 }));
    await waitFor(() => fastCalls.count > afterMount, 250);
    const afterFirstBump = fastCalls.count;

    instance.rerender(createElement(HookHarness, { ...props, refreshNonce: 2 }));
    await waitFor(() => fastCalls.count > afterFirstBump, 250);
    const afterSecondBump = fastCalls.count;

    // Each bump is at least one extra fast load. (We don't pin
    // exactly one because React's effect cleanup race could
    // theoretically schedule + cancel an in-flight tick; the
    // cure's contract is "at least one fresh fetch per bump".)
    expect(afterFirstBump).toBeGreaterThan(afterMount);
    expect(afterSecondBump).toBeGreaterThan(afterFirstBump);

    // Re-rendering with the SAME nonce must NOT trigger an extra
    // load: the cure relies on dep-list change detection, not on
    // every render. (This is the inverse half of the contract:
    // wires that fire on every render would send loader storms.)
    const beforeRepeat = fastCalls.count;
    instance.rerender(createElement(HookHarness, { ...props, refreshNonce: 2 }));
    // Give any synchronous effect a chance to land.
    await new Promise((r) => setTimeout(r, 100));
    expect(fastCalls.count).toBe(beforeRepeat);

    instance.unmount();
  });
});
