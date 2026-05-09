// Tests for src/tracks.ts: parallel-track detection via union-find,
// including the diamond-merge property that's the killer feature.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { getParallelTracks } from "../src/tracks.js";

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-tracks-"));
  db = openDb({ path: join(tempDir, "mu.db") });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── Trivial cases ─────────────────────────────────────────────────────

describe("getParallelTracks — trivial cases", () => {
  it("empty graph → empty array", () => {
    expect(getParallelTracks(db, "test")).toEqual([]);
  });

  it("single isolated task → one track of one", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.roots.map((r) => r.name)).toEqual(["a"]);
    expect([...(tracks[0]?.taskIds ?? [])]).toEqual(["a"]);
    expect(tracks[0]?.readyCount).toBe(1);
  });

  it("ignores CLOSED goals", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "test", title: "B", impact: 50, effortDays: 1 });
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='a'").run();
    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.roots.map((r) => r.name)).toEqual(["b"]);
  });
});

// ─── Independent (no overlap) ──────────────────────────────────────────

describe("getParallelTracks — independent subtrees", () => {
  it("two independent linear chains → two tracks", () => {
    // Chain 1: a → b → c
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "b",
      workstream: "test",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    addTask(db, {
      localId: "c",
      workstream: "test",
      title: "C",
      impact: 50,
      effortDays: 1,
      blockedBy: ["b"],
    });
    // Chain 2: x → y → z
    addTask(db, { localId: "x", workstream: "test", title: "X", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "y",
      workstream: "test",
      title: "Y",
      impact: 50,
      effortDays: 1,
      blockedBy: ["x"],
    });
    addTask(db, {
      localId: "z",
      workstream: "test",
      title: "Z",
      impact: 50,
      effortDays: 1,
      blockedBy: ["y"],
    });

    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(2);
    const trackByRoot = new Map(tracks.map((t) => [t.roots[0]?.name, t]));
    expect([...(trackByRoot.get("c")?.taskIds ?? [])].sort()).toEqual(["a", "b", "c"]);
    expect([...(trackByRoot.get("z")?.taskIds ?? [])].sort()).toEqual(["x", "y", "z"]);
    // Only the leaves (a and x) are ready.
    expect(trackByRoot.get("c")?.readyCount).toBe(1);
    expect(trackByRoot.get("z")?.readyCount).toBe(1);
  });

  it("three fully disconnected goals → three tracks", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "test", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "test", title: "C", impact: 50, effortDays: 1 });
    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(3);
    expect(tracks.map((t) => t.roots[0]?.name).sort()).toEqual(["a", "b", "c"]);
  });
});

// ─── Diamond merge (the killer feature) ────────────────────────────────

