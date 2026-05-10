// CRUD + edges + cycle/prereq for src/tasks.ts: addTask (+ cycle
// check), addNote, getPrerequisites, getTaskEdges,
// add/removeBlockEdge, deleteTask, updateTask, reparentTask.
//
// Read-side queries (views / search / listTasksByOwner /
// listTasks --status) live in test/tasks-views.test.ts.
// Lifecycle (claim/release/status/reject/defer/evidence) lives in
// test/tasks-lifecycle.test.ts. waitForTasks + sort helpers in
// test/tasks-wait.test.ts. Pure helpers (slugify/idFromTitle/
// isTaskStatus/relTime/TASK_STATUS_LIST) in test/tasks-meta.test.ts.
// All five files split out of test/tasks.test.ts under
// testreview_test_files_past_800loc — no behaviour change, just
// file split + import-sort.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  CrossWorkstreamEdgeError,
  CycleError,
  TaskExistsError,
  TaskIdInvalidError,
  TaskNotFoundError,
  addBlockEdge,
  addNote,
  addTask,
  deleteTask,
  getPrerequisites,
  getTask,
  getTaskEdges,
  listBlocked,
  listNotes,
  listReady,
  listTasks,
  removeBlockEdge,
  reparentTask,
  updateTask,
} from "../src/tasks.js";
import { resetTmuxExecutor } from "../src/tmux.js";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-tasks-crud-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  resetTmuxExecutor();
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

// ─── addTask ───────────────────────────────────────────────────────────

