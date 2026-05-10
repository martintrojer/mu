// rejectTask / deferTask tests (terminal-but-blocking statuses,
// --cascade dry-run by default, --yes commits).
//
// Split out of test/tasks.test.ts under
// testreview_test_files_past_800loc — see test/tasks-crud.test.ts
// for the full split rationale. Lives separately from the rest of
// the lifecycle tests because reject/defer is its own cohesive
// surface (open-dependents check, three-way --cascade contract,
// strand-prevention) and pushed test/tasks-lifecycle.test.ts
// past the 800 LOC refactor signal.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  TaskHasOpenDependentsError,
  addTask,
  closeTask,
  deferTask,
  getTask,
  listBlocked,
  listGoals,
  listReady,
  listTasksByOwner,
  rejectTask,
  setTaskStatus,
} from "../src/tasks.js";
import { resetTmuxExecutor } from "../src/tmux.js";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-tasks-rd-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  resetTmuxExecutor();
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

// ─── reject / defer (terminal-but-blocking) ──────────────────────────────

describe("rejectTask / deferTask", () => {
  it("reject succeeds with no dependents and stamps REJECTED", () => {
    addTask(db, { localId: "alone", workstream: "ws", title: "A", impact: 50, effortDays: 1 });
    const r = rejectTask(db, "alone", { evidence: "out of scope", workstream: "ws" });
    expect(r.changed).toBe(true);
    expect(r.changedIds).toEqual(["alone"]);
    expect(r.status).toBe("REJECTED");
    expect(getTask(db, "alone", "ws")?.status).toBe("REJECTED");
  });

  it("defer succeeds with no dependents and stamps DEFERRED", () => {
    addTask(db, { localId: "park", workstream: "ws", title: "P", impact: 50, effortDays: 1 });
    const r = deferTask(db, "park", { evidence: "not now", workstream: "ws" });
    expect(r.changed).toBe(true);
    expect(getTask(db, "park", "ws")?.status).toBe("DEFERRED");
  });

  it("idempotent: rejecting an already-REJECTED task with no dependents is a no-op", () => {
    addTask(db, { localId: "alone", workstream: "ws", title: "A", impact: 50, effortDays: 1 });
    rejectTask(db, "alone", { workstream: "ws" });
    const r = rejectTask(db, "alone", { workstream: "ws" });
    expect(r.changed).toBe(false);
    expect(r.changedIds).toEqual([]);
  });

  it("REFUSES with TaskHasOpenDependentsError when an OPEN dependent would be stranded", () => {
    addTask(db, { localId: "design", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "build",
      workstream: "ws",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    expect(() => rejectTask(db, "design", { workstream: "ws" })).toThrow(
      TaskHasOpenDependentsError,
    );
    // Root task untouched after the throw.
    expect(getTask(db, "design", "ws")?.status).toBe("OPEN");
  });

  it("REFUSES on IN_PROGRESS dependent too (not just OPEN)", () => {
    addTask(db, { localId: "design", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "build",
      workstream: "ws",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    setTaskStatus(db, "build", "IN_PROGRESS", { workstream: "ws" });
    expect(() => deferTask(db, "design", { workstream: "ws" })).toThrow(TaskHasOpenDependentsError);
  });

  it("ALLOWS reject when the only dependent is already CLOSED (nothing to strand)", () => {
    addTask(db, { localId: "design", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "build",
      workstream: "ws",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    closeTask(db, "build", { workstream: "ws" });
    const r = rejectTask(db, "design", { workstream: "ws" });
    expect(r.changed).toBe(true);
    expect(r.changedIds).toEqual(["design"]);
  });

  it("ALLOWS reject when dependent is REJECTED/DEFERRED already (terminal/parked, not stranded)", () => {
    addTask(db, { localId: "design", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "build_a",
      workstream: "ws",
      title: "Ba",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    addTask(db, {
      localId: "build_b",
      workstream: "ws",
      title: "Bb",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    // Reject one dependent, defer the other (each is leaf — no further deps).
    rejectTask(db, "build_a", { workstream: "ws" });
    deferTask(db, "build_b", { workstream: "ws" });
    // Now design has no OPEN/IN_PROGRESS dependents → reject succeeds.
    const r = rejectTask(db, "design", { workstream: "ws" });
    expect(r.changed).toBe(true);
    expect(r.changedIds).toEqual(["design"]);
  });

  it("--cascade applies the same status to every transitive open dependent", () => {
    // design <- build <- review chain.
    addTask(db, { localId: "design", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "build",
      workstream: "ws",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    addTask(db, {
      localId: "review",
      workstream: "ws",
      title: "R",
      impact: 50,
      effortDays: 1,
      blockedBy: ["build"],
    });
    const r = rejectTask(db, "design", {
      cascade: true,
      yes: true,
      evidence: "feature dropped",
      workstream: "ws",
    });
    expect(r.changed).toBe(true);
    expect(new Set(r.changedIds)).toEqual(new Set(["design", "build", "review"]));
    expect(getTask(db, "design", "ws")?.status).toBe("REJECTED");
    expect(getTask(db, "build", "ws")?.status).toBe("REJECTED");
    expect(getTask(db, "review", "ws")?.status).toBe("REJECTED");
  });

  it("--cascade DEFERRED leaves CLOSED dependents alone (only OPEN/IN_PROGRESS swept)", () => {
    addTask(db, { localId: "design", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "build",
      workstream: "ws",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    addTask(db, {
      localId: "ship",
      workstream: "ws",
      title: "S",
      impact: 50,
      effortDays: 1,
      blockedBy: ["build"],
    });
    closeTask(db, "build", { workstream: "ws" }); // already shipped this one
    // Cascade defer from design: build is CLOSED so untouched; ship has no
    // open dependents but is open itself and depends transitively on design
    // through CLOSED build — and CLOSED satisfies the edge → ship is NOT
    // an open dependent of design via the open-dependents query.
    const r = deferTask(db, "design", { cascade: true, yes: true, workstream: "ws" });
    expect(r.changed).toBe(true);
    expect(getTask(db, "design", "ws")?.status).toBe("DEFERRED");
    expect(getTask(db, "build", "ws")?.status).toBe("CLOSED");
    // ship is independent of design once build closed; defer didn't touch it.
    expect(getTask(db, "ship", "ws")?.status).toBe("OPEN");
  });

  it("REJECTED and DEFERRED still BLOCK downstream (only CLOSED satisfies a blocked-by edge)", () => {
    addTask(db, { localId: "rj", workstream: "ws", title: "R", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "dep_r",
      workstream: "ws",
      title: "DR",
      impact: 50,
      effortDays: 1,
      blockedBy: ["rj"],
    });
    addTask(db, { localId: "df", workstream: "ws", title: "Df", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "dep_d",
      workstream: "ws",
      title: "DD",
      impact: 50,
      effortDays: 1,
      blockedBy: ["df"],
    });
    // First reject/defer the leaves' siblings to clear the strand check.
    // Actually we WANT depR to remain OPEN to test that it's still BLOCKED.
    // So reject/defer rj and df WITH --cascade so the dep tasks come
    // along too — but then we can't observe blocking. Use a different
    // setup: directly stamp via setTaskStatus to bypass the check.
    setTaskStatus(db, "rj", "REJECTED", { workstream: "ws" });
    setTaskStatus(db, "df", "DEFERRED", { workstream: "ws" });
    // dep_r / dep_d should be in `blocked` view, NOT in `ready` view.
    const ready = listReady(db, "ws").map((t) => t.name);
    const blocked = listBlocked(db, "ws").map((t) => t.name);
    expect(ready).not.toContain("dep_r");
    expect(ready).not.toContain("dep_d");
    expect(blocked).toContain("dep_r");
    expect(blocked).toContain("dep_d");
  });

  it("REJECTED and DEFERRED leaves are NOT goals (excluded from listGoals)", () => {
    addTask(db, { localId: "open_leaf", workstream: "ws", title: "OL", impact: 50, effortDays: 1 });
    addTask(db, { localId: "rej_leaf", workstream: "ws", title: "RL", impact: 50, effortDays: 1 });
    addTask(db, { localId: "def_leaf", workstream: "ws", title: "DL", impact: 50, effortDays: 1 });
    setTaskStatus(db, "rej_leaf", "REJECTED", { workstream: "ws" });
    setTaskStatus(db, "def_leaf", "DEFERRED", { workstream: "ws" });
    const goals = listGoals(db, "ws").map((g) => g.name);
    expect(goals).toContain("open_leaf");
    expect(goals).not.toContain("rej_leaf");
    expect(goals).not.toContain("def_leaf");
  });

  it("listTasksByOwner default omits REJECTED and DEFERRED (live-work view)", () => {
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1", status: "busy" });
    addTask(db, { localId: "live", workstream: "ws", title: "L", impact: 50, effortDays: 1 });
    addTask(db, { localId: "rej", workstream: "ws", title: "R", impact: 50, effortDays: 1 });
    addTask(db, { localId: "def", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    db.prepare(
      `UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'w1')
        WHERE local_id IN ('live','rej','def')`,
    ).run();
    setTaskStatus(db, "rej", "REJECTED", { workstream: "ws" });
    setTaskStatus(db, "def", "DEFERRED", { workstream: "ws" });
    expect(listTasksByOwner(db, "ws", "w1").map((t) => t.name)).toEqual(["live"]);
    expect(
      listTasksByOwner(db, "ws", "w1", { includeClosed: true })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["def", "live", "rej"]);
  });
});

// ─── TASK_STATUS_LIST drift guard ────────────────────────────────────
// ─── --cascade dry-run by default; --yes commits ─────────────────────

describe("rejectTask / deferTask --cascade dry-run", () => {
  it("--cascade WITHOUT --yes returns dryRun:true and does NOT touch the DB", () => {
    addTask(db, { localId: "design", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "build",
      workstream: "ws",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    const r = rejectTask(db, "design", { cascade: true, workstream: "ws" });
    // dryRun shape
    expect(r.dryRun).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.changedIds).toEqual(["design", "build"]); // would-affect list
    expect(r.affectedIds).toEqual(["design", "build"]);
    // DB unchanged
    expect(getTask(db, "design", "ws")?.status).toBe("OPEN");
    expect(getTask(db, "build", "ws")?.status).toBe("OPEN");
  });

  it("--cascade --yes commits the sweep (matches the old default behaviour)", () => {
    addTask(db, { localId: "design", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "build",
      workstream: "ws",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    const r = rejectTask(db, "design", { cascade: true, yes: true, workstream: "ws" });
    expect(r.dryRun).toBe(false);
    expect(r.changed).toBe(true);
    expect(new Set(r.changedIds)).toEqual(new Set(["design", "build"]));
    expect(getTask(db, "design", "ws")?.status).toBe("REJECTED");
    expect(getTask(db, "build", "ws")?.status).toBe("REJECTED");
  });

  it("single-task case (no dependents) skips the dry-run and commits immediately", () => {
    // No --yes needed when there's nothing to preview.
    addTask(db, { localId: "alone", workstream: "ws", title: "A", impact: 50, effortDays: 1 });
    const r = rejectTask(db, "alone", { cascade: true, workstream: "ws" });
    expect(r.dryRun).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.changedIds).toEqual(["alone"]);
    expect(r.affectedIds).toEqual(["alone"]);
    expect(getTask(db, "alone", "ws")?.status).toBe("REJECTED");
  });

  it("affectedIds is populated even on commit (so callers can report what was swept)", () => {
    addTask(db, { localId: "design", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "build",
      workstream: "ws",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["design"],
    });
    const r = rejectTask(db, "design", { cascade: true, yes: true, workstream: "ws" });
    expect(r.affectedIds).toEqual(["design", "build"]);
  });
});
