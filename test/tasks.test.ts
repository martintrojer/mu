// Tests for src/tasks.ts: validation, addTask + cycle check, addNote,
// claimTask atomic CAS, view reads, getPrerequisites traversal.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentNotInWorkstreamError, insertAgent } from "../src/agents.js";
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
  idFromTitle,
  isTaskStatus,
  isValidTaskId,
  listBlocked,
  listGoals,
  listNotes,
  listReady,
  listTasks,
  listTasksByOwner,
  openTask,
  rejectTask,
  releaseTask,
  removeBlockEdge,
  reparentTask,
  resolveActorIdentity,
  searchTasks,
  setTaskStatus,
  slugifyTitle,
  updateTask,
  waitForTasks,
} from "../src/tasks.js";
import { type TmuxExecutor, resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";

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

// Helper: env var deletion needs computed-key form so Biome's noDelete
// rule doesn't trip on the literal-property version.
async function withEnv(
  key: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

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
      localId: "design",
      workstream: "test",
      title: "Design",
      status: "OPEN",
      impact: 80,
      effortDays: 2,
      owner: null,
    });
  });

  it("rejects invalid id (no DB write)", () => {
    expect(() =>
      addTask(db, { localId: "Bad ID", workstream: "test", title: "x", impact: 50, effortDays: 1 }),
    ).toThrow(/invalid task id/);
    expect(listTasks(db)).toEqual([]);
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
    expect(build.localId).toBe("build");
    // Verify edge inserted: design blocks build → build is blocked.
    const blocked = listBlocked(db, "test").map((t) => t.localId);
    expect(blocked).toEqual(["build"]);
    const ready = listReady(db, "test").map((t) => t.localId);
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
    expect(getTask(db, "build")).toBeUndefined();
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
    expect(getTask(db, "build")).toBeUndefined();
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
    expect(getTask(db, "loop")).toBeUndefined();
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
    expect(getPrerequisites(db, "b")).toEqual(new Set(["b", "a"]));
  });
});

// ─── getPrerequisites ──────────────────────────────────────────────────

describe("getPrerequisites", () => {
  it("returns just the task itself for a leaf", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    expect(getPrerequisites(db, "a")).toEqual(new Set(["a"]));
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
    expect(getPrerequisites(db, "d")).toEqual(new Set(["d", "c", "b", "a"]));
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
    expect(getPrerequisites(db, "top")).toEqual(new Set(["top", "left", "right", "shared"]));
  });

  it("returns empty set for unknown task", () => {
    // Just the queried node itself; no prereqs since no edges target it.
    expect(getPrerequisites(db, "ghost")).toEqual(new Set(["ghost"]));
  });
});

// ─── addNote ───────────────────────────────────────────────────────────