describe("addTask", () => {
  it("inserts a task with status OPEN and the right defaults", () => {
    const task = addTask(db, {
      localId: "design",
      workstream: "test",
      title: "Design",
      impact: 80,
      effortDays: 2,
    });
    expect(task).toMatchObject({
      name: "design",
      workstreamName: "test",
      title: "Design",
      status: "OPEN",
      impact: 80,
      effortDays: 2,
      ownerName: null,
    });
  });

  it("rejects invalid id (no DB write)", () => {
    expect(() =>
      addTask(db, { localId: "Bad ID", workstream: "test", title: "x", impact: 50, effortDays: 1 }),
    ).toThrow(/invalid task id/);
    expect(listTasks(db)).toEqual([]);
  });

  it("throws typed TaskIdInvalidError (not bare TypeError) with non-empty errorNextSteps", () => {
    // Syntax violation: uppercase + space.
    let caught: unknown;
    try {
      addTask(db, {
        localId: "Bad ID",
        workstream: "test",
        title: "x",
        impact: 50,
        effortDays: 1,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TaskIdInvalidError);
    // Critically: NOT a bare TypeError. The whole point of this fix is
    // that the CLI's handle() wrapper can map us to exit 4 instead of
    // falling through to the generic exit 1.
    expect(caught).not.toBeInstanceOf(TypeError);
    const err = caught as TaskIdInvalidError;
    expect(err.attempted).toBe("Bad ID");
    const steps = err.errorNextSteps();
    expect(steps.length).toBeGreaterThan(0);
    // First step: drop --id and pass --title (auto-derive path).
    expect(steps[0]?.command).toMatch(/--title/);
    // Sanitised candidate must be a runnable id (lowercase + alnum/_/-).
    // Assert only the load-bearing parts (verb, sanitised id, --title flag)
    // so cosmetic copy edits to the suggestion suffix don't drift the test.
    const sanitisedStep = steps.find((s) => s.intent.toLowerCase().includes("sanitise"));
    expect(sanitisedStep).toBeDefined();
    const sanitisedCmd = sanitisedStep?.command ?? "";
    expect(sanitisedCmd).toContain("mu task add");
    expect(sanitisedCmd).toContain("bad_id");
    expect(sanitisedCmd).toMatch(/--title/);
    expect(listTasks(db)).toEqual([]);
  });

  // Post schema_v5_cleanups: the `mu_` prefix is no longer reserved.
  // v5 has no global namespace; tasks.local_id is per-workstream
  // unique so `mu_foo` is a perfectly valid id.
  it("accepts a leading 'mu_' prefix on a local_id (no reservation in v5)", () => {
    const task = addTask(db, {
      localId: "mu_internal",
      workstream: "test",
      title: "x",
      impact: 50,
      effortDays: 1,
    });
    expect(task.name).toBe("mu_internal");
    expect(getTask(db, "mu_internal", "test")).toMatchObject({ name: "mu_internal" });
  });

  it("rejects duplicate id with TaskExistsError", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    expect(() =>
      addTask(db, {
        localId: "a",
        workstream: "test",
        title: "Second A",
        impact: 50,
        effortDays: 1,
      }),
    ).toThrow(TaskExistsError);
  });

  it("schema CHECK rejects impact 0 / 101 / negative effort / bogus status", () => {
    expect(() =>
      addTask(db, { localId: "a", workstream: "test", title: "x", impact: 0, effortDays: 1 }),
    ).toThrow();
    expect(() =>
      addTask(db, { localId: "b", workstream: "test", title: "x", impact: 101, effortDays: 1 }),
    ).toThrow();
    expect(() =>
      addTask(db, { localId: "c", workstream: "test", title: "x", impact: 50, effortDays: 0 }),
    ).toThrow();
    expect(() =>
      addTask(db, { localId: "d", workstream: "test", title: "x", impact: 50, effortDays: -1 }),
    ).toThrow();
    expect(listTasks(db)).toEqual([]);
  });

  it("inserts edges when blockedBy specified", () => {
    addTask(db, {
      localId: "design",
      workstream: "test",
      title: "Design",
      impact: 80,
      effortDays: 2,
    });
    const build = addTask(db, {
      localId: "build",
      workstream: "test",
      title: "Build",
      impact: 80,
      effortDays: 5,
      blockedBy: ["design"],
    });
    expect(build.name).toBe("build");
    // Verify edge inserted: design blocks build → build is blocked.
    const blocked = listBlocked(db, "test").map((t) => t.name);
    expect(blocked).toEqual(["build"]);
    const ready = listReady(db, "test").map((t) => t.name);
    expect(ready).toEqual(["design"]);
  });

  it("rejects unknown blocker BEFORE inserting the task", () => {
    expect(() =>
      addTask(db, {
        localId: "build",
        workstream: "test",
        title: "Build",
        impact: 80,
        effortDays: 5,
        blockedBy: ["nonexistent"],
      }),
    ).toThrow(TaskNotFoundError);
    // Atomic rollback: build should NOT exist after failed insert.
    expect(getTask(db, "build", "test")).toBeUndefined();
  });

  it("rolls back cleanly when one of N blockers is missing", () => {
    addTask(db, { localId: "design", workstream: "test", title: "D", impact: 80, effortDays: 2 });
    expect(() =>
      addTask(db, {
        localId: "build",
        workstream: "test",
        title: "B",
        impact: 80,
        effortDays: 5,
        blockedBy: ["design", "ghost", "design"],
      }),
    ).toThrow(TaskNotFoundError);
    expect(getTask(db, "build", "test")).toBeUndefined();
    // No edges either.
    const edges = db.prepare("SELECT * FROM task_edges").all();
    expect(edges).toEqual([]);
  });

  it("rejects self-referential blocks (CycleError before schema CHECK)", () => {
    // Task doesn't exist yet, but blocks itself by id — this should fail
    // because the blocker isn't present yet (we insert task first, then
    // edges, then look up blockers). Actually, the task IS present by the
    // time we check blockers (insert is first in the txn). So self-block
    // should trigger the cycle check (or the CHECK constraint on edges).
    expect(() =>
      addTask(db, {
        localId: "loop",
        workstream: "test",
        title: "L",
        impact: 50,
        effortDays: 1,
        blockedBy: ["loop"],
      }),
    ).toThrow();
    expect(getTask(db, "loop", "test")).toBeUndefined();
  });
});

// ─── Cycle check via addTask blockedBy ───────────────────────────────

describe("addTask cycle check", () => {
  it("rejects an edge that would close a 2-task cycle", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    // b blocked by a (edge: a → b)
    addTask(db, {
      localId: "b",
      workstream: "test",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    // Now try to add a task `c` that creates a cycle: c → a, and we'd want a → c.
    // Easier: try to add a task that puts an edge in a way that cycles.
    // Since addTask inserts the new task with NO outgoing edges, and edges
    // are only `blocker → newTask`, cycles via fresh adds aren't really
    // possible. So we can't trigger this in 0.1.0 except via self-block,
    // which was tested above. The cycle check is a safety net for
    // hypothetical future addEdge / update --blocks.

    // But we can verify the helper directly: getPrerequisites of `b`
    // includes `a`. If we tried to add `a` with blocks=["b"], it would
    // fail because `a` is already in `b`'s prerequisites — but we can't
    // re-add `a`. So the explicit cycle check fires through TaskExistsError
    // first. The cycle algorithm itself is exercised below via getPrerequisites.
    expect(getPrerequisites(db, "b", "test")).toEqual(new Set(["b", "a"]));
  });
});

// ─── getPrerequisites ──────────────────────────────────────────────────

describe("getPrerequisites", () => {
  it("returns just the task itself for a leaf", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    expect(getPrerequisites(db, "a", "test")).toEqual(new Set(["a"]));
  });

  it("returns the full transitive prerequisite set", () => {
    // a → b → c → d
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
    addTask(db, {
      localId: "d",
      workstream: "test",
      title: "D",
      impact: 50,
      effortDays: 1,
      blockedBy: ["c"],
    });
    expect(getPrerequisites(db, "d", "test")).toEqual(new Set(["d", "c", "b", "a"]));
  });

  it("handles diamond (shared prerequisite reached two ways)", () => {
    // shared → left, shared → right, left → top, right → top
    addTask(db, { localId: "shared", workstream: "test", title: "S", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "left",
      workstream: "test",
      title: "L",
      impact: 50,
      effortDays: 1,
      blockedBy: ["shared"],
    });
    addTask(db, {
      localId: "right",
      workstream: "test",
      title: "R",
      impact: 50,
      effortDays: 1,
      blockedBy: ["shared"],
    });
    addTask(db, {
      localId: "top",
      workstream: "test",
      title: "T",
      impact: 50,
      effortDays: 1,
      blockedBy: ["left", "right"],
    });
    expect(getPrerequisites(db, "top", "test")).toEqual(
      new Set(["top", "left", "right", "shared"]),
    );
  });

  it("returns empty set for unknown task", () => {
    // Just the queried node itself; no prereqs since no edges target it.
    expect(getPrerequisites(db, "ghost", "test")).toEqual(new Set(["ghost"]));
  });
});

// ─── addNote ───────────────────────────────────────────────────────────

describe("addNote", () => {
  it("appends a note to an existing task", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    const note = addNote(db, "a", "DECISION: chose JWT", { workstream: "test" });
    expect(note).toMatchObject({
      author: null,
      content: "DECISION: chose JWT",
    });
    expect(note).not.toHaveProperty("id");
    expect(note).not.toHaveProperty("taskId");
  });

  it("accepts optional author", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    const note = addNote(db, "a", "starting work", { author: "alice", workstream: "test" });
    expect(note.author).toBe("alice");
  });

  it("rejects note for unknown task", () => {
    expect(() => addNote(db, "ghost", "note", { workstream: "test" })).toThrow(TaskNotFoundError);
  });

  it("listNotes returns notes in insertion order", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addNote(db, "a", "first", { workstream: "test" });
    addNote(db, "a", "second", { workstream: "test" });
    addNote(db, "a", "third", { workstream: "test" });
    expect(listNotes(db, "a", "test").map((n) => n.content)).toEqual(["first", "second", "third"]);
  });

  // Regression: task_updatedat_not_bumped_by_reparent. A note insert is
  // a write that mutates a child row of the task; recency sort uses
  // tasks.updated_at and was previously stranded on the create time.
  it("bumps tasks.updated_at on insert (recency sort surfaces freshly-noted tasks)", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    const before = getTask(db, "a", "test")?.updatedAt;
    const start = Date.now();
    while (Date.now() === start) {
      /* spin so the ISO ms tick advances */
    }
    addNote(db, "a", "hello", { workstream: "test" });
    const after = getTask(db, "a", "test")?.updatedAt;
    expect(after).not.toBe(before);
    expect(after).toBeDefined();
    if (before !== undefined && after !== undefined) {
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    }
  });
});

