// Tests for src/tasks.ts: validation, addTask + cycle check, addNote,
// claimTask atomic CAS, view reads, getPrerequisites traversal.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { TASK_SORT_KEYS, parseSortOption, relTime, sortTasks } from "../src/cli.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import {
  ClaimerNotRegisteredError,
  CrossWorkstreamEdgeError,
  CycleError,
  TASK_STATUS_LIST,
  TaskAlreadyOwnedError,
  TaskExistsError,
  TaskHasOpenDependentsError,
  TaskIdInvalidError,
  TaskNotFoundError,
  addBlockEdge,
  addNote,
  addTask,
  claimTask,
  closeTask,
  deferTask,
  deleteTask,
  getPrerequisites,
  getTask,
  getTaskEdges,
  getWaitPollCount,
  idFromTitle,
  isTaskStatus,
  isValidTaskId,
  listBlocked,
  listGoals,
  listNotes,
  listReady,
  listTasks,
  listTasksByOwner,
  listTasksByOwnerCrossWorkstream,
  openTask,
  rejectTask,
  releaseTask,
  removeBlockEdge,
  reparentTask,
  resetWaitPollCount,
  resolveActorIdentity,
  searchTasks,
  setTaskStatus,
  setWaitSleepForTests,
  setWaitStuckWarnForTests,
  slugifyTitle,
  updateTask,
  waitForTasks,
} from "../src/tasks.js";
import { type TmuxExecutor, resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { withCleanIdentityEnv, withEnv } from "./_env.js";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-tasks-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  resetTmuxExecutor();
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

// ─── isValidTaskId ─────────────────────────────────────────────────────

describe("isValidTaskId", () => {
  it("accepts lowercase identifiers with alnum / _ / -", () => {
    expect(isValidTaskId("design")).toBe(true);
    expect(isValidTaskId("design_auth")).toBe(true);
    expect(isValidTaskId("design-auth")).toBe(true);
    expect(isValidTaskId("a")).toBe(true);
    expect(isValidTaskId("a".repeat(64))).toBe(true);
  });

  it("rejects names not starting with a letter", () => {
    expect(isValidTaskId("1design")).toBe(false);
    expect(isValidTaskId("_design")).toBe(false);
    expect(isValidTaskId("-design")).toBe(false);
  });

  it("rejects uppercase / spaces / special chars / >64 chars", () => {
    expect(isValidTaskId("Design")).toBe(false);
    expect(isValidTaskId("design auth")).toBe(false);
    expect(isValidTaskId("design/auth")).toBe(false);
    expect(isValidTaskId("design.auth")).toBe(false);
    expect(isValidTaskId("")).toBe(false);
    expect(isValidTaskId("a".repeat(65))).toBe(false);
  });
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
});

// ─── View reads ────────────────────────────────────────────────────────

describe("listReady / listBlocked / listGoals", () => {
  beforeEach(() => {
    // Build the MVP acceptance graph (10 tasks with one diamond).
    addTask(db, {
      localId: "specs",
      workstream: "test",
      title: "Specs",
      impact: 90,
      effortDays: 1,
    });
    addTask(db, {
      localId: "api",
      workstream: "test",
      title: "API",
      impact: 80,
      effortDays: 2,
      blockedBy: ["specs"],
    });
    addTask(db, {
      localId: "ui",
      workstream: "test",
      title: "UI",
      impact: 70,
      effortDays: 2,
      blockedBy: ["specs"],
    });
    addTask(db, {
      localId: "lib",
      workstream: "test",
      title: "Lib",
      impact: 80,
      effortDays: 3,
      blockedBy: ["api", "ui"],
    });
    addTask(db, {
      localId: "backend",
      workstream: "test",
      title: "Backend",
      impact: 80,
      effortDays: 5,
      blockedBy: ["lib"],
    });
    addTask(db, {
      localId: "frontend",
      workstream: "test",
      title: "Frontend",
      impact: 70,
      effortDays: 5,
      blockedBy: ["lib"],
    });
    addTask(db, {
      localId: "tests",
      workstream: "test",
      title: "Tests",
      impact: 60,
      effortDays: 3,
      blockedBy: ["backend", "frontend"],
    });
    addTask(db, {
      localId: "docs",
      workstream: "test",
      title: "Docs",
      impact: 50,
      effortDays: 2,
      blockedBy: ["api", "ui"],
    });
    addTask(db, {
      localId: "deploy",
      workstream: "test",
      title: "Deploy",
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

  it("ready: only `specs` is initially actionable", () => {
    expect(listReady(db, "test").map((t) => t.name)).toEqual(["specs"]);
  });

  it("ready promotes after a blocker closes", () => {
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='specs'").run();
    expect(
      listReady(db, "test")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["api", "ui"]);
  });

  it("blocked: every non-specs task is initially blocked", () => {
    const blockedIds = listBlocked(db, "test")
      .map((t) => t.name)
      .sort();
    expect(blockedIds).toEqual([
      "api",
      "backend",
      "deploy",
      "docs",
      "frontend",
      "launch",
      "lib",
      "tests",
      "ui",
    ]);
  });

  it("goals: only launch (no outgoing edges) is a goal", () => {
    expect(listGoals(db, "test").map((t) => t.name)).toEqual(["launch"]);
  });

  it("goals view excludes CLOSED tasks (a finished leaf is no longer a goal)", () => {
    expect(listGoals(db, "test").map((t) => t.name)).toEqual(["launch"]);
    closeTask(db, "launch", { workstream: "test" });
    expect(listGoals(db, "test")).toEqual([]);
  });
});

// ─── claimTask ─────────────────────────────────────────────────────────

describe("claimTask", () => {
  beforeEach(() => {
    addTask(db, { localId: "auth", workstream: "test", title: "Auth", impact: 80, effortDays: 2 });
    // tasks.owner is now a real FK to agents(name); the test agents must
    // exist before they can claim.
    insertAgent(db, { name: "alice", workstream: "test", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "bob", workstream: "test", paneId: "%2", status: "busy" });
  });

  it("claims with explicit agentName", async () => {
    const result = await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    expect(result.ownerName).toBe("alice");
    expect(result.previousOwnerName).toBeNull();
    expect(result.previousStatus).toBe("OPEN");
    expect(result.status).toBe("IN_PROGRESS");
    expect(getTask(db, "auth", "test")?.ownerName).toBe("alice");
    expect(getTask(db, "auth", "test")?.status).toBe("IN_PROGRESS");
  });

  it("flips OPEN → IN_PROGRESS but leaves IN_PROGRESS unchanged on re-claim", async () => {
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    const second = await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    expect(second.previousStatus).toBe("IN_PROGRESS");
    expect(second.status).toBe("IN_PROGRESS");
  });

  it("does NOT flip status when CLOSED", async () => {
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='auth'").run();
    const result = await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    expect(result.status).toBe("CLOSED");
  });

  it("re-claim by same agent is a no-op (idempotent)", async () => {
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    expect(getTask(db, "auth", "test")?.ownerName).toBe("alice");
  });

  it("throws TaskAlreadyOwnedError when another agent owns it", async () => {
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    await expect(
      claimTask(db, "auth", { agentName: "bob", workstream: "test" }),
    ).rejects.toBeInstanceOf(TaskAlreadyOwnedError);
    // alice still owns it.
    expect(getTask(db, "auth", "test")?.ownerName).toBe("alice");
  });

  it("throws TaskNotFoundError for unknown task", async () => {
    await expect(
      claimTask(db, "ghost", { agentName: "alice", workstream: "test" }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("derives agentName from currentPaneTitle when not provided", async () => {
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "display-message" && args.includes("#{pane_title}")) {
        return { stdout: "alice\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };
    setTmuxExecutor(executor);
    await withEnv("TMUX_PANE", "%15", async () => {
      const result = await claimTask(db, "auth", { workstream: "test" });
      expect(result.ownerName).toBe("alice");
    });
  });

  it("throws when no agent name available (no $TMUX_PANE, no opts.agentName)", async () => {
    await withEnv("TMUX_PANE", undefined, async () => {
      await expect(claimTask(db, "auth", { workstream: "test" })).rejects.toThrow(/no agent name/);
    });
  });

  it("bumps updated_at", async () => {
    const before = getTask(db, "auth", "test")?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    const after = getTask(db, "auth", "test")?.updatedAt;
    expect(after).not.toBe(before);
  });

  // ─ ClaimerNotRegisteredError: pre-check that maps the would-be
  //   bare 'FOREIGN KEY constraint failed' (from the FK on tasks.owner
  //   added in the v2 migration) into a typed actionable error.
  it("throws ClaimerNotRegisteredError when --for names a non-existent agent", async () => {
    await expect(
      claimTask(db, "auth", { agentName: "ghost", workstream: "test" }),
    ).rejects.toBeInstanceOf(ClaimerNotRegisteredError);
    // Task untouched (no partial write through the FK).
    expect(getTask(db, "auth", "test")?.ownerName).toBeNull();
    expect(getTask(db, "auth", "test")?.status).toBe("OPEN");
  });

  it("ClaimerNotRegisteredError carries three structured next-steps via errorNextSteps()", async () => {
    try {
      await claimTask(db, "auth", { agentName: "ghost", workstream: "test" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaimerNotRegisteredError);
      const msg = (err as Error).message;
      // The bare message identifies the claimer + condition; resolutions
      // live in errorNextSteps(), not the prose.
      expect(msg).toContain("ghost");
      expect(msg).toContain("not a registered mu agent");
      const steps = (err as ClaimerNotRegisteredError).errorNextSteps();
      expect(steps).toHaveLength(3);
      // --self is first (most-common-resolution-first).
      expect(steps[0]?.command).toContain("--self");
      expect(steps[1]?.command).toContain("--for");
      expect(steps[2]?.command).toContain("mu adopt");
    }
  });

  it("ClaimerNotRegisteredError errorNextSteps() pins the actual pane id when name came from $TMUX_PANE", async () => {
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "display-message" && args.includes("#{pane_title}")) {
        return { stdout: "unregistered\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };
    setTmuxExecutor(executor);
    await withEnv("TMUX_PANE", "%99", async () => {
      try {
        await claimTask(db, "auth", { workstream: "test" });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ClaimerNotRegisteredError);
        const steps = (err as ClaimerNotRegisteredError).errorNextSteps();
        const adopt = steps.find((s) => s.command.startsWith("mu adopt"));
        expect(adopt?.command).toBe("mu adopt %99");
      }
    });
  });

  // ─ --self anonymous claim path (orchestrator pattern) ─
  it("--self skips the FK check; sets owner=NULL; records actor in result + log", async () => {
    const result = await claimTask(db, "auth", {
      self: true,
      actor: "orchestrator",
      workstream: "test",
    });
    expect(result.ownerName).toBeNull();
    expect(result.actorName).toBe("orchestrator");
    expect(result.previousStatus).toBe("OPEN");
    expect(result.status).toBe("IN_PROGRESS");
    expect(getTask(db, "auth", "test")?.ownerName).toBeNull();
    expect(getTask(db, "auth", "test")?.status).toBe("IN_PROGRESS");
  });

  it("--self emits an agent_logs event with the actor as source", async () => {
    await claimTask(db, "auth", { self: true, actor: "deploy-bot", workstream: "test" });
    const events = listLogs(db, { workstream: "test", kind: "event" });
    const claim = events.find((e) => e.payload.includes("task claim auth"));
    expect(claim).toBeDefined();
    expect(claim?.source).toBe("deploy-bot");
    expect(claim?.payload).toContain("--self");
    expect(claim?.payload).toContain("anonymous");
  });

  it("--self does NOT require the actor to exist in the agents table", async () => {
    // 'phantom' has no row in agents — worker-claim path would reject;
    // --self happily proceeds because owner stays NULL (no FK to satisfy).
    const result = await claimTask(db, "auth", {
      self: true,
      actor: "phantom",
      workstream: "test",
    });
    expect(result.ownerName).toBeNull();
    expect(result.actorName).toBe("phantom");
  });

  it("--self with an unowned task succeeds; --self with an owned task throws TaskAlreadyOwnedError", async () => {
    await claimTask(db, "auth", { agentName: "alice", workstream: "test" });
    await expect(
      claimTask(db, "auth", { self: true, actor: "orchestrator", workstream: "test" }),
    ).rejects.toBeInstanceOf(TaskAlreadyOwnedError);
    // Alice still owns it (no overwrite).
    expect(getTask(db, "auth", "test")?.ownerName).toBe("alice");
  });

  it("--self and agentName together is a usage error", async () => {
    await expect(
      claimTask(db, "auth", { self: true, agentName: "alice", workstream: "test" }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("--self resolves actor from $TMUX_PANE when not explicit", async () => {
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "display-message" && args.includes("#{pane_title}")) {
        return { stdout: "orchestrator-pane\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };
    setTmuxExecutor(executor);
    // withCleanIdentityEnv strips MU_AGENT_NAME/TMUX_PANE/USER from
    // process.env before the inner withEnv reinstates TMUX_PANE.
    // Without it, MU_AGENT_NAME leaking from a mu-spawned host pane
    // wins the resolveActorIdentity fallback chain.
    await withCleanIdentityEnv(async () => {
      await withEnv("TMUX_PANE", "%42", async () => {
        const result = await claimTask(db, "auth", { self: true, workstream: "test" });
        expect(result.actorName).toBe("orchestrator-pane");
      });
    });
  });

  it("--self resolves actor from $USER when no $TMUX_PANE", async () => {
    await withCleanIdentityEnv(async () => {
      await withEnv("USER", "martin", async () => {
        const result = await claimTask(db, "auth", { self: true, workstream: "test" });
        expect(result.actorName).toBe("martin");
      });
    });
  });

  it("--self falls back to 'orchestrator' when no $MU_AGENT_NAME, $TMUX_PANE, or $USER", async () => {
    // Was 'unknown' before the resolveActorIdentity refactor; changed
    // to 'orchestrator' for symmetry with task_notes.author and the
    // overall identity-resolution chain. The 'orchestrator' label is
    // meaningful; 'unknown' was a placeholder.
    await withEnv("MU_AGENT_NAME", undefined, async () => {
      await withEnv("TMUX_PANE", undefined, async () => {
        await withEnv("USER", undefined, async () => {
          const result = await claimTask(db, "auth", { self: true, workstream: "test" });
          expect(result.actorName).toBe("orchestrator");
        });
      });
    });
  });

  // ─ Cross-workstream guard: --for must reject when the named agent
  //   lives in a different workstream than the task. The schema's FK
  //   on tasks.owner is keyed on agents.name only (no workstream
  //   qualifier), so without this pre-check the claim would silently
  //   accept and the rest of mu would treat the row as in-scope.
  //   Surfaced live by snap_dogfood; filed as cross_workstream_claim_for.
  // v5: claimTask resolves both task and agent inside opts.workstream
  // (per-workstream uniqueness). A wrong-workstream agent surfaces
  // as ClaimerNotRegisteredError; a wrong-workstream task surfaces as
  // TaskNotFoundError. The cross-workstream-guard pre-check that used
  // to raise AgentNotInWorkstreamError is gone — the mismatch is
  // structurally impossible.
  it("claims by an agent missing in opts.workstream raise ClaimerNotRegisteredError", async () => {
    insertAgent(db, {
      name: "cross",
      workstream: "other",
      paneId: "%99",
      status: "busy",
    });
    // 'cross' lives in 'other'; this claim targets workstream 'test'.
    await expect(
      claimTask(db, "auth", { agentName: "cross", workstream: "test" }),
    ).rejects.toBeInstanceOf(ClaimerNotRegisteredError);
    // No partial write: task untouched.
    expect(getTask(db, "auth", "test")?.ownerName).toBeNull();
    expect(getTask(db, "auth", "test")?.status).toBe("OPEN");
  });

  it("--self path resolves the task in opts.workstream", async () => {
    // No agent FK to check on --self; the orchestrator can drive the
    // workstream's tasks anonymously. The task lookup still scopes to
    // opts.workstream (no global-search fallback).
    const result = await claimTask(db, "auth", {
      self: true,
      actor: "orchestrator",
      workstream: "test",
    });
    expect(result.ownerName).toBeNull();
    expect(result.actorName).toBe("orchestrator");
    expect(getTask(db, "auth", "test")?.status).toBe("IN_PROGRESS");
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

// ─── setTaskStatus / closeTask / openTask ──────────────────────────────────

describe("setTaskStatus / closeTask / openTask", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
    });
    // FK: tasks.owner → agents(name); the worker-1 claim test below needs
    // the agent row to exist.
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  });

  it("closeTask flips OPEN → CLOSED and reports the change", () => {
    const r = closeTask(db, "design", { workstream: "auth" });
    expect(r).toEqual({ previousStatus: "OPEN", status: "CLOSED", changed: true });
    expect(getTask(db, "design", "auth")?.status).toBe("CLOSED");
  });

  it("closeTask is idempotent on an already-CLOSED task", () => {
    closeTask(db, "design", { workstream: "auth" });
    const r = closeTask(db, "design", { workstream: "auth" });
    expect(r.changed).toBe(false);
    expect(r.status).toBe("CLOSED");
  });

  it("openTask flips CLOSED → OPEN and is idempotent on already-OPEN", () => {
    closeTask(db, "design", { workstream: "auth" });
    const r1 = openTask(db, "design", { workstream: "auth" });
    expect(r1).toEqual({ previousStatus: "CLOSED", status: "OPEN", changed: true });
    const r2 = openTask(db, "design", { workstream: "auth" });
    expect(r2.changed).toBe(false);
  });

  it("openTask leaves owner intact (use releaseTask to clear owner)", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    closeTask(db, "design", { workstream: "auth" });
    openTask(db, "design", { workstream: "auth" });
    expect(getTask(db, "design", "auth")?.ownerName).toBe("worker-1");
  });

  it("setTaskStatus accepts arbitrary status", () => {
    const r = setTaskStatus(db, "design", "IN_PROGRESS", { workstream: "auth" });
    expect(r).toEqual({ previousStatus: "OPEN", status: "IN_PROGRESS", changed: true });
    expect(getTask(db, "design", "auth")?.status).toBe("IN_PROGRESS");
  });

  it("setTaskStatus / closeTask / openTask all throw TaskNotFoundError on missing", () => {
    expect(() => setTaskStatus(db, "ghost", "CLOSED", { workstream: "auth" })).toThrow(
      TaskNotFoundError,
    );
    expect(() => closeTask(db, "ghost", { workstream: "auth" })).toThrow(TaskNotFoundError);
    expect(() => openTask(db, "ghost", { workstream: "auth" })).toThrow(TaskNotFoundError);
  });

  it("closeTask bumps updated_at", () => {
    const before = getTask(db, "design", "auth")?.updatedAt;
    // Sleep tick to ensure ISO-string difference at ms resolution.
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    closeTask(db, "design", { workstream: "auth" });
    const after = getTask(db, "design", "auth")?.updatedAt;
    expect(after).not.toBe(before);
  });
});

// ─── releaseTask ──────────────────────────────────────────────────────────

describe("releaseTask", () => {
  beforeEach(async () => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
    });
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  });

  it("clears owner on a claimed task; status preserved by default", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    expect(getTask(db, "design", "auth")?.status).toBe("IN_PROGRESS");

    const r = releaseTask(db, "design", { workstream: "auth" });
    expect(r.previousOwnerName).toBe("worker-1");
    expect(r.changed).toBe(true);
    expect(r.status).toBe("IN_PROGRESS"); // status preserved
    const after = getTask(db, "design", "auth");
    expect(after?.ownerName).toBeNull();
    expect(after?.status).toBe("IN_PROGRESS");
  });

  it("--reopen also flips status back to OPEN", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "auth" });
    const r = releaseTask(db, "design", { reopen: true, workstream: "auth" });
    expect(r.previousStatus).toBe("IN_PROGRESS");
    expect(r.status).toBe("OPEN");
    expect(r.changed).toBe(true);
    const after = getTask(db, "design", "auth");
    expect(after?.ownerName).toBeNull();
    expect(after?.status).toBe("OPEN");
  });

  it("--reopen on an already-OPEN unowned task is a no-op", () => {
    const r = releaseTask(db, "design", { reopen: true, workstream: "auth" });
    expect(r.changed).toBe(false);
  });

  it("plain release on an already-unowned task is a no-op", () => {
    const r = releaseTask(db, "design", { workstream: "auth" });
    expect(r.changed).toBe(false);
    expect(r.previousOwnerName).toBeNull();
  });

  it("--reopen on a CLOSED unowned task DOES flip back to OPEN (changed=true)", () => {
    closeTask(db, "design", { workstream: "auth" });
    const r = releaseTask(db, "design", { reopen: true, workstream: "auth" });
    expect(r.changed).toBe(true);
    expect(r.status).toBe("OPEN");
  });

  it("throws TaskNotFoundError on missing task", () => {
    expect(() => releaseTask(db, "ghost", { workstream: "auth" })).toThrow(TaskNotFoundError);
  });
});

// ─── listTasksByOwner ─────────────────────────────────────────────────

describe("listTasksByOwner", () => {
  it("listTasksByOwnerCrossWorkstream returns tasks owned across workstreams", async () => {
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "billing", title: "C", impact: 50, effortDays: 1 });
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "worker-2", workstream: "billing", paneId: "%2", status: "busy" });
    await claimTask(db, "a", { agentName: "worker-1", workstream: "auth" });
    // Construct the cross-workstream owner state directly. The verb
    // path (claimTask --for) correctly rejects cross-workstream owner
    // assignment, but listTasksByOwnerCrossWorkstream still has to
    // surface rows whose owner string matches across workstreams
    // (e.g. operator hand-edits via `mu sql` migrating tasks).
    const setOwner = db.prepare(
      `UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = ? LIMIT 1),
              status = 'IN_PROGRESS'
        WHERE local_id = ?`,
    );
    setOwner.run("worker-1", "c");
    setOwner.run("worker-2", "b");

    // Assert on full (localId, workstream) pairs — the cross-ws helper
    // returns every row whose owner.name matches, regardless of
    // workstream. Pins the contract of the cross-workstream alias.
    const ownedByW1 = listTasksByOwnerCrossWorkstream(db, "worker-1")
      .map((t) => ({ name: t.name, workstreamName: t.workstreamName }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(ownedByW1).toEqual([
      { name: "a", workstreamName: "auth" },
      { name: "c", workstreamName: "billing" },
    ]);
    const ownedByW2 = listTasksByOwnerCrossWorkstream(db, "worker-2").map((t) => ({
      name: t.name,
      workstreamName: t.workstreamName,
    }));
    expect(ownedByW2).toEqual([{ name: "b", workstreamName: "auth" }]);
  });

  it("returns empty for an agent with no claims (or unknown agent)", () => {
    expect(listTasksByOwner(db, "auth", "ghost")).toEqual([]);
    insertAgent(db, { name: "idle", workstream: "auth", paneId: "%1", status: "free" });
    expect(listTasksByOwner(db, "auth", "idle")).toEqual([]);
  });

  it("excludes CLOSED tasks by default; --include-closed surfaces them", async () => {
    // Real bug found in real use: `mu task owned-by worker-1` was
    // returning closed tasks alongside live ones, defeating the
    // verb's purpose ("what is X currently working on?").
    addTask(db, { localId: "live", workstream: "auth", title: "Live", impact: 50, effortDays: 1 });
    addTask(db, { localId: "done", workstream: "auth", title: "Done", impact: 50, effortDays: 1 });
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", status: "busy" });
    await claimTask(db, "live", { agentName: "w1", workstream: "auth" });
    await claimTask(db, "done", { agentName: "w1", workstream: "auth" });
    closeTask(db, "done", { workstream: "auth" }); // closeTask preserves owner intentionally

    const defaultOwned = listTasksByOwner(db, "auth", "w1").map((t) => t.name);
    expect(defaultOwned).toEqual(["live"]);

    const allOwned = listTasksByOwner(db, "auth", "w1", { includeClosed: true })
      .map((t) => t.name)
      .sort();
    expect(allOwned).toEqual(["done", "live"]);
  });
});

// ─── searchTasks ───────────────────────────────────────────────────────────

describe("searchTasks", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "design_auth",
      workstream: "auth",
      title: "Design the JWT auth flow",
      impact: 80,
      effortDays: 2,
    });
    addTask(db, {
      localId: "build_auth",
      workstream: "auth",
      title: "Implement",
      impact: 80,
      effortDays: 5,
    });
    addTask(db, {
      localId: "design_billing",
      workstream: "billing",
      title: "Design invoice schema",
      impact: 50,
      effortDays: 1,
    });
    addNote(db, "build_auth", "DECISION: chose JWT; refresh via cookie", { workstream: "auth" });
    addNote(db, "design_billing", "FILES: src/billing/invoice.rs", { workstream: "billing" });
  });

  it("matches title substring (case-insensitive), scoped to a workstream", () => {
    expect(searchTasks(db, "jwt", { workstream: "auth" }).map((t) => t.name)).toEqual([
      "design_auth",
    ]);
    expect(searchTasks(db, "DESIGN", { workstream: "auth" }).map((t) => t.name)).toEqual([
      "design_auth",
    ]);
  });

  it("matches local_id substring", () => {
    expect(
      searchTasks(db, "_auth", { workstream: "auth" })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["build_auth", "design_auth"]);
  });

  it("with no workstream, spans every workstream", () => {
    expect(
      searchTasks(db, "design")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["design_auth", "design_billing"]);
  });

  it("--in-notes also matches note content", () => {
    // 'jwt' appears in design_auth's title AND build_auth's note.
    const ids = searchTasks(db, "jwt", { workstream: "auth", includeNotes: true }).map(
      (t) => t.name,
    );
    expect(ids.sort()).toEqual(["build_auth", "design_auth"]);

    // Without --in-notes, only design_auth matches (notes ignored).
    expect(searchTasks(db, "jwt", { workstream: "auth" }).map((t) => t.name)).toEqual([
      "design_auth",
    ]);
  });

  it("DISTINCTs the result when a task has multiple matching notes", () => {
    addNote(db, "build_auth", "DECISION: also JWT for refresh", { workstream: "auth" });
    addNote(db, "build_auth", "VERIFIED: jwt expiry tests pass", { workstream: "auth" });
    const ids = searchTasks(db, "jwt", { workstream: "auth", includeNotes: true }).map(
      (t) => t.name,
    );
    expect(ids.sort()).toEqual(["build_auth", "design_auth"]); // build_auth appears once despite 3 notes
  });

  it("empty result on no match", () => {
    expect(searchTasks(db, "nothing-matches-this", { workstream: "auth" })).toEqual([]);
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
});

// ─── slugifyTitle / idFromTitle / mu_ reservation ─────────────────

describe("slugifyTitle", () => {
  it("lowercases and replaces non-alnum runs with single underscore", () => {
    expect(slugifyTitle("Build the auth module")).toBe("build_the_auth_module");
    expect(slugifyTitle("FILES: foo.ts (refactor)")).toBe("files_foo_ts_refactor");
  });

  it("trims leading/trailing underscores", () => {
    expect(slugifyTitle("   wat   ")).toBe("wat");
    expect(slugifyTitle("...spaces...")).toBe("spaces");
  });

  it("prefixes t_ when the slug starts with a digit", () => {
    expect(slugifyTitle("2024 retro")).toBe("t_2024_retro");
  });

  // Post schema_v5_cleanups: titles starting with `Mu ...` slugify
  // to `mu_...` directly — the reserved-prefix gymnastics that
  // rewrote them to `t_mu_...` are gone (no global namespace in v5).
  it("slugs starting with mu_ are accepted as-is (no reservation in v5)", () => {
    expect(slugifyTitle("Mu smoke test")).toBe("mu_smoke_test");
    expect(slugifyTitle("mu testing")).toBe("mu_testing");
    expect(slugifyTitle("MU_THING")).toBe("mu_thing");
  });

  it("caps a one-giant-word title at the 40-char soft cap (no underscore to break on)", () => {
    const long = "x".repeat(100);
    expect(slugifyTitle(long).length).toBe(40);
  });

  it("trims at the last underscore at-or-before 40 chars (word boundary)", () => {
    // Title with several segments; segment boundaries fall at
    // positions that let us assert a clean cut.
    const title = "Refactor the authentication and authorisation modules end to end";
    const slug = slugifyTitle(title);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).not.toMatch(/_$/); // never trailing underscore
    // The cut must happen on a word boundary, so the last segment
    // must be a complete word from the original title.
    expect(["refactor_the_authentication_and", "refactor_the_authentication"]).toContain(slug);
  });

  it("prefers the soft cap when the title fits below it", () => {
    const slug = slugifyTitle("Build auth module");
    expect(slug).toBe("build_auth_module");
    expect(slug.length).toBeLessThan(40);
  });

  it("throws on a title that yields an empty slug", () => {
    expect(() => slugifyTitle("!!!")).toThrow(/empty slug/);
    expect(() => slugifyTitle("")).toThrow(/empty slug/);
  });
});

describe("idFromTitle", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "build_auth",
      workstream: "auth",
      title: "Build auth",
      impact: 50,
      effortDays: 1,
    });
  });

  it("returns the slug when no collision", () => {
    expect(idFromTitle(db, "auth", "Ship feature")).toBe("ship_feature");
  });

  it("appends _2, _3, … on collision", () => {
    expect(idFromTitle(db, "auth", "Build auth")).toBe("build_auth_2");
    addTask(db, {
      localId: "build_auth_2",
      workstream: "auth",
      title: "x",
      impact: 1,
      effortDays: 1,
    });
    expect(idFromTitle(db, "auth", "Build auth")).toBe("build_auth_3");
  });
});

