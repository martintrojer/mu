// Re-render guard for the dashboard poll loop
// (bug_tui_flicker_on_every_tick, workstream `tui-impl`).
//
// The fix ships in two layers in src/cli/tui/state.ts:
//
//   LAYER A — `snapshotKey()` projects only the visible-affecting
//             fields of a WorkstreamSnapshot; two snapshots with
//             equal keys must render identical frames so the hook
//             can short-circuit setData. Tested here as a pure
//             function plus byte-equal `snapshotKeyString`.
//
//   LAYER B — `lastTickMs` lives in its own useState in
//             useDashboardSnapshot, so its 1×/sec churn doesn't
//             ripple into the card render path. The hook isn't
//             cheap to drive without ink-testing-library, so we
//             use a static-source assertion (the same pattern the
//             spec calls out): grep state.ts for the structural
//             markers that prove Layer B is in place.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { snapshotKey, snapshotKeyString } from "../src/cli/tui/state.js";
import type { WorkstreamSnapshot } from "../src/state.js";

// Minimal builder — we only need the fields snapshotKey reads, so
// extra noise fields are added per-test to prove they're ignored.
function makeSnap(overrides: Partial<WorkstreamSnapshot> = {}): WorkstreamSnapshot {
  return {
    workstreamName: "ws",
    view: {
      agents: [],
      orphans: [],
      report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
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
      status: "running" as const,
      role: "writer",
      tab: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const a = makeSnap({
      view: {
        agents: [agent],
        orphans: [],
        report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
      },
    });
    const b = makeSnap({
      view: {
        agents: [{ ...agent, status: "needs_input" }],
        orphans: [],
        report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
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
        report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
      },
    });
    const b = makeSnap({
      view: {
        agents: [],
        orphans: [],
        report: { prunedGhosts: 5, statusChanges: 3, orphans: [], mode: "status-only" },
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

// Layer B static-source assertion (the spec recommends this exact
// approach). The hook is hard to drive without ink-testing-library;
// the structural markers are clear enough that grep is adequate.
describe("Layer B — lastTickMs decoupled from data state (static)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, "..", "src", "cli", "tui", "state.ts"), "utf8");

  it("declares a separate useState for lastTickMs", () => {
    // Any of: const [lastTickMs, setLastTickMs] = useState(0)
    expect(src).toMatch(/useState\s*\(\s*0\s*\)/);
    expect(src).toMatch(/setLastTickMs\s*\(/);
  });

  it("guards setData with a previous-key comparison (Layer A)", () => {
    // The fix is built around a JSON-string compare against the
    // previous key inside a setData(prev => ...) updater. Either
    // direction of equality is fine; we just check the marker is
    // present so the guard isn't accidentally removed.
    expect(src).toMatch(/snapshotKeyString/);
    expect(src).toMatch(/return\s+prev\b/);
  });

  it("does not set the snapshot data unconditionally each tick", () => {
    // Regression guard: catch a re-introduced
    // `setSnap({ data, lastTickMs, error: null })` style line.
    expect(src).not.toMatch(/setSnap\s*\(\s*\{\s*data\s*,\s*lastTickMs/);
  });
});

// review_dead_code_refresh_now: the `r` / F5 binding bumps a
// `refreshNonce` in <App>; the hook must list it as an effect dep so
// the bump tears down the interval and re-runs the effect, which
// fires `tick()` immediately. Without the dep the binding shipped
// as a lie. Static-source assertion mirrors the Layer B pattern
// above (the hook is awkward to drive without ink-testing-library).
describe("refreshNonce — wired into useDashboardSnapshot deps (static)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, "..", "src", "cli", "tui", "state.ts"), "utf8");

  it("useDashboardSnapshot accepts an optional refreshNonce parameter", () => {
    expect(src).toMatch(/refreshNonce\s*=\s*0/);
  });

  it("refreshNonce is in the poll-loop effect's dep list", () => {
    // The effect's deps end with `refreshNonce]` so a bump from <App>
    // tears down + restarts the interval, which fires `tick()`
    // immediately.
    expect(src).toMatch(/\[db,\s*workstream,\s*tickMs,\s*enabled,\s*refreshNonce\]/);
  });
});

// app.tsx side: the dead `void refreshNonce` useEffect that did
// nothing was dropped, and the nonce is now passed through to
// useDashboardSnapshot as the 5th argument. Static-source assertion
// guards the wiring (catches a regression that re-introduces the
// no-op effect or drops the hook arg).
describe("app.tsx — refresh-now wiring (static)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, "..", "src", "cli", "tui", "app.tsx"), "utf8");

  it("passes refreshNonce as the 5th arg to useDashboardSnapshot", () => {
    expect(src).toMatch(
      /useDashboardSnapshot\s*\(\s*db\s*,\s*workstream\s*,\s*tickMs\s*,\s*popup === null\s*,\s*refreshNonce\s*\)/,
    );
  });

  it("does NOT keep a no-op `void refreshNonce` useEffect", () => {
    expect(src).not.toMatch(/void\s+refreshNonce\s*;/);
  });
});