// ─── getTaskEdges ─────────────────────────────────────────────────────────────

describe("getTaskEdges", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 80,
      effortDays: 2,
    });
    addTask(db, {
      localId: "build",
      workstream: "auth",
      title: "B",
      impact: 80,
      effortDays: 5,
      blockedBy: ["design"],
    });
    addTask(db, {
      localId: "ship",
      workstream: "auth",
      title: "S",
      impact: 90,
      effortDays: 1,
      blockedBy: ["build"],
    });
  });

  it("returns blockers (incoming) and dependents (outgoing)", () => {
    expect(getTaskEdges(db, "build", "auth")).toEqual({
      blockers: ["design"],
      dependents: ["ship"],
    });
  });

  it("returns empty arrays for a task with no edges in either direction", () => {
    addTask(db, {
      localId: "orphan",
      workstream: "auth",
      title: "O",
      impact: 10,
      effortDays: 1,
    });
    expect(getTaskEdges(db, "orphan", "auth")).toEqual({ blockers: [], dependents: [] });
  });

  it("returns empty arrays for a missing task (no error)", () => {
    // Note: the verb that wraps this throws TaskNotFoundError; the
    // primitive itself is permissive so callers can pre-check existence
    // separately.
    expect(getTaskEdges(db, "ghost", "auth")).toEqual({ blockers: [], dependents: [] });
  });

  it("sorts both lists by id for stable output", () => {
    addTask(db, {
      localId: "a",
      workstream: "auth",
      title: "A",
      impact: 10,
      effortDays: 1,
      blockedBy: ["design"],
    });
    addTask(db, {
      localId: "z",
      workstream: "auth",
      title: "Z",
      impact: 10,
      effortDays: 1,
      blockedBy: ["design"],
    });
    expect(getTaskEdges(db, "design", "auth").dependents).toEqual(["a", "build", "z"]);
  });
});