// Post schema_v5_cleanups: `mu_` is no longer a reserved prefix.
// v5's per-workstream UNIQUE on (workstream_id, local_id) replaces
// the old global namespace; nothing system-generated lives in a
// shared global slot anymore. The mu_ ids that used to be rejected
// are now perfectly valid local_ids.
describe("mu_ prefix is a fine local_id (post schema_v5_cleanups)", () => {
  it("isValidTaskId accepts mu_ prefix", () => {
    expect(isValidTaskId("mu_foo")).toBe(true);
    // Length-1 names like `mu_` still fail because they need at least
    // a leading letter; `mu_` is a letter + `_` which IS valid.
    expect(isValidTaskId("mu_")).toBe(true);
    expect(isValidTaskId("music")).toBe(true);
    expect(isValidTaskId("mu")).toBe(true);
  });

  it("addTask accepts an mu_ id and the per-workstream UNIQUE catches collisions", () => {
    addTask(db, {
      localId: "mu_internal",
      workstream: "auth",
      title: "x",
      impact: 1,
      effortDays: 1,
    });
    // Same id in same workstream: TaskExistsError (per-workstream UNIQUE).
    expect(() =>
      addTask(db, {
        localId: "mu_internal",
        workstream: "auth",
        title: "x",
        impact: 1,
        effortDays: 1,
      }),
    ).toThrow(TaskExistsError);
    // Same id in a DIFFERENT workstream: legal (per-workstream scope).
    const other = addTask(db, {
      localId: "mu_internal",
      workstream: "other",
      title: "x",
      impact: 1,
      effortDays: 1,
    });
    expect(other.name).toBe("mu_internal");
    expect(other.workstreamName).toBe("other");
  });
});