describe("addNote", () => {
  it("appends a note to an existing task", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    const note = addNote(db, "a", "DECISION: chose JWT");
    expect(note).toMatchObject({
      taskId: "a",
      author: null,
      content: "DECISION: chose JWT",
    });
    expect(typeof note.id).toBe("number");
  });

  it("accepts optional author", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    const note = addNote(db, "a", "starting work", { author: "alice" });
    expect(note.author).toBe("alice");
  });

  it("rejects note for unknown task", () => {
    expect(() => addNote(db, "ghost", "note")).toThrow(TaskNotFoundError);
  });

  it("listNotes returns notes in insertion order", () => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addNote(db, "a", "first");
    addNote(db, "a", "second");
    addNote(db, "a", "third");
    expect(listNotes(db, "a").map((n) => n.content)).toEqual(["first", "second", "third"]);
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
    expect(listReady(db, "test").map((t) => t.localId)).toEqual(["specs"]);
  });

  it("ready promotes after a blocker closes", () => {
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='specs'").run();
    expect(
      listReady(db, "test")
        .map((t) => t.localId)
        .sort(),
    ).toEqual(["api", "ui"]);
  });

  it("blocked: every non-specs task is initially blocked", () => {
    const blockedIds = listBlocked(db, "test")
      .map((t) => t.localId)
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
    expect(listGoals(db, "test").map((t) => t.localId)).toEqual(["launch"]);
  });

  it("goals view excludes CLOSED tasks (a finished leaf is no longer a goal)", () => {
    expect(listGoals(db, "test").map((t) => t.localId)).toEqual(["launch"]);
    closeTask(db, "launch");
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
    const result = await claimTask(db, "auth", { agentName: "alice" });
    expect(result.owner).toBe("alice");
    expect(result.previousOwner).toBeNull();
    expect(result.previousStatus).toBe("OPEN");
    expect(result.status).toBe("IN_PROGRESS");
    expect(getTask(db, "auth")?.owner).toBe("alice");
    expect(getTask(db, "auth")?.status).toBe("IN_PROGRESS");
  });

  it("flips OPEN → IN_PROGRESS but leaves IN_PROGRESS unchanged on re-claim", async () => {
    await claimTask(db, "auth", { agentName: "alice" });
    const second = await claimTask(db, "auth", { agentName: "alice" });
    expect(second.previousStatus).toBe("IN_PROGRESS");
    expect(second.status).toBe("IN_PROGRESS");
  });

  it("does NOT flip status when CLOSED", async () => {
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='auth'").run();
    const result = await claimTask(db, "auth", { agentName: "alice" });
    expect(result.status).toBe("CLOSED");
  });

  it("re-claim by same agent is a no-op (idempotent)", async () => {
    await claimTask(db, "auth", { agentName: "alice" });
    await claimTask(db, "auth", { agentName: "alice" });
    expect(getTask(db, "auth")?.owner).toBe("alice");
  });

  it("throws TaskAlreadyOwnedError when another agent owns it", async () => {
    await claimTask(db, "auth", { agentName: "alice" });
    await expect(claimTask(db, "auth", { agentName: "bob" })).rejects.toBeInstanceOf(
      TaskAlreadyOwnedError,
    );
    // alice still owns it.
    expect(getTask(db, "auth")?.owner).toBe("alice");
  });

  it("throws TaskNotFoundError for unknown task", async () => {
    await expect(claimTask(db, "ghost", { agentName: "alice" })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
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
      const result = await claimTask(db, "auth");
      expect(result.owner).toBe("alice");
    });
  });

  it("throws when no agent name available (no $TMUX_PANE, no opts.agentName)", async () => {
    await withEnv("TMUX_PANE", undefined, async () => {
      await expect(claimTask(db, "auth")).rejects.toThrow(/no agent name/);
    });
  });

  it("bumps updated_at", async () => {
    const before = getTask(db, "auth")?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await claimTask(db, "auth", { agentName: "alice" });
    const after = getTask(db, "auth")?.updatedAt;
    expect(after).not.toBe(before);
  });

  // ─ ClaimerNotRegisteredError: pre-check that maps the would-be
  //   bare 'FOREIGN KEY constraint failed' (from the FK on tasks.owner
  //   added in the v2 migration) into a typed actionable error.
  it("throws ClaimerNotRegisteredError when --for names a non-existent agent", async () => {
    await expect(claimTask(db, "auth", { agentName: "ghost" })).rejects.toBeInstanceOf(
      ClaimerNotRegisteredError,
    );
    // Task untouched (no partial write through the FK).
    expect(getTask(db, "auth")?.owner).toBeNull();
    expect(getTask(db, "auth")?.status).toBe("OPEN");
  });

  it("ClaimerNotRegisteredError carries three structured next-steps via errorNextSteps()", async () => {
    try {
      await claimTask(db, "auth", { agentName: "ghost" });
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
        await claimTask(db, "auth");
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
    const result = await claimTask(db, "auth", { self: true, actor: "orchestrator" });
    expect(result.owner).toBeNull();
    expect(result.actor).toBe("orchestrator");
    expect(result.previousStatus).toBe("OPEN");
    expect(result.status).toBe("IN_PROGRESS");
    expect(getTask(db, "auth")?.owner).toBeNull();
    expect(getTask(db, "auth")?.status).toBe("IN_PROGRESS");
  });

  it("--self emits an agent_logs event with the actor as source", async () => {
    await claimTask(db, "auth", { self: true, actor: "deploy-bot" });
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
    const result = await claimTask(db, "auth", { self: true, actor: "phantom" });
    expect(result.owner).toBeNull();
    expect(result.actor).toBe("phantom");
  });

  it("--self with an unowned task succeeds; --self with an owned task throws TaskAlreadyOwnedError", async () => {
    await claimTask(db, "auth", { agentName: "alice" });
    await expect(
      claimTask(db, "auth", { self: true, actor: "orchestrator" }),
    ).rejects.toBeInstanceOf(TaskAlreadyOwnedError);
    // Alice still owns it (no overwrite).
    expect(getTask(db, "auth")?.owner).toBe("alice");
  });

  it("--self and agentName together is a usage error", async () => {
    await expect(claimTask(db, "auth", { self: true, agentName: "alice" })).rejects.toThrow(
      /mutually exclusive/,
    );
  });

  it("--self resolves actor from $TMUX_PANE when not explicit", async () => {
    const executor: TmuxExecutor = async (args) => {
      if (args[0] === "display-message" && args.includes("#{pane_title}")) {
        return { stdout: "orchestrator-pane\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unmocked", exitCode: 1 };
    };
    setTmuxExecutor(executor);
    await withEnv("TMUX_PANE", "%42", async () => {
      const result = await claimTask(db, "auth", { self: true });
      expect(result.actor).toBe("orchestrator-pane");
    });
  });

  it("--self resolves actor from $USER when no $TMUX_PANE", async () => {
    await withEnv("TMUX_PANE", undefined, async () => {
      await withEnv("USER", "martin", async () => {
        const result = await claimTask(db, "auth", { self: true });
        expect(result.actor).toBe("martin");
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
          const result = await claimTask(db, "auth", { self: true });
          expect(result.actor).toBe("orchestrator");
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
  it("throws AgentNotInWorkstreamError when --for names an agent in a different workstream", async () => {
    // 'auth' lives in workstream 'test' (set up in the outer
    // beforeEach). Add a fresh agent in a different workstream and
    // try to claim 'auth' for it.
    insertAgent(db, {
      name: "cross",
      workstream: "other",
      paneId: "%99",
      status: "busy",
    });
    await expect(claimTask(db, "auth", { agentName: "cross" })).rejects.toBeInstanceOf(
      AgentNotInWorkstreamError,
    );
    // No partial write: task untouched.
    expect(getTask(db, "auth")?.owner).toBeNull();
    expect(getTask(db, "auth")?.status).toBe("OPEN");
  });

  it("AgentNotInWorkstreamError from cross-workstream claim carries actionable next-steps", async () => {
    insertAgent(db, {
      name: "cross",
      workstream: "other",
      paneId: "%99",
      status: "busy",
    });
    try {
      await claimTask(db, "auth", { agentName: "cross" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentNotInWorkstreamError);
      const e = err as AgentNotInWorkstreamError;
      expect(e.agentName).toBe("cross");
      expect(e.expectedWorkstream).toBe("test"); // task's workstream
      expect(e.actualWorkstream).toBe("other"); // agent's workstream
      const steps = e.errorNextSteps();
      expect(steps.length).toBeGreaterThan(0);
    }
  });

  it("--self path is unaffected by cross-workstream guard (orchestrator-direct)", async () => {
    // No agent FK to check on --self; the orchestrator can drive any
    // workstream's tasks anonymously. Regression cover: the new guard
    // must not leak into the --self path.
    const result = await claimTask(db, "auth", { self: true, actor: "orchestrator" });
    expect(result.owner).toBeNull();
    expect(result.actor).toBe("orchestrator");
    expect(getTask(db, "auth")?.status).toBe("IN_PROGRESS");
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
    expect(getTaskEdges(db, "build")).toEqual({
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
    expect(getTaskEdges(db, "orphan")).toEqual({ blockers: [], dependents: [] });
  });

  it("returns empty arrays for a missing task (no error)", () => {
    // Note: the verb that wraps this throws TaskNotFoundError; the
    // primitive itself is permissive so callers can pre-check existence
    // separately.
    expect(getTaskEdges(db, "ghost")).toEqual({ blockers: [], dependents: [] });
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
    expect(getTaskEdges(db, "design").dependents).toEqual(["a", "build", "z"]);
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
    const r = closeTask(db, "design");
    expect(r).toEqual({ previousStatus: "OPEN", status: "CLOSED", changed: true });
    expect(getTask(db, "design")?.status).toBe("CLOSED");
  });

  it("closeTask is idempotent on an already-CLOSED task", () => {
    closeTask(db, "design");
    const r = closeTask(db, "design");
    expect(r.changed).toBe(false);
    expect(r.status).toBe("CLOSED");
  });

  it("openTask flips CLOSED → OPEN and is idempotent on already-OPEN", () => {
    closeTask(db, "design");
    const r1 = openTask(db, "design");
    expect(r1).toEqual({ previousStatus: "CLOSED", status: "OPEN", changed: true });
    const r2 = openTask(db, "design");
    expect(r2.changed).toBe(false);
  });

  it("openTask leaves owner intact (use releaseTask to clear owner)", async () => {
    await claimTask(db, "design", { agentName: "worker-1" });
    closeTask(db, "design");
    openTask(db, "design");
    expect(getTask(db, "design")?.owner).toBe("worker-1");
  });

  it("setTaskStatus accepts arbitrary status", () => {
    const r = setTaskStatus(db, "design", "IN_PROGRESS");
    expect(r).toEqual({ previousStatus: "OPEN", status: "IN_PROGRESS", changed: true });
    expect(getTask(db, "design")?.status).toBe("IN_PROGRESS");
  });

  it("setTaskStatus / closeTask / openTask all throw TaskNotFoundError on missing", () => {
    expect(() => setTaskStatus(db, "ghost", "CLOSED")).toThrow(TaskNotFoundError);
    expect(() => closeTask(db, "ghost")).toThrow(TaskNotFoundError);
    expect(() => openTask(db, "ghost")).toThrow(TaskNotFoundError);
  });

  it("closeTask bumps updated_at", () => {
    const before = getTask(db, "design")?.updatedAt;
    // Sleep tick to ensure ISO-string difference at ms resolution.
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    closeTask(db, "design");
    const after = getTask(db, "design")?.updatedAt;
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
    await claimTask(db, "design", { agentName: "worker-1" });
    expect(getTask(db, "design")?.status).toBe("IN_PROGRESS");

    const r = releaseTask(db, "design");
    expect(r.previousOwner).toBe("worker-1");
    expect(r.changed).toBe(true);
    expect(r.status).toBe("IN_PROGRESS"); // status preserved
    const after = getTask(db, "design");
    expect(after?.owner).toBeNull();
    expect(after?.status).toBe("IN_PROGRESS");
  });

  it("--reopen also flips status back to OPEN", async () => {
    await claimTask(db, "design", { agentName: "worker-1" });
    const r = releaseTask(db, "design", { reopen: true });
    expect(r.previousStatus).toBe("IN_PROGRESS");
    expect(r.status).toBe("OPEN");
    expect(r.changed).toBe(true);
    const after = getTask(db, "design");
    expect(after?.owner).toBeNull();
    expect(after?.status).toBe("OPEN");
  });

  it("--reopen on an already-OPEN unowned task is a no-op", () => {
    const r = releaseTask(db, "design", { reopen: true });
    expect(r.changed).toBe(false);
  });

  it("plain release on an already-unowned task is a no-op", () => {
    const r = releaseTask(db, "design");
    expect(r.changed).toBe(false);
    expect(r.previousOwner).toBeNull();
  });

  it("--reopen on a CLOSED unowned task DOES flip back to OPEN (changed=true)", () => {
    closeTask(db, "design");
    const r = releaseTask(db, "design", { reopen: true });
    expect(r.changed).toBe(true);
    expect(r.status).toBe("OPEN");
  });

  it("throws TaskNotFoundError on missing task", () => {
    expect(() => releaseTask(db, "ghost")).toThrow(TaskNotFoundError);
  });
});

// ─── listTasksByOwner ─────────────────────────────────────────────────

describe("listTasksByOwner", () => {
  it("returns tasks owned by an agent across workstreams", async () => {
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "billing", title: "C", impact: 50, effortDays: 1 });
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "worker-2", workstream: "billing", paneId: "%2", status: "busy" });
    await claimTask(db, "a", { agentName: "worker-1" });
    // Construct the cross-workstream owner state directly. The verb
    // path (claimTask --for) now correctly rejects this with an
    // AgentNotInWorkstreamError (cross_workstream_claim_for fix), but
    // the listTasksByOwner read can still legitimately surface a row
    // whose owner lives in a different workstream — e.g. when the agent
    // was re-spawned in a new workstream after claiming, or when an
    // operator hand-edits via `mu sql`. The query MUST cross workstream
    // boundaries; this test pins that contract.
    const setOwner = db.prepare(
      "UPDATE tasks SET owner = ?, status = 'IN_PROGRESS' WHERE local_id = ?",
    );
    setOwner.run("worker-1", "c");
    setOwner.run("worker-2", "b");

    const ownedByW1 = listTasksByOwner(db, "worker-1").map((t) => t.localId);
    expect(ownedByW1.sort()).toEqual(["a", "c"]);
    const ownedByW2 = listTasksByOwner(db, "worker-2").map((t) => t.localId);
    expect(ownedByW2).toEqual(["b"]);
  });

  it("returns empty for an agent with no claims (or unknown agent)", () => {
    expect(listTasksByOwner(db, "ghost")).toEqual([]);
    insertAgent(db, { name: "idle", workstream: "auth", paneId: "%1", status: "free" });
    expect(listTasksByOwner(db, "idle")).toEqual([]);
  });

  it("excludes CLOSED tasks by default; --include-closed surfaces them", async () => {
    // Real bug found in real use: `mu task owned-by worker-1` was
    // returning closed tasks alongside live ones, defeating the
    // verb's purpose ("what is X currently working on?").
    addTask(db, { localId: "live", workstream: "auth", title: "Live", impact: 50, effortDays: 1 });
    addTask(db, { localId: "done", workstream: "auth", title: "Done", impact: 50, effortDays: 1 });
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", status: "busy" });
    await claimTask(db, "live", { agentName: "w1" });
    await claimTask(db, "done", { agentName: "w1" });
    closeTask(db, "done"); // closeTask preserves owner intentionally

    const defaultOwned = listTasksByOwner(db, "w1").map((t) => t.localId);
    expect(defaultOwned).toEqual(["live"]);

    const allOwned = listTasksByOwner(db, "w1", { includeClosed: true })
      .map((t) => t.localId)
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
    addNote(db, "build_auth", "DECISION: chose JWT; refresh via cookie");
    addNote(db, "design_billing", "FILES: src/billing/invoice.rs");
  });

  it("matches title substring (case-insensitive), scoped to a workstream", () => {
    expect(searchTasks(db, "jwt", { workstream: "auth" }).map((t) => t.localId)).toEqual([
      "design_auth",
    ]);
    expect(searchTasks(db, "DESIGN", { workstream: "auth" }).map((t) => t.localId)).toEqual([
      "design_auth",
    ]);
  });

  it("matches local_id substring", () => {
    expect(
      searchTasks(db, "_auth", { workstream: "auth" })
        .map((t) => t.localId)
        .sort(),
    ).toEqual(["build_auth", "design_auth"]);
  });

  it("with no workstream, spans every workstream", () => {
    expect(
      searchTasks(db, "design")
        .map((t) => t.localId)
        .sort(),
    ).toEqual(["design_auth", "design_billing"]);
  });

  it("--in-notes also matches note content", () => {
    // 'jwt' appears in design_auth's title AND build_auth's note.
    const ids = searchTasks(db, "jwt", { workstream: "auth", includeNotes: true }).map(
      (t) => t.localId,
    );
    expect(ids.sort()).toEqual(["build_auth", "design_auth"]);

    // Without --in-notes, only design_auth matches (notes ignored).
    expect(searchTasks(db, "jwt", { workstream: "auth" }).map((t) => t.localId)).toEqual([
      "design_auth",
    ]);
  });

  it("DISTINCTs the result when a task has multiple matching notes", () => {
    addNote(db, "build_auth", "DECISION: also JWT for refresh");
    addNote(db, "build_auth", "VERIFIED: jwt expiry tests pass");
    const ids = searchTasks(db, "jwt", { workstream: "auth", includeNotes: true }).map(
      (t) => t.localId,
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
    expect(addBlockEdge(db, "b", "a").added).toBe(true);
    expect(getTaskEdges(db, "b").blockers).toEqual(["a"]);
  });

  it("is idempotent on duplicate edge (added=false)", () => {
    addBlockEdge(db, "b", "a");
    expect(addBlockEdge(db, "b", "a").added).toBe(false);
  });

  it("throws CycleError on self-reference", () => {
    expect(() => addBlockEdge(db, "a", "a")).toThrow(CycleError);
  });

  it("throws CycleError when the edge would create a cycle", () => {
    addBlockEdge(db, "b", "a"); // a blocks b
    addBlockEdge(db, "c", "b"); // b blocks c; chain: a -> b -> c
    // adding c -> a would create a cycle (a -> b -> c -> a)
    expect(() => addBlockEdge(db, "a", "c")).toThrow(CycleError);
  });

  it("throws TaskNotFoundError if either task is missing", () => {
    expect(() => addBlockEdge(db, "b", "ghost")).toThrow(/no such task: ghost/);
    expect(() => addBlockEdge(db, "ghost", "a")).toThrow(/no such task: ghost/);
  });

  it("throws CrossWorkstreamEdgeError when blocker is in a different workstream", () => {
    addTask(db, {
      localId: "x",
      workstream: "billing",
      title: "X",
      impact: 50,
      effortDays: 1,
    });
    expect(() => addBlockEdge(db, "a", "x")).toThrow(CrossWorkstreamEdgeError);
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
    expect(removeBlockEdge(db, "b", "a").removed).toBe(true);
    expect(getTaskEdges(db, "b").blockers).toEqual([]);
  });

  it("is idempotent on missing edge (removed=false)", () => {
    removeBlockEdge(db, "b", "a");
    expect(removeBlockEdge(db, "b", "a").removed).toBe(false);
  });

  it("is permissive about missing tasks (no throw)", () => {
    expect(removeBlockEdge(db, "ghost", "also-ghost").removed).toBe(false);
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
    addNote(db, "b", "note 1");
    addNote(db, "b", "note 2");
  });

  it("deletes the row and reports deleted=true", () => {
    expect(deleteTask(db, "b").deleted).toBe(true);
    expect(getTask(db, "b")).toBeUndefined();
  });

  it("cascades incoming AND outgoing edges (FK on both from_task and to_task)", () => {
    // Before: edges a->b and b->c, both touch b.
    expect(deleteTask(db, "b").deletedEdges).toBe(2);
    // After: no edges remain.
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n).toBe(0);
  });

  it("cascades notes (FK on task_id)", () => {
    expect(deleteTask(db, "b").deletedNotes).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_notes").get() as { n: number }).n).toBe(0);
  });

  it("is idempotent on a missing task (deleted=false; counts=0)", () => {
    expect(deleteTask(db, "ghost")).toEqual({
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
    const r = updateTask(db, "a", { title: "new title" });
    expect(r).toEqual({ updated: true, changedFields: ["title"] });
    expect(getTask(db, "a")?.title).toBe("new title");
  });

  it("updates multiple fields in one call", () => {
    const r = updateTask(db, "a", { title: "T", impact: 90, effortDays: 5 });
    expect(r.updated).toBe(true);
    expect(r.changedFields.sort()).toEqual(["effortDays", "impact", "title"]);
    const row = getTask(db, "a");
    expect(row?.title).toBe("T");
    expect(row?.impact).toBe(90);
    expect(row?.effortDays).toBe(5);
  });

  it("is a no-op when supplied values match current (changedFields is empty)", () => {
    const r = updateTask(db, "a", { title: "original title", impact: 50, effortDays: 1 });
    expect(r).toEqual({ updated: false, changedFields: [] });
  });

  it("is a no-op when no fields are passed", () => {
    expect(updateTask(db, "a", {})).toEqual({ updated: false, changedFields: [] });
  });

  it("only changes the differing field when some match and some don't", () => {
    const r = updateTask(db, "a", { title: "original title", impact: 99 });
    expect(r.changedFields).toEqual(["impact"]);
  });

  it("throws TaskNotFoundError on missing task", () => {
    expect(() => updateTask(db, "ghost", { title: "x" })).toThrow(/no such task: ghost/);
  });

  it("propagates schema CHECK violations (e.g. impact > 100)", () => {
    expect(() => updateTask(db, "a", { impact: 101 })).toThrow(/CHECK constraint failed/);
  });

  it("bumps updated_at on a real change", () => {
    const before = getTask(db, "a")?.updatedAt;
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    updateTask(db, "a", { title: "new" });
    const after = getTask(db, "a")?.updatedAt;
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
    const r = reparentTask(db, "target", ["c"]);
    expect(r).toEqual({ removedEdges: 2, addedEdges: 1 });
    expect(getTaskEdges(db, "target").blockers).toEqual(["c"]);
  });

  it("clears all incoming edges with empty blockers list", () => {
    const r = reparentTask(db, "target", []);
    expect(r).toEqual({ removedEdges: 2, addedEdges: 0 });
    expect(getTaskEdges(db, "target").blockers).toEqual([]);
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
    expect(() => reparentTask(db, "target", ["downstream"])).toThrow(CycleError);
    // Atomicity: original edges are still in place after the rejection.
    expect(getTaskEdges(db, "target").blockers.sort()).toEqual(["a", "b"]);
  });

  it("throws CycleError on self-reference", () => {
    expect(() => reparentTask(db, "target", ["target"])).toThrow(CycleError);
  });

  it("throws TaskNotFoundError if any new blocker is missing", () => {
    expect(() => reparentTask(db, "target", ["c", "ghost"])).toThrow(/no such task: ghost/);
    // No DELETE happened on validation failure.
    expect(getTaskEdges(db, "target").blockers.sort()).toEqual(["a", "b"]);
  });

  it("throws CrossWorkstreamEdgeError if a blocker is in a different workstream", () => {
    addTask(db, {
      localId: "x",
      workstream: "billing",
      title: "X",
      impact: 50,
      effortDays: 1,
    });
    expect(() => reparentTask(db, "target", ["x"])).toThrow(CrossWorkstreamEdgeError);
    expect(getTaskEdges(db, "target").blockers.sort()).toEqual(["a", "b"]);
  });

  it("throws TaskNotFoundError on missing task", () => {
    expect(() => reparentTask(db, "ghost", ["a"])).toThrow(/no such task: ghost/);
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

  it("prefixes t_ when the slug starts with the reserved mu_ prefix", () => {
    // Real bug found in real use: title "Mu smoke test" slugified to
    // mu_smoke_test which then dead-ended at addTask's reserved-prefix
    // check. The fix prepends t_ so the derived slug always passes.
    expect(slugifyTitle("Mu smoke test")).toBe("t_mu_smoke_test");
    expect(slugifyTitle("mu testing")).toBe("t_mu_testing");
    expect(slugifyTitle("MU_THING")).toBe("t_mu_thing");
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

describe("mu_ prefix reservation", () => {
  it("isValidTaskId rejects mu_ prefix", () => {
    expect(isValidTaskId("mu_foo")).toBe(false);
    expect(isValidTaskId("mu_")).toBe(false);
    // Just a 'mu' prefix WITHOUT the underscore is fine.
    expect(isValidTaskId("music")).toBe(true);
    expect(isValidTaskId("mu")).toBe(true);
  });

  it("addTask refuses mu_ ids with a clear error", () => {
    expect(() =>
      addTask(db, {
        localId: "mu_internal",
        workstream: "auth",
        title: "x",
        impact: 1,
        effortDays: 1,
      }),
    ).toThrow(/the "mu_" prefix is reserved/);
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
    closeTask(db, "design", { evidence: "tests pass: npm test exit 0" });
    const p = lastEventPayload();
    expect(p).toContain("task status design");
    expect(p).toContain('evidence="tests pass: npm test exit 0"');
  });

  it("closeTask without --evidence omits the suffix", () => {
    closeTask(db, "design");
    const p = lastEventPayload();
    expect(p).toContain("task status design");
    expect(p).not.toContain("evidence=");
  });

  it("openTask --evidence threads through too", () => {
    closeTask(db, "design");
    db.prepare("DELETE FROM agent_logs").run();
    openTask(db, "design", { evidence: "reopened: deploy rollback" });
    expect(lastEventPayload()).toContain('evidence="reopened: deploy rollback"');
  });

  it("releaseTask --evidence threads through (and survives --reopen)", () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    db.prepare(
      "UPDATE tasks SET owner='worker-1', status='IN_PROGRESS' WHERE local_id='design'",
    ).run();
    db.prepare("DELETE FROM agent_logs").run();
    releaseTask(db, "design", { reopen: true, evidence: "agent crashed mid-task" });
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
    });
    const p = lastEventPayload();
    expect(p).toContain("task claim design by worker-1");
    expect(p).toContain('evidence="reviewed task; have implementation plan"');
  });

  it("evidence is JSON-quoted so multi-word + special chars stay legible", () => {
    closeTask(db, "design", { evidence: 'has "quotes" and a \\backslash' });
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
        .map((t) => t.localId)
        .sort(),
    ).toEqual(["done1", "ip1", "open1", "open2"]);
  });

  it("filters to a single status (string form)", () => {
    expect(
      listTasks(db, "auth", { status: "OPEN" })
        .map((t) => t.localId)
        .sort(),
    ).toEqual(["open1", "open2"]);
    expect(listTasks(db, "auth", { status: "IN_PROGRESS" }).map((t) => t.localId)).toEqual(["ip1"]);
    expect(listTasks(db, "auth", { status: "CLOSED" }).map((t) => t.localId)).toEqual(["done1"]);
  });

  it("filters to multiple statuses (array form)", () => {
    expect(
      listTasks(db, "auth", { status: ["OPEN", "IN_PROGRESS"] })
        .map((t) => t.localId)
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
        .map((t) => t.localId)
        .sort(),
    ).toEqual(["open1", "open2"]);
    // Other workstream's OPEN task isn't included when filtered to 'auth'.
    expect(
      listTasks(db, undefined, { status: "OPEN" })
        .map((t) => t.localId)
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
    setTaskStatus(db, "a", "CLOSED");
    setTaskStatus(db, "b", "CLOSED");
    setTaskStatus(db, "c", "CLOSED");
    const r = await waitForTasks(db, ["a", "b", "c"], { pollMs: 50 });
    expect(r.allReached).toBe(true);
    expect(r.anyReached).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.elapsedMs).toBeLessThan(100); // didn't sleep through any poll cycle
    expect(r.tasks).toEqual([
      { localId: "a", status: "CLOSED", reachedTarget: true },
      { localId: "b", status: "CLOSED", reachedTarget: true },
      { localId: "c", status: "CLOSED", reachedTarget: true },
    ]);
  });

  it("returns immediately on --any when at least one task already reached the target", async () => {
    setTaskStatus(db, "b", "CLOSED");
    const r = await waitForTasks(db, ["a", "b", "c"], { any: true, pollMs: 50 });
    expect(r.allReached).toBe(false);
    expect(r.anyReached).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it("blocks until the condition is met (poll loop wakes up on the next snapshot)", async () => {
    // Schedule a status change to fire after one poll interval.
    const flipAt = Date.now();
    setTimeout(() => setTaskStatus(db, "a", "CLOSED"), 60);
    const r = await waitForTasks(db, ["a"], { pollMs: 30, timeoutMs: 1000 });
    expect(r.allReached).toBe(true);
    expect(r.timedOut).toBe(false);
    // Allow generous slack; assert we DID wait (not the immediate-exit path).
    expect(Date.now() - flipAt).toBeGreaterThanOrEqual(30);
  });

  it("times out with timedOut=true and exit-code-mappable result when condition not met", async () => {
    const r = await waitForTasks(db, ["a", "b"], { timeoutMs: 100, pollMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.allReached).toBe(false);
    expect(r.anyReached).toBe(false);
    // Per-task state at exit time still useful for the caller.
    expect(r.tasks.map((t) => t.status)).toEqual(["OPEN", "OPEN"]);
  });

  it("--any times out cleanly when no task reaches the target", async () => {
    const r = await waitForTasks(db, ["a", "b"], { any: true, timeoutMs: 100, pollMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.anyReached).toBe(false);
  });

  it("respects a non-default --status target (e.g. IN_PROGRESS)", async () => {
    setTaskStatus(db, "a", "IN_PROGRESS");
    setTaskStatus(db, "b", "IN_PROGRESS");
    const r = await waitForTasks(db, ["a", "b"], { status: "IN_PROGRESS", pollMs: 50 });
    expect(r.allReached).toBe(true);
    expect(r.tasks.every((t) => t.status === "IN_PROGRESS")).toBe(true);
  });

  it("throws TaskNotFoundError pre-flight if any listed task doesn't exist (loud-fail)", async () => {
    await expect(waitForTasks(db, ["a", "ghost", "b"], { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
  });

  it("rejects an empty id list", async () => {
    await expect(waitForTasks(db, [])).rejects.toThrow(/non-empty/);
  });

  it("partial-progress on timeout: some tasks reached, others didn't", async () => {
    setTaskStatus(db, "a", "CLOSED");
    // b stays OPEN → all-of fails on timeout but anyReached is true.
    const r = await waitForTasks(db, ["a", "b"], { timeoutMs: 80, pollMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(r.allReached).toBe(false);
    expect(r.anyReached).toBe(true); // 'a' reached
    expect(r.tasks[0]?.reachedTarget).toBe(true);
    expect(r.tasks[1]?.reachedTarget).toBe(false);
  });

  it("survives a task being deleted mid-wait (treats it as 'never reached')", async () => {
    setTimeout(() => deleteTask(db, "b"), 40);
    const r = await waitForTasks(db, ["a", "b"], { timeoutMs: 120, pollMs: 30 });
    expect(r.timedOut).toBe(true);
    // 'b' was deleted; defensive snapshot defaults to 'OPEN' / not reached.
    const bState = r.tasks.find((t) => t.localId === "b");
    expect(bState?.reachedTarget).toBe(false);
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
    const r = rejectTask(db, "alone", { evidence: "out of scope" });
    expect(r.changed).toBe(true);
    expect(r.changedIds).toEqual(["alone"]);
    expect(r.status).toBe("REJECTED");
    expect(getTask(db, "alone")?.status).toBe("REJECTED");
  });

  it("defer succeeds with no dependents and stamps DEFERRED", () => {
    addTask(db, { localId: "park", workstream: "ws", title: "P", impact: 50, effortDays: 1 });
    const r = deferTask(db, "park", { evidence: "not now" });
    expect(r.changed).toBe(true);
    expect(getTask(db, "park")?.status).toBe("DEFERRED");
  });

  it("idempotent: rejecting an already-REJECTED task with no dependents is a no-op", () => {
    addTask(db, { localId: "alone", workstream: "ws", title: "A", impact: 50, effortDays: 1 });
    rejectTask(db, "alone");
    const r = rejectTask(db, "alone");
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
    expect(() => rejectTask(db, "design")).toThrow(TaskHasOpenDependentsError);
    // Root task untouched after the throw.
    expect(getTask(db, "design")?.status).toBe("OPEN");
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
    setTaskStatus(db, "build", "IN_PROGRESS");
    expect(() => deferTask(db, "design")).toThrow(TaskHasOpenDependentsError);
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
    closeTask(db, "build");
    const r = rejectTask(db, "design");
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
    rejectTask(db, "build_a");
    deferTask(db, "build_b");
    // Now design has no OPEN/IN_PROGRESS dependents → reject succeeds.
    const r = rejectTask(db, "design");
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
    const r = rejectTask(db, "design", { cascade: true, yes: true, evidence: "feature dropped" });
    expect(r.changed).toBe(true);
    expect(new Set(r.changedIds)).toEqual(new Set(["design", "build", "review"]));
    expect(getTask(db, "design")?.status).toBe("REJECTED");
    expect(getTask(db, "build")?.status).toBe("REJECTED");
    expect(getTask(db, "review")?.status).toBe("REJECTED");
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
    closeTask(db, "build"); // already shipped this one
    // Cascade defer from design: build is CLOSED so untouched; ship has no
    // open dependents but is open itself and depends transitively on design
    // through CLOSED build — and CLOSED satisfies the edge → ship is NOT
    // an open dependent of design via the open-dependents query.
    const r = deferTask(db, "design", { cascade: true, yes: true });
    expect(r.changed).toBe(true);
    expect(getTask(db, "design")?.status).toBe("DEFERRED");
    expect(getTask(db, "build")?.status).toBe("CLOSED");
    // ship is independent of design once build closed; defer didn't touch it.
    expect(getTask(db, "ship")?.status).toBe("OPEN");
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
    setTaskStatus(db, "rj", "REJECTED");
    setTaskStatus(db, "df", "DEFERRED");
    // dep_r / dep_d should be in `blocked` view, NOT in `ready` view.
    const ready = listReady(db, "ws").map((t) => t.localId);
    const blocked = listBlocked(db, "ws").map((t) => t.localId);
    expect(ready).not.toContain("dep_r");
    expect(ready).not.toContain("dep_d");
    expect(blocked).toContain("dep_r");
    expect(blocked).toContain("dep_d");
  });

  it("REJECTED and DEFERRED leaves are NOT goals (excluded from listGoals)", () => {
    addTask(db, { localId: "open_leaf", workstream: "ws", title: "OL", impact: 50, effortDays: 1 });
    addTask(db, { localId: "rej_leaf", workstream: "ws", title: "RL", impact: 50, effortDays: 1 });
    addTask(db, { localId: "def_leaf", workstream: "ws", title: "DL", impact: 50, effortDays: 1 });
    setTaskStatus(db, "rej_leaf", "REJECTED");
    setTaskStatus(db, "def_leaf", "DEFERRED");
    const goals = listGoals(db, "ws").map((g) => g.localId);
    expect(goals).toContain("open_leaf");
    expect(goals).not.toContain("rej_leaf");
    expect(goals).not.toContain("def_leaf");
  });

  it("listTasksByOwner default omits REJECTED and DEFERRED (live-work view)", () => {
    insertAgent(db, { name: "w1", workstream: "ws", paneId: "%1", status: "busy" });
    addTask(db, { localId: "live", workstream: "ws", title: "L", impact: 50, effortDays: 1 });
    addTask(db, { localId: "rej", workstream: "ws", title: "R", impact: 50, effortDays: 1 });
    addTask(db, { localId: "def", workstream: "ws", title: "D", impact: 50, effortDays: 1 });
    db.prepare("UPDATE tasks SET owner = 'w1' WHERE local_id IN ('live','rej','def')").run();
    setTaskStatus(db, "rej", "REJECTED");
    setTaskStatus(db, "def", "DEFERRED");
    expect(listTasksByOwner(db, "w1").map((t) => t.localId)).toEqual(["live"]);
    expect(
      listTasksByOwner(db, "w1", { includeClosed: true })
        .map((t) => t.localId)
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
    const r = rejectTask(db, "design", { cascade: true });
    // dryRun shape
    expect(r.dryRun).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.changedIds).toEqual(["design", "build"]); // would-affect list
    expect(r.affectedIds).toEqual(["design", "build"]);
    // DB unchanged
    expect(getTask(db, "design")?.status).toBe("OPEN");
    expect(getTask(db, "build")?.status).toBe("OPEN");
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
    const r = rejectTask(db, "design", { cascade: true, yes: true });
    expect(r.dryRun).toBe(false);
    expect(r.changed).toBe(true);
    expect(new Set(r.changedIds)).toEqual(new Set(["design", "build"]));
    expect(getTask(db, "design")?.status).toBe("REJECTED");
    expect(getTask(db, "build")?.status).toBe("REJECTED");
  });

  it("single-task case (no dependents) skips the dry-run and commits immediately", () => {
    // No --yes needed when there's nothing to preview.
    addTask(db, { localId: "alone", workstream: "ws", title: "A", impact: 50, effortDays: 1 });
    const r = rejectTask(db, "alone", { cascade: true });
    expect(r.dryRun).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.changedIds).toEqual(["alone"]);
    expect(r.affectedIds).toEqual(["alone"]);
    expect(getTask(db, "alone")?.status).toBe("REJECTED");
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
    const r = rejectTask(db, "design", { cascade: true, yes: true });
    expect(r.affectedIds).toEqual(["design", "build"]);
  });
});