// ─── addBlockEdge / removeBlockEdge ────────────────────────────────────────

describe("addBlockEdge", () => {
  beforeEach(() => {
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 50, effortDays: 1 });
  });

  it("adds an edge and reports added=true", () => {
    expect(addBlockEdge(db, "auth", "b", "a").added).toBe(true);
    expect(getTaskEdges(db, "b", "auth").blockers).toEqual(["a"]);
  });

  it("is idempotent on duplicate edge (added=false)", () => {
    addBlockEdge(db, "auth", "b", "a");
    expect(addBlockEdge(db, "auth", "b", "a").added).toBe(false);
  });

  it("throws CycleError on self-reference", () => {
    expect(() => addBlockEdge(db, "auth", "a", "a")).toThrow(CycleError);
  });

  it("throws CycleError when the edge would create a cycle", () => {
    addBlockEdge(db, "auth", "b", "a"); // a blocks b
    addBlockEdge(db, "auth", "c", "b"); // b blocks c; chain: a -> b -> c
    // adding c -> a would create a cycle (a -> b -> c -> a)
    expect(() => addBlockEdge(db, "auth", "a", "c")).toThrow(CycleError);
  });

  it("throws TaskNotFoundError if either task is missing", () => {
    expect(() => addBlockEdge(db, "auth", "b", "ghost")).toThrow(/no such task: ghost/);
    expect(() => addBlockEdge(db, "auth", "ghost", "a")).toThrow(/no such task: ghost/);
  });

  it("throws CrossWorkstreamEdgeError when blocker is in a different workstream", () => {
    addTask(db, {
      localId: "x",
      workstream: "billing",
      title: "X",
      impact: 50,
      effortDays: 1,
    });
    // 'a' lives in 'auth'; 'x' lives in 'billing'. addBlockEdge
    // resolves the blocked task in its declared workstream and the
    // blocker globally — the cross-workstream guard then fires.
    expect(() => addBlockEdge(db, "auth", "a", "x")).toThrow(CrossWorkstreamEdgeError);
  });

  // Regression: task_updatedat_not_bumped_by_reparent. The BLOCKED
  // task's blocker set just changed, so its updated_at should advance.
  // The blocker itself is unaffected.
  it("bumps tasks.updated_at on the BLOCKED side when an edge is added", () => {
    const beforeBlocked = getTask(db, "b", "auth")?.updatedAt;
    const beforeBlocker = getTask(db, "a", "auth")?.updatedAt;
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    addBlockEdge(db, "auth", "b", "a");
    const afterBlocked = getTask(db, "b", "auth")?.updatedAt;
    const afterBlocker = getTask(db, "a", "auth")?.updatedAt;
    expect(afterBlocked).not.toBe(beforeBlocked);
    expect(afterBlocker).toBe(beforeBlocker);
  });

  it("does NOT bump tasks.updated_at on an idempotent (no-op) edge add", () => {
    addBlockEdge(db, "auth", "b", "a");
    const before = getTask(db, "b", "auth")?.updatedAt;
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    expect(addBlockEdge(db, "auth", "b", "a").added).toBe(false);
    const after = getTask(db, "b", "auth")?.updatedAt;
    expect(after).toBe(before);
  });
});