describe("getParallelTracks — diamond merge", () => {
  it("two goals sharing one prerequisite collapse into ONE merged track", () => {
    // shared
    //   ↑↑
    //   ││
    //  goal_a    goal_b
    addTask(db, {
      localId: "shared",
      workstream: "test",
      title: "Shared",
      impact: 80,
      effortDays: 1,
    });
    addTask(db, {
      localId: "goal_a",
      workstream: "test",
      title: "Goal A",
      impact: 80,
      effortDays: 1,
      blockedBy: ["shared"],
    });
    addTask(db, {
      localId: "goal_b",
      workstream: "test",
      title: "Goal B",
      impact: 80,
      effortDays: 1,
      blockedBy: ["shared"],
    });

    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.roots.map((r) => r.name).sort()).toEqual(["goal_a", "goal_b"]);
    expect([...(tracks[0]?.taskIds ?? [])].sort()).toEqual(["goal_a", "goal_b", "shared"]);
    // Only `shared` is ready.
    expect(tracks[0]?.readyCount).toBe(1);
  });

  it("two diamonds with independent shared bases → still independent (2 tracks)", () => {
    // First diamond
    addTask(db, { localId: "s1", workstream: "test", title: "S1", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "g1a",
      workstream: "test",
      title: "G1A",
      impact: 50,
      effortDays: 1,
      blockedBy: ["s1"],
    });
    addTask(db, {
      localId: "g1b",
      workstream: "test",
      title: "G1B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["s1"],
    });
    // Second diamond, completely separate
    addTask(db, { localId: "s2", workstream: "test", title: "S2", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "g2a",
      workstream: "test",
      title: "G2A",
      impact: 50,
      effortDays: 1,
      blockedBy: ["s2"],
    });
    addTask(db, {
      localId: "g2b",
      workstream: "test",
      title: "G2B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["s2"],
    });

    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(2);
    const trackTaskSets = tracks.map((t) => [...t.taskIds].sort());
    expect(trackTaskSets).toContainEqual(["g1a", "g1b", "s1"]);
    expect(trackTaskSets).toContainEqual(["g2a", "g2b", "s2"]);
  });

  it("transitive shared dependency: 3 goals → 1 merged track if any pair shares", () => {
    //   shared
    //     ↑↑↑
    //  g_a g_b g_c
    addTask(db, { localId: "shared", workstream: "test", title: "S", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "g_a",
      workstream: "test",
      title: "GA",
      impact: 50,
      effortDays: 1,
      blockedBy: ["shared"],
    });
    addTask(db, {
      localId: "g_b",
      workstream: "test",
      title: "GB",
      impact: 50,
      effortDays: 1,
      blockedBy: ["shared"],
    });
    addTask(db, {
      localId: "g_c",
      workstream: "test",
      title: "GC",
      impact: 50,
      effortDays: 1,
      blockedBy: ["shared"],
    });
    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.roots).toHaveLength(3);
  });

  it("chain of pairwise overlaps merges all three (transitive merge)", () => {
    // a, b share `x`; b, c share `y`. Should still merge all three into one track.
    addTask(db, { localId: "x", workstream: "test", title: "X", impact: 50, effortDays: 1 });
    addTask(db, { localId: "y", workstream: "test", title: "Y", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "a",
      workstream: "test",
      title: "A",
      impact: 50,
      effortDays: 1,
      blockedBy: ["x"],
    });
    addTask(db, {
      localId: "b",
      workstream: "test",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["x", "y"],
    });
    addTask(db, {
      localId: "c",
      workstream: "test",
      title: "C",
      impact: 50,
      effortDays: 1,
      blockedBy: ["y"],
    });
    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.roots.map((r) => r.name).sort()).toEqual(["a", "b", "c"]);
    expect([...(tracks[0]?.taskIds ?? [])].sort()).toEqual(["a", "b", "c", "x", "y"]);
  });
});

// ─── MVP step 6 acceptance: 10-task graph with one diamond ─────────────