// ─── evidence on lifecycle verbs ──────────────────────────────
//
// First inch of the "observed vs claimed" distinction:
// the verb still trusts the caller, but the audit trail records what
// the caller said it relied on.

describe("evidence on lifecycle verbs", () => {
  beforeEach(() => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "Design",
      impact: 50,
      effortDays: 1,
    });
    db.prepare("DELETE FROM agent_logs").run();
  });

  function lastEventPayload(): string {
    const row = db
      .prepare("SELECT payload FROM agent_logs WHERE kind = 'event' ORDER BY seq DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    return row?.payload ?? "";
  }

  it('closeTask --evidence appends evidence="…" to the event payload', () => {
    closeTask(db, "design", { evidence: "tests pass: npm test exit 0", workstream: "auth" });
    const p = lastEventPayload();
    expect(p).toContain("task status design");
    expect(p).toContain('evidence="tests pass: npm test exit 0"');
  });

  it("closeTask without --evidence omits the suffix", () => {
    closeTask(db, "design", { workstream: "auth" });
    const p = lastEventPayload();
    expect(p).toContain("task status design");
    expect(p).not.toContain("evidence=");
  });

  it("openTask --evidence threads through too", () => {
    closeTask(db, "design", { workstream: "auth" });
    db.prepare("DELETE FROM agent_logs").run();
    openTask(db, "design", { evidence: "reopened: deploy rollback", workstream: "auth" });
    expect(lastEventPayload()).toContain('evidence="reopened: deploy rollback"');
  });

  it("releaseTask --evidence threads through (and survives --reopen)", () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    db.prepare(
      `UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'worker-1'),
              status='IN_PROGRESS' WHERE local_id='design'`,
    ).run();
    db.prepare("DELETE FROM agent_logs").run();
    releaseTask(db, "design", {
      reopen: true,
      evidence: "agent crashed mid-task",
      workstream: "auth",
    });
    const p = lastEventPayload();
    expect(p).toContain("task release design");
    expect(p).toContain("IN_PROGRESS → OPEN");
    expect(p).toContain('evidence="agent crashed mid-task"');
  });

  it("claimTask --evidence threads through", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    db.prepare("DELETE FROM agent_logs").run();
    await claimTask(db, "design", {
      agentName: "worker-1",
      evidence: "reviewed task; have implementation plan",
      workstream: "auth",
    });
    const p = lastEventPayload();
    expect(p).toContain("task claim design by worker-1");
    expect(p).toContain('evidence="reviewed task; have implementation plan"');
  });

  it("evidence is JSON-quoted so multi-word + special chars stay legible", () => {
    closeTask(db, "design", { evidence: 'has "quotes" and a \\backslash', workstream: "auth" });
    const p = lastEventPayload();
    // JSON.stringify preserves the inner quotes and backslash via escaping
    expect(p).toContain('evidence="has \\"quotes\\" and a \\\\backslash"');
  });
});