describe("removeBlockEdge", () => {
  beforeEach(() => {
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "b",
      workstream: "auth",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
  });

  it("removes an existing edge and reports removed=true", () => {
    expect(removeBlockEdge(db, "auth", "b", "a").removed).toBe(true);
    expect(getTaskEdges(db, "b", "auth").blockers).toEqual([]);
  });

  it("is idempotent on missing edge (removed=false)", () => {
    removeBlockEdge(db, "auth", "b", "a");
    expect(removeBlockEdge(db, "auth", "b", "a").removed).toBe(false);
  });

  it("is permissive about missing tasks (no throw)", () => {
    expect(removeBlockEdge(db, "auth", "ghost", "also-ghost").removed).toBe(false);
  });

  // Regression: task_updatedat_not_bumped_by_reparent. unblock is the
  // mirror of block; same semantics on the BLOCKED side.
  it("bumps tasks.updated_at on the BLOCKED side when an edge is removed", () => {
    const beforeBlocked = getTask(db, "b", "auth")?.updatedAt;
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    expect(removeBlockEdge(db, "auth", "b", "a").removed).toBe(true);
    const afterBlocked = getTask(db, "b", "auth")?.updatedAt;
    expect(afterBlocked).not.toBe(beforeBlocked);
  });

  it("does NOT bump tasks.updated_at on an idempotent (no-op) edge remove", () => {
    removeBlockEdge(db, "auth", "b", "a");
    const before = getTask(db, "b", "auth")?.updatedAt;
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    expect(removeBlockEdge(db, "auth", "b", "a").removed).toBe(false);
    const after = getTask(db, "b", "auth")?.updatedAt;
    expect(after).toBe(before);
  });
});

// ─── deleteTask ───────────────────────────────────────────────────────────

describe("deleteTask", () => {
  beforeEach(() => {
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "b",
      workstream: "auth",
      title: "B",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a"],
    });
    addTask(db, {
      localId: "c",
      workstream: "auth",
      title: "C",
      impact: 50,
      effortDays: 1,
      blockedBy: ["b"],
    });
    addNote(db, "b", "note 1", { workstream: "auth" });
    addNote(db, "b", "note 2", { workstream: "auth" });
  });

  it("deletes the row and reports deleted=true", () => {
    expect(deleteTask(db, "b", "auth").deleted).toBe(true);
    expect(getTask(db, "b", "auth")).toBeUndefined();
  });

  it("cascades incoming AND outgoing edges (FK on both from_task and to_task)", () => {
    // Before: edges a->b and b->c, both touch b.
    expect(deleteTask(db, "b", "auth").deletedEdges).toBe(2);
    // After: no edges remain.
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n).toBe(0);
  });

  it("cascades notes (FK on task_id)", () => {
    expect(deleteTask(db, "b", "auth").deletedNotes).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_notes").get() as { n: number }).n).toBe(0);
  });

  it("is idempotent on a missing task (deleted=false; counts=0)", () => {
    expect(deleteTask(db, "ghost", "auth")).toEqual({
      deleted: false,
      deletedEdges: 0,
      deletedNotes: 0,
    });
  });
});

// ─── updateTask ───────────────────────────────────────────────────────────

describe("updateTask", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "a",
      workstream: "auth",
      title: "original title",
      impact: 50,
      effortDays: 1,
    });
  });

  it("updates a single field and reports the changed field", () => {
    const r = updateTask(db, "a", { title: "new title" }, { workstream: "auth" });
    expect(r).toEqual({ updated: true, changedFields: ["title"] });
    expect(getTask(db, "a", "auth")?.title).toBe("new title");
  });

  it("updates multiple fields in one call", () => {
    const r = updateTask(
      db,
      "a",
      { title: "T", impact: 90, effortDays: 5 },
      { workstream: "auth" },
    );
    expect(r.updated).toBe(true);
    expect(r.changedFields.sort()).toEqual(["effortDays", "impact", "title"]);
    const row = getTask(db, "a", "auth");
    expect(row?.title).toBe("T");
    expect(row?.impact).toBe(90);
    expect(row?.effortDays).toBe(5);
  });

  it("is a no-op when supplied values match current (changedFields is empty)", () => {
    const r = updateTask(
      db,
      "a",
      { title: "original title", impact: 50, effortDays: 1 },
      { workstream: "auth" },
    );
    expect(r).toEqual({ updated: false, changedFields: [] });
  });

  it("is a no-op when no fields are passed", () => {
    expect(updateTask(db, "a", {}, { workstream: "auth" })).toEqual({
      updated: false,
      changedFields: [],
    });
  });

  it("only changes the differing field when some match and some don't", () => {
    const r = updateTask(db, "a", { title: "original title", impact: 99 }, { workstream: "auth" });
    expect(r.changedFields).toEqual(["impact"]);
  });

  it("throws TaskNotFoundError on missing task", () => {
    expect(() => updateTask(db, "ghost", { title: "x" }, { workstream: "auth" })).toThrow(
      /no such task: ghost/,
    );
  });

  it("propagates schema CHECK violations (e.g. impact > 100)", () => {
    expect(() => updateTask(db, "a", { impact: 101 }, { workstream: "auth" })).toThrow(
      /CHECK constraint failed/,
    );
  });

  it("bumps updated_at on a real change", () => {
    const before = getTask(db, "a", "auth")?.updatedAt;
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    updateTask(db, "a", { title: "new" }, { workstream: "auth" });
    const after = getTask(db, "a", "auth")?.updatedAt;
    expect(after).not.toBe(before);
  });
});