describe("getParallelTracks — MVP acceptance graph (10 tasks, 1 diamond)", () => {
  beforeEach(() => {
    // Same graph the MVP acceptance test uses (test/acceptance.test.ts).
    addTask(db, {
      localId: "specs",
      workstream: "test",
      title: "Write specs",
      impact: 90,
      effortDays: 1,
    });
    addTask(db, {
      localId: "api",
      workstream: "test",
      title: "Design API",
      impact: 80,
      effortDays: 2,
      blockedBy: ["specs"],
    });
    addTask(db, {
      localId: "ui",
      workstream: "test",
      title: "Design UI",
      impact: 70,
      effortDays: 2,
      blockedBy: ["specs"],
    });
    addTask(db, {
      localId: "lib",
      workstream: "test",
      title: "Build shared lib",
      impact: 80,
      effortDays: 3,
      blockedBy: ["api", "ui"],
    });
    addTask(db, {
      localId: "backend",
      workstream: "test",
      title: "Build backend",
      impact: 80,
      effortDays: 5,
      blockedBy: ["lib"],
    });
    addTask(db, {
      localId: "frontend",
      workstream: "test",
      title: "Build frontend",
      impact: 70,
      effortDays: 5,
      blockedBy: ["lib"],
    });
    addTask(db, {
      localId: "tests",
      workstream: "test",
      title: "Write tests",
      impact: 60,
      effortDays: 3,
      blockedBy: ["backend", "frontend"],
    });
    addTask(db, {
      localId: "docs",
      workstream: "test",
      title: "Write docs",
      impact: 50,
      effortDays: 2,
      blockedBy: ["api", "ui"],
    });
    addTask(db, {
      localId: "deploy",
      workstream: "test",
      title: "Deploy to staging",
      impact: 70,
      effortDays: 1,
      blockedBy: ["tests"],
    });
    addTask(db, {
      localId: "launch",
      workstream: "test",
      title: "Launch",
      impact: 100,
      effortDays: 1,
      blockedBy: ["deploy", "docs"],
    });
  });

  it("collapses to one track because launch unifies everything", () => {
    // launch is the only goal. Everything is in its prereq subgraph.
    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.roots.map((r) => r.name)).toEqual(["launch"]);
    expect(tracks[0]?.taskIds.size).toBe(10);
    // Only `specs` is ready initially.
    expect(tracks[0]?.readyCount).toBe(1);
  });

  it("closing the only goal `launch` leaves zero tracks (no open goals)", () => {
    // The graph still has open intermediate tasks (deploy, docs, ...) but
    // they have outgoing edges TO launch, so they're not goals per the
    // schema's `goals` view ("tasks with no outgoing edges"). With the
    // only goal CLOSED, getParallelTracks returns nothing — a
    // graph-modeling smell the orchestrator should surface to the user.
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='launch'").run();
    expect(getParallelTracks(db, "test")).toEqual([]);
  });

  it("adding a second top-level goal alongside `launch` produces a diamond merge", () => {
    // Add `release_notes` as a second goal that also depends on docs.
    // Now the goals are { launch, release_notes }, and they share `docs`
    // (and everything below) — the diamond-merge should collapse them
    // into one track.
    addTask(db, {
      localId: "release_notes",
      workstream: "test",
      title: "Release notes",
      impact: 60,
      effortDays: 1,
      blockedBy: ["docs"],
    });
    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.roots.map((r) => r.name).sort()).toEqual(["launch", "release_notes"]);
    expect(tracks[0]?.taskIds.size).toBe(11);
  });

  it("readyCount tracks ROI eligibility correctly after a partial close", () => {
    // Close specs → api and ui both become ready.
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='specs'").run();
    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(1);
    // 2 ready (api, ui); specs is CLOSED so doesn't count as ready.
    expect(tracks[0]?.readyCount).toBe(2);
  });

  it("once a closed branch fully resolves, ready count drops accordingly", () => {
    // Close specs, api, ui, lib, backend, frontend, tests, docs, deploy.
    // Now only `launch` is ready.
    for (const id of [
      "specs",
      "api",
      "ui",
      "lib",
      "backend",
      "frontend",
      "tests",
      "docs",
      "deploy",
    ]) {
      db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id=?").run(id);
    }
    const tracks = getParallelTracks(db, "test");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.roots.map((r) => r.name)).toEqual(["launch"]);
    expect(tracks[0]?.readyCount).toBe(1);
  });
});

// ─── Output stability ──────────────────────────────────────────────────

describe("getParallelTracks — output is deterministic", () => {
  it("two-call equality on the same DB state", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "test", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "test", title: "C", impact: 50, effortDays: 1 });
    const t1 = getParallelTracks(db, "test");
    const t2 = getParallelTracks(db, "test");
    expect(t1.map((t) => t.roots.map((r) => r.name))).toEqual(
      t2.map((t) => t.roots.map((r) => r.name)),
    );
  });

  it("tracks are sorted by primary root id (deterministic)", () => {
    addTask(db, { localId: "z", workstream: "test", title: "Z", impact: 50, effortDays: 1 });
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "m", workstream: "test", title: "M", impact: 50, effortDays: 1 });
    const tracks = getParallelTracks(db, "test");
    expect(tracks.map((t) => t.roots[0]?.name)).toEqual(["a", "m", "z"]);
  });
});