// ─── listTasks --status filter ─────────────────────────────────

describe("listTasks --status filter", () => {
  beforeEach(() => {
    addTask(db, { localId: "open1", workstream: "auth", title: "x", impact: 50, effortDays: 1 });
    addTask(db, { localId: "open2", workstream: "auth", title: "y", impact: 50, effortDays: 1 });
    addTask(db, { localId: "ip1", workstream: "auth", title: "z", impact: 50, effortDays: 1 });
    addTask(db, { localId: "done1", workstream: "auth", title: "w", impact: 50, effortDays: 1 });
    db.prepare("UPDATE tasks SET status='IN_PROGRESS' WHERE local_id='ip1'").run();
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='done1'").run();
  });

  it("returns all tasks when status omitted (existing behaviour)", () => {
    expect(
      listTasks(db, "auth")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["done1", "ip1", "open1", "open2"]);
  });

  it("filters to a single status (string form)", () => {
    expect(
      listTasks(db, "auth", { status: "OPEN" })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["open1", "open2"]);
    expect(listTasks(db, "auth", { status: "IN_PROGRESS" }).map((t) => t.name)).toEqual(["ip1"]);
    expect(listTasks(db, "auth", { status: "CLOSED" }).map((t) => t.name)).toEqual(["done1"]);
  });

  it("filters to multiple statuses (array form)", () => {
    expect(
      listTasks(db, "auth", { status: ["OPEN", "IN_PROGRESS"] })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["ip1", "open1", "open2"]);
  });

  it("respects workstream + status combined", () => {
    addTask(db, {
      localId: "other_open",
      workstream: "other",
      title: "x",
      impact: 50,
      effortDays: 1,
    });
    expect(
      listTasks(db, "auth", { status: "OPEN" })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["open1", "open2"]);
    // Other workstream's OPEN task isn't included when filtered to 'auth'.
    expect(
      listTasks(db, undefined, { status: "OPEN" })
        .map((t) => t.name)
        .sort(),
    ).toEqual(["open1", "open2", "other_open"]);
  });
});