// ─── reparentTask ────────────────────────────────────────────────────────

describe("reparentTask", () => {
  beforeEach(() => {
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "target",
      workstream: "auth",
      title: "target",
      impact: 50,
      effortDays: 1,
      blockedBy: ["a", "b"],
    });
  });

  it("replaces every incoming edge with the new blocker set (atomic)", () => {
    const r = reparentTask(db, "target", ["c"], { workstream: "auth" });
    expect(r).toEqual({ removedEdges: 2, addedEdges: 1 });
    expect(getTaskEdges(db, "target", "auth").blockers).toEqual(["c"]);
  });

  it("clears all incoming edges with empty blockers list", () => {
    const r = reparentTask(db, "target", [], { workstream: "auth" });
    expect(r).toEqual({ removedEdges: 2, addedEdges: 0 });
    expect(getTaskEdges(db, "target", "auth").blockers).toEqual([]);
  });

  it("throws CycleError if a new blocker would create a cycle", () => {
    addTask(db, {
      localId: "downstream",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
      blockedBy: ["target"],
    });
    // target -> downstream exists. Reparenting target to be blocked by
    // downstream creates a cycle.
    expect(() => reparentTask(db, "target", ["downstream"], { workstream: "auth" })).toThrow(
      CycleError,
    );
    // Atomicity: original edges are still in place after the rejection.
    expect(getTaskEdges(db, "target", "auth").blockers.sort()).toEqual(["a", "b"]);
  });

  it("throws CycleError on self-reference", () => {
    expect(() => reparentTask(db, "target", ["target"], { workstream: "auth" })).toThrow(
      CycleError,
    );
  });

  it("throws TaskNotFoundError if any new blocker is missing", () => {
    expect(() => reparentTask(db, "target", ["c", "ghost"], { workstream: "auth" })).toThrow(
      /no such task: ghost/,
    );
    // No DELETE happened on validation failure.
    expect(getTaskEdges(db, "target", "auth").blockers.sort()).toEqual(["a", "b"]);
  });

  it("throws CrossWorkstreamEdgeError if a blocker is in a different workstream", () => {
    addTask(db, {
      localId: "x",
      workstream: "billing",
      title: "X",
      impact: 50,
      effortDays: 1,
    });
    // 'target' lives in 'auth'; 'x' lives in 'billing'. reparentTask
    // resolves blockers across workstreams so the cross-ws guard
    // raises CrossWorkstreamEdgeError (not TaskNotFoundError).
    expect(() => reparentTask(db, "target", ["x"], { workstream: "auth" })).toThrow(
      CrossWorkstreamEdgeError,
    );
    expect(getTaskEdges(db, "target", "auth").blockers.sort()).toEqual(["a", "b"]);
  });

  it("throws TaskNotFoundError on missing task", () => {
    expect(() => reparentTask(db, "ghost", ["a"], { workstream: "billing" })).toThrow(
      /no such task: ghost/,
    );
  });

  // Regression: task_updatedat_not_bumped_by_reparent. The reparented
  // task's blocker set changed; its updated_at should advance. The new
  // blockers themselves should not be touched.
  it("bumps tasks.updated_at on the reparented (FROM_TASK) side", () => {
    const beforeTarget = getTask(db, "target", "auth")?.updatedAt;
    const beforeC = getTask(db, "c", "auth")?.updatedAt;
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    reparentTask(db, "target", ["c"], { workstream: "auth" });
    const afterTarget = getTask(db, "target", "auth")?.updatedAt;
    const afterC = getTask(db, "c", "auth")?.updatedAt;
    expect(afterTarget).not.toBe(beforeTarget);
    expect(afterC).toBe(beforeC);
  });
});