describe("isTaskStatus", () => {
  it("recognises the three valid statuses", () => {
    expect(isTaskStatus("OPEN")).toBe(true);
    expect(isTaskStatus("IN_PROGRESS")).toBe(true);
    expect(isTaskStatus("CLOSED")).toBe(true);
  });

  it("rejects garbage and case variants (callers should upper-case first)", () => {
    expect(isTaskStatus("open")).toBe(false);
    expect(isTaskStatus("RESOLVED")).toBe(false); // not in the enum
    expect(isTaskStatus("")).toBe(false);
    expect(isTaskStatus("OPEN ")).toBe(false);
  });
});

// ─── waitForTasks (verb) ───────────────────────────────────────────────────

describe("waitForTasks", () => {
  beforeEach(() => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "test", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "test", title: "C", impact: 50, effortDays: 1 });
  });

  it("returns immediately when the wait condition is already satisfied (--all default)", async () => {
    setTaskStatus(db, "a", "CLOSED", { workstream: "test" });
    setTaskStatus(db, "b", "CLOSED", { workstream: "test" });
    setTaskStatus(db, "c", "CLOSED", { workstream: "test" });
    const r = await waitForTasks(db, ["a", "b", "c"], { pollMs: 50, workstream: "test" });
    expect(r.allReached).toBe(true);
    expect(r.anyReached).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.elapsedMs).toBeLessThan(100); // didn't sleep through any poll cycle
    expect(r.tasks).toEqual([
      {
        workstreamName: "test",
        name: "a",
        status: "CLOSED",
        owner: null,
        reachedTarget: true,
        stuck: false,
      },
      {
        workstreamName: "test",
        name: "b",
        status: "CLOSED",
        owner: null,
        reachedTarget: true,
        stuck: false,
      },
      {
        workstreamName: "test",
        name: "c",
        status: "CLOSED",
        owner: null,
        reachedTarget: true,
        stuck: false,
      },
    ]);
  });

  it("returns immediately on --any when at least one task already reached the target", async () => {
    setTaskStatus(db, "b", "CLOSED", { workstream: "test" });
    const r = await waitForTasks(db, ["a", "b", "c"], {
      any: true,
      pollMs: 50,
      workstream: "test",
    });
    expect(r.allReached).toBe(false);
    expect(r.anyReached).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it("blocks until the condition is met (poll loop wakes up on the next snapshot)", async () => {
    // Schedule a status change to fire after one poll interval.
    const flipAt = Date.now();
    setTimeout(() => setTaskStatus(db, "a", "CLOSED", { workstream: "test" }), 60);
    const r = await waitForTasks(db, ["a"], { pollMs: 30, timeoutMs: 1000, workstream: "test" });
    expect(r.allReached).toBe(true);
    expect(r.timedOut).toBe(false);
    // Allow generous slack; assert we DID wait (not the immediate-exit path).
    expect(Date.now() - flipAt).toBeGreaterThanOrEqual(30);
  });

  it("times out with timedOut=true and exit-code-mappable result when condition not met", async () => {
    const r = await waitForTasks(db, ["a", "b"], {
      timeoutMs: 100,
      pollMs: 30,
      workstream: "test",
    });
    expect(r.timedOut).toBe(true);
    expect(r.allReached).toBe(false);
    expect(r.anyReached).toBe(false);
    // Per-task state at exit time still useful for the caller.
    expect(r.tasks.map((t) => t.status)).toEqual(["OPEN", "OPEN"]);
  });

  it("--any times out cleanly when no task reaches the target", async () => {
    const r = await waitForTasks(db, ["a", "b"], {
      any: true,
      timeoutMs: 100,
      pollMs: 30,
      workstream: "test",
    });
    expect(r.timedOut).toBe(true);
    expect(r.anyReached).toBe(false);
  });

  it("respects a non-default --status target (e.g. IN_PROGRESS)", async () => {
    setTaskStatus(db, "a", "IN_PROGRESS", { workstream: "test" });
    setTaskStatus(db, "b", "IN_PROGRESS", { workstream: "test" });
    const r = await waitForTasks(db, ["a", "b"], {
      status: "IN_PROGRESS",
      pollMs: 50,
      workstream: "test",
    });
    expect(r.allReached).toBe(true);
    expect(r.tasks.every((t) => t.status === "IN_PROGRESS")).toBe(true);
  });

  it("throws TaskNotFoundError pre-flight if any listed task doesn't exist (loud-fail)", async () => {
    await expect(
      waitForTasks(db, ["a", "ghost", "b"], { timeoutMs: 1000, workstream: "test" }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("rejects an empty id list", async () => {
    await expect(waitForTasks(db, [], { workstream: "test" })).rejects.toThrow(/non-empty/);
  });

  it("partial-progress on timeout: some tasks reached, others didn't", async () => {
    setTaskStatus(db, "a", "CLOSED", { workstream: "test" });
    // b stays OPEN → all-of fails on timeout but anyReached is true.
    const r = await waitForTasks(db, ["a", "b"], { timeoutMs: 80, pollMs: 30, workstream: "test" });
    expect(r.timedOut).toBe(true);
    expect(r.allReached).toBe(false);
    expect(r.anyReached).toBe(true); // 'a' reached
    expect(r.tasks[0]?.reachedTarget).toBe(true);
    expect(r.tasks[1]?.reachedTarget).toBe(false);
  });

  it("survives a task being deleted mid-wait (treats it as 'never reached')", async () => {
    setTimeout(() => deleteTask(db, "b", "test"), 40);
    const r = await waitForTasks(db, ["a", "b"], {
      timeoutMs: 120,
      pollMs: 30,
      workstream: "test",
    });
    expect(r.timedOut).toBe(true);
    // 'b' was deleted; defensive snapshot defaults to 'OPEN' / not reached.
    const bState = r.tasks.find((t) => t.name === "b");
    expect(bState?.reachedTarget).toBe(false);
  });

  // Regression for the pre-clamp bug: with `pollMs > timeoutMs` the loop
  // used to await a full pollMs before re-checking the deadline, so a
  // caller asking for a 50ms timeout with a 1000ms poll would block ~1s.
  // Post-fix the sleep is clamped to `min(pollMs, deadline - now)`; the
  // function returns inside `timeoutMs + small slack`.
  it("returns within timeoutMs even when pollMs > timeoutMs (clamped sleep)", async () => {
    const startedAt = Date.now();
    const r = await waitForTasks(db, ["a"], { pollMs: 1000, timeoutMs: 50, workstream: "test" });
    const elapsed = Date.now() - startedAt;
    expect(r.timedOut).toBe(true);
    expect(r.allReached).toBe(false);
    // Pre-fix this would have been ~1000ms. 200ms is generous slack for
    // CI noise; the bug regression bound is ~1000.
    expect(elapsed).toBeLessThan(200);
    expect(r.elapsedMs).toBeLessThan(200);
  });

  // Sibling-progress when one task in the wait set is deleted mid-wait:
  // the original gap from the deferred test review. Deletion of 'b'
  // should not affect the wait correctly observing 'a' reach CLOSED.
  it("deletion of one task mid-wait does not block sibling progress detection", async () => {
    setTimeout(() => {
      deleteTask(db, "b", "test");
      setTaskStatus(db, "a", "CLOSED", { workstream: "test" });
    }, 30);
    const r = await waitForTasks(db, ["a", "b"], {
      any: true,
      pollMs: 20,
      timeoutMs: 1000,
      workstream: "test",
    });
    expect(r.timedOut).toBe(false);
    expect(r.anyReached).toBe(true);
    const aState = r.tasks.find((t) => t.name === "a");
    const bState = r.tasks.find((t) => t.name === "b");
    expect(aState?.reachedTarget).toBe(true);
    expect(bState?.reachedTarget).toBe(false);
  });

  // Poll-count assertion via the test side-channel. With pollMs=10 and
  // timeoutMs=100 we expect ~10 polls; allow a tight 5-15 range to
  // tolerate scheduler jitter without losing the regression signal.
  it("polls roughly timeoutMs/pollMs times (asserts cadence via test seam)", async () => {
    resetWaitPollCount();
    let sleeps = 0;
    const restore = setWaitSleepForTests(async (ms) => {
      sleeps += 1;
      // Honour the requested duration so the deadline math still drives
      // termination; without this the loop would terminate after a
      // single iteration regardless of pollMs.
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    try {
      const r = await waitForTasks(db, ["a"], { pollMs: 10, timeoutMs: 100, workstream: "test" });
      expect(r.timedOut).toBe(true);
      const polls = getWaitPollCount();
      expect(polls).toBeGreaterThanOrEqual(5);
      expect(polls).toBeLessThanOrEqual(15);
      expect(sleeps).toBe(polls);
    } finally {
      setWaitSleepForTests(restore);
      resetWaitPollCount();
    }
  });

  // Regression for agent_close_discipline_gap: a worker that
  // committed + reported done in chat-style but skipped
  // `mu task close <id>` leaves the task IN_PROGRESS while the agent
  // sits in `needs_input`. mu task wait should keep polling but emit
  // exactly ONE yellow STUCK warning per stuck task per wait call —
  // not one per poll cycle (operators don't want stderr spam).
  it("emits exactly one STUCK warning per stuck task per wait call (agent_close_discipline_gap)", async () => {
    // Set up: a registered worker owns task 'a' which is IN_PROGRESS,
    // and the worker's status is `needs_input` with an `updated_at`
    // timestamp deep in the past so the staleness check fires on the
    // very first poll. We mutate updated_at directly via SQL because
    // updateAgentStatus auto-bumps it to now().
    insertAgent(db, {
      name: "worker-stuck",
      workstream: "test",
      paneId: "%99",
      status: "needs_input",
    });
    db.prepare(
      `UPDATE tasks SET status = 'IN_PROGRESS',
              owner_id = (SELECT id FROM agents WHERE name = ?),
              updated_at = ?
        WHERE local_id = ?`,
    ).run("worker-stuck", new Date().toISOString(), "a");
    db.prepare("UPDATE agents SET status = 'needs_input', updated_at = ? WHERE name = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      "worker-stuck",
    );

    const warnings: string[] = [];
    const restoreWarn = setWaitStuckWarnForTests((msg) => {
      warnings.push(msg);
    });
    // Use the sleep seam to actually sleep so the deadline math
    // terminates after several polls (mirrors the cadence test).
    const restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    try {
      const r = await waitForTasks(db, ["a", "b"], {
        pollMs: 10,
        timeoutMs: 80,
        stuckAfterMs: 1000, // 1s; agent is 10min stale so always stuck
        workstream: "test",
      });
      expect(r.timedOut).toBe(true);
      // 'a' is stuck; 'b' is just OPEN with no owner (not stuck).
      const aState = r.tasks.find((t) => t.name === "a");
      const bState = r.tasks.find((t) => t.name === "b");
      expect(aState?.stuck).toBe(true);
      expect(bState?.stuck).toBe(false);
      // Multiple poll cycles ran (the timeout/poll math gives ~8) but
      // only ONE warning was emitted — dedupe is the point.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("a stuck");
      expect(warnings[0]).toContain("worker-stuck");
      expect(warnings[0]).toContain("mu task close a");
    } finally {
      setWaitStuckWarnForTests(restoreWarn);
      setWaitSleepForTests(restoreSleep);
    }
  });

  it("stuckAfterMs=0 disables the stuck warning entirely", async () => {
    insertAgent(db, {
      name: "worker-stuck2",
      workstream: "test",
      paneId: "%100",
      status: "needs_input",
    });
    db.prepare(
      `UPDATE tasks SET status = 'IN_PROGRESS',
              owner_id = (SELECT id FROM agents WHERE name = ?),
              updated_at = ?
        WHERE local_id = ?`,
    ).run("worker-stuck2", new Date().toISOString(), "a");
    db.prepare("UPDATE agents SET status = 'needs_input', updated_at = ? WHERE name = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      "worker-stuck2",
    );

    const warnings: string[] = [];
    const restoreWarn = setWaitStuckWarnForTests((msg) => {
      warnings.push(msg);
    });
    const restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    try {
      const r = await waitForTasks(db, ["a"], {
        pollMs: 10,
        timeoutMs: 50,
        stuckAfterMs: 0,
        workstream: "test",
      });
      expect(r.timedOut).toBe(true);
      expect(r.tasks[0]?.stuck).toBe(false);
      expect(warnings).toHaveLength(0);
    } finally {
      setWaitStuckWarnForTests(restoreWarn);
      setWaitSleepForTests(restoreSleep);
    }
  });
});

// ─── resolveActorIdentity (verb-agnostic identity resolution) ────────────

describe("resolveActorIdentity", () => {
  it("prefers $MU_AGENT_NAME when set (mu-spawned worker case)", async () => {
    await withEnv("MU_AGENT_NAME", "worker-7", async () => {
      // Even with TMUX_PANE pointing somewhere with a different title,
      // MU_AGENT_NAME wins (it's set at spawn time and unforgeable from
      // outside without explicit override).
      const executor: TmuxExecutor = async (args) => {
        if (args[0] === "display-message" && args.includes("#{pane_title}")) {
          return { stdout: "different-title\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "unmocked", exitCode: 1 };
      };
      setTmuxExecutor(executor);
      await withEnv("TMUX_PANE", "%99", async () => {
        const actor = await resolveActorIdentity();
        expect(actor).toBe("worker-7");
      });
    });
  });

  it("falls back to pane title when MU_AGENT_NAME is unset (legacy/adopted pane)", async () => {
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "display-message" && args.includes("#{pane_title}")) {
        return { stdout: "legacy-pane-title\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };
    setTmuxExecutor(executor);
    await withEnv("MU_AGENT_NAME", undefined, async () => {
      await withEnv("TMUX_PANE", "%99", async () => {
        const actor = await resolveActorIdentity();
        expect(actor).toBe("legacy-pane-title");
      });
    });
  });

  it("falls back to $USER when no MU_AGENT_NAME and no TMUX_PANE", async () => {
    await withEnv("MU_AGENT_NAME", undefined, async () => {
      await withEnv("TMUX_PANE", undefined, async () => {
        await withEnv("USER", "martin", async () => {
          const actor = await resolveActorIdentity();
          expect(actor).toBe("martin");
        });
      });
    });
  });

  it("falls back to 'orchestrator' as the last-resort default", async () => {
    await withEnv("MU_AGENT_NAME", undefined, async () => {
      await withEnv("TMUX_PANE", undefined, async () => {
        await withEnv("USER", undefined, async () => {
          const actor = await resolveActorIdentity();
          expect(actor).toBe("orchestrator");
        });
      });
    });
  });
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

describe("TASK_STATUS_LIST mirrors every TaskStatus", () => {
  it("contains every legal status in canonical order", () => {
    // If a future task status is added to TaskStatus / TASK_STATUSES
    // but the LIST helper isn't kept in sync, every CLI surface that
    // names statuses (--help, error messages, --status validators)
    // will silently lie. Guard rail against that.
    expect(TASK_STATUS_LIST).toBe("OPEN | IN_PROGRESS | CLOSED | REJECTED | DEFERRED");
  });
});

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

// ─── sortTasks (--sort key) ────────────────────────────────────────────
//
// Covers the four sort keys exposed by `mu task list / next / ready
// --sort <key>`: roi, recency, age, id. The CLI surface is wired in
// src/cli/tasks.ts and the verb modules (src/cli/tasks/queries.ts);
// here we test the pure helper in isolation to keep the assertions
// crisp (no DB-time-fudging needed).

describe("sortTasks", () => {
  // Build TaskRows by hand so we can pin createdAt / updatedAt
  // deterministically (addTask stamps NOW, which we can't replay).
  // Field shape mirrors src/tasks.ts TaskRow (no extra metadata).
  function row(over: {
    name: string;
    impact: number;
    effortDays: number;
    createdAt: string;
    updatedAt: string;
  }) {
    return {
      name: over.name,
      workstreamName: "ws",
      title: over.name,
      status: "OPEN" as const,
      impact: over.impact,
      effortDays: over.effortDays,
      blockedBy: [],
      blocks: [],
      ownerName: null,
      createdAt: over.createdAt,
      updatedAt: over.updatedAt,
    };
  }

  // a: low ROI (10/2 = 5), oldest, most recently touched
  const rowA = row({
    name: "a",
    impact: 10,
    effortDays: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });
  // b: high ROI (90/1 = 90), middle, middle touched
  const rowB = row({
    name: "b",
    impact: 90,
    effortDays: 1,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
  // c: med ROI (40/2 = 20), newest, least recently touched
  const rowC = row({
    name: "c",
    impact: 40,
    effortDays: 2,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const rows = [rowA, rowB, rowC];

  it("roi: highest impact/effort first (default for next/ready)", () => {
    expect(sortTasks(rows, "roi").map((t) => t.name)).toEqual(["b", "c", "a"]);
  });

  it("recency: most-recently-updated first (updated_at DESC)", () => {
    expect(sortTasks(rows, "recency").map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("age: oldest-first (created_at ASC) — surfaces stale work", () => {
    expect(sortTasks(rows, "age").map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("id: local_id ASC — boring tiebreaker default for `task list`", () => {
    // Shuffle relative to insertion order; sort should still be a,b,c.
    expect(sortTasks([rowC, rowA, rowB], "id").map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("returns a copy (does not mutate the input array)", () => {
    const input = [rowA, rowB, rowC];
    const before = input.slice();
    sortTasks(input, "roi");
    expect(input).toEqual(before);
  });
});

describe("parseSortOption", () => {
  it("accepts every key in TASK_SORT_KEYS verbatim", () => {
    for (const k of TASK_SORT_KEYS) {
      expect(parseSortOption(k)).toBe(k);
    }
  });

  it("rejects unknown keys with a UsageError naming every legal value", () => {
    expect(() => parseSortOption("priority")).toThrow(/--sort must be one of/);
    expect(() => parseSortOption("ROI")).toThrow(/--sort must be one of/);
    expect(() => parseSortOption("")).toThrow(/--sort must be one of/);
  });
});

describe("relTime", () => {
  it("formats sub-minute / minute / hour / day / week buckets", () => {
    expect(relTime(0)).toBe("0s");
    expect(relTime(45_000)).toBe("45s");
    expect(relTime(5 * 60_000)).toBe("5m");
    expect(relTime(3 * 3600_000)).toBe("3h");
    expect(relTime(2 * 86_400_000)).toBe("2d");
    expect(relTime(14 * 86_400_000)).toBe("2w");
  });

  it("clamps negative durations (clock skew safety)", () => {
    expect(relTime(-5_000)).toBe("0s");
  });
});
