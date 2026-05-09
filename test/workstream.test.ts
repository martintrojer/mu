// Tests for src/workstream.ts. Real SQLite + mocked tmux executor.
//
// Covers the destroy verb's idempotency, isolation between workstreams,
// FK cascade reporting, and the order-of-operations guarantee that the
// tmux session is torn down before DB rows so a tmux failure leaves the
// registry intact.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent, listAgents } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addNote, addTask, listTasks } from "../src/tasks.js";
import {
  type TmuxExecResult,
  type TmuxExecutor,
  resetTmuxExecutor,
  setTmuxExecutor,
} from "../src/tmux.js";
import { type VcsBackend, noneBackend } from "../src/vcs.js";
import {
  WorkstreamNameInvalidError,
  destroyWorkstream,
  ensureWorkstream,
  isValidWorkstreamName,
  listWorkstreams,
  summarizeWorkstream,
} from "../src/workstream.js";

// ─── Mock tmux harness ─────────────────────────────────────────────────

function ok(stdout = ""): TmuxExecResult {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr = ""): TmuxExecResult {
  return { exitCode: 1, stdout: "", stderr };
}

interface MockState {
  sessions: Set<string>;
  killed: string[];
}

function mockTmux(state: MockState): { calls: string[][]; executor: TmuxExecutor } {
  const calls: string[][] = [];
  const executor: TmuxExecutor = async (args) => {
    calls.push([...args]);
    const verb = args[0];

    if (verb === "has-session") {
      const target = args[2];
      return state.sessions.has(target ?? "") ? ok() : fail(`can't find session: ${target}`);
    }
    if (verb === "kill-session") {
      const target = args[2];
      if (!target || !state.sessions.has(target)) {
        return fail(`can't find session: ${target}`);
      }
      state.sessions.delete(target);
      state.killed.push(target);
      return ok();
    }
    if (verb === "list-sessions") {
      if (state.sessions.size === 0) return fail("no server running");
      return ok([...state.sessions].join("\n"));
    }
    return fail(`unmocked tmux call: ${args.join(" ")}`);
  };
  return { calls, executor };
}

// ─── Fixture setup ─────────────────────────────────────────────────────

let tmpDir: string;
let db: Db;
let state: MockState;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mu-workstream-test-"));
  db = openDb({ path: join(tmpDir, "mu.db") });
  state = { sessions: new Set(), killed: [] };
});

afterEach(() => {
  resetTmuxExecutor();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed: 2 agents, 3 tasks (with one edge), 2 notes — all in `auth`. */
function seedAuth(): void {
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  insertAgent(db, { name: "worker-2", workstream: "auth", paneId: "%2", status: "needs_input" });
  addTask(db, {
    localId: "design",
    workstream: "auth",
    title: "Design",
    impact: 80,
    effortDays: 2,
  });
  addTask(db, {
    localId: "build",
    workstream: "auth",
    title: "Build",
    impact: 80,
    effortDays: 5,
    blockedBy: ["design"],
  });
  addTask(db, {
    localId: "ship",
    workstream: "auth",
    title: "Ship",
    impact: 90,
    effortDays: 1,
    blockedBy: ["build"],
  });
  addNote(db, "design", "DECISION: JWT");
  addNote(db, "design", "FILES: src/auth.rs");
}

// ─── summarizeWorkstream ───────────────────────────────────────────────

// ─── ensureWorkstream + FK behaviour ───────────────────────────────────

describe("ensureWorkstream", () => {
  it("inserts the row on first call and is idempotent thereafter", () => {
    expect(ensureWorkstream(db, "auth")).toBe(true);
    expect(ensureWorkstream(db, "auth")).toBe(false);
    const rows = db.prepare("SELECT name FROM workstreams").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["auth"]);
  });

  it("is auto-called by insertAgent (so spawn-without-init still works)", () => {
    insertAgent(db, { name: "worker-1", workstream: "fresh", paneId: "%1", status: "busy" });
    const rows = db.prepare("SELECT name FROM workstreams").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["fresh"]);
  });

  it("is auto-called by addTask (so add-task-without-init still works)", () => {
    addTask(db, {
      localId: "foo",
      workstream: "fresh",
      title: "F",
      impact: 50,
      effortDays: 1,
    });
    const rows = db.prepare("SELECT name FROM workstreams").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(["fresh"]);
  });
});

describe("FK CASCADE: deleting a workstream wipes its agents and tasks", () => {
  it("DELETE FROM workstreams cascades to agents and to tasks (then on to task_edges + task_notes)", () => {
    seedAuth();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n,
    ).toBeGreaterThan(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n,
    ).toBeGreaterThan(0);

    db.prepare("DELETE FROM workstreams WHERE name = 'auth'").run();

    for (const t of ["agents", "tasks", "task_edges", "task_notes"]) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      expect(n).toBe(0);
    }
  });
});

describe("FK SET NULL: closing an agent clears tasks.owner automatically", () => {
  it("deleteAgent clears owner on tasks they owned (historical attribution lives in notes)", () => {
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
    });
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    db.prepare("UPDATE tasks SET owner = 'worker-1' WHERE local_id = 'design'").run();
    expect(
      (
        db.prepare("SELECT owner FROM tasks WHERE local_id = 'design'").get() as {
          owner: string;
        }
      ).owner,
    ).toBe("worker-1");

    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();

    expect(
      (
        db.prepare("SELECT owner FROM tasks WHERE local_id = 'design'").get() as {
          owner: string | null;
        }
      ).owner,
    ).toBeNull();
  });

  it("INSERT INTO tasks ... owner='ghost' is rejected by the FK", () => {
    ensureWorkstream(db, "auth");
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (local_id, workstream, title, status, impact, effort_days, owner, created_at, updated_at)
           VALUES ('x', 'auth', 'X', 'OPEN', 50, 1, 'ghost', datetime('now'), datetime('now'))`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe("summarizeWorkstream", () => {
  it("counts agents, tasks, edges, notes; reports tmux liveness", async () => {
    state.sessions.add("mu-auth");
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();

    const summary = await summarizeWorkstream(db, { workstream: "auth" });
    expect(summary).toEqual({
      workstream: "auth",
      tmuxSession: "mu-auth",
      tmuxAlive: true,
      agents: 2,
      tasks: 3,
      edges: 2,
      notes: 2,
      workspaces: 0,
      registered: true,
    });
  });

  it("returns all-zero counts and tmuxAlive=false for an unknown workstream", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    const summary = await summarizeWorkstream(db, { workstream: "nope" });
    expect(summary.agents).toBe(0);
    expect(summary.tasks).toBe(0);
    expect(summary.edges).toBe(0);
    expect(summary.notes).toBe(0);
    expect(summary.tmuxAlive).toBe(false);
  });

  it("honours tmuxSession override", async () => {
    state.sessions.add("custom");
    setTmuxExecutor(mockTmux(state).executor);
    const summary = await summarizeWorkstream(db, {
      workstream: "auth",
      tmuxSession: "custom",
    });
    expect(summary.tmuxSession).toBe("custom");
    expect(summary.tmuxAlive).toBe(true);
  });
});

// ─── listWorkstreams ─────────────────────────────────────────────────────

describe("listWorkstreams", () => {
  it("returns empty when no DB rows and no mu-* tmux sessions", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    const list = await listWorkstreams(db);
    expect(list).toEqual([]);
  });

  it("unions DB workstreams (agents + tasks) and mu-* tmux sessions", async () => {
    state.sessions.add("mu-auth"); // both DB rows AND tmux session
    state.sessions.add("mu-empty"); // tmux only, no DB rows yet
    state.sessions.add("unrelated"); // not an mu session, ignored
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    insertAgent(db, {
      name: "billing-1",
      workstream: "billing", // DB only, no tmux session
      paneId: "%9",
      status: "busy",
    });

    const list = await listWorkstreams(db);
    expect(list.map((w) => w.workstream)).toEqual(["auth", "billing", "empty"]);

    const auth = list.find((w) => w.workstream === "auth");
    expect(auth?.tmuxAlive).toBe(true);
    expect(auth?.agents).toBe(2);
    expect(auth?.tasks).toBe(3);

    const billing = list.find((w) => w.workstream === "billing");
    expect(billing?.tmuxAlive).toBe(false);
    expect(billing?.agents).toBe(1);
    expect(billing?.tasks).toBe(0);

    const empty = list.find((w) => w.workstream === "empty");
    expect(empty?.tmuxAlive).toBe(true);
    expect(empty?.agents).toBe(0);
    expect(empty?.tasks).toBe(0);
  });

  it("sorts by workstream name", async () => {
    state.sessions.add("mu-zeta");
    state.sessions.add("mu-alpha");
    state.sessions.add("mu-mike");
    setTmuxExecutor(mockTmux(state).executor);
    const list = await listWorkstreams(db);
    expect(list.map((w) => w.workstream)).toEqual(["alpha", "mike", "zeta"]);
  });
});

// ─── destroyWorkstream ─────────────────────────────────────────────────

describe("destroyWorkstream", () => {
  it("kills tmux session and removes every DB row tagged with the workstream", async () => {
    state.sessions.add("mu-auth");
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();

    const result = await destroyWorkstream(db, { workstream: "auth" });
    expect(result).toEqual({
      killedTmux: true,
      deletedAgents: 2,
      deletedTasks: 3,
      deletedNotes: 2,
      deletedEdges: 2,
      freedWorkspaces: 0,
      alreadyGoneWorkspaces: 0,
      failedWorkspaces: [],
    });

    expect(state.killed).toEqual(["mu-auth"]);
    expect(listAgents(db, { workstream: "auth" })).toEqual([]);
    expect(listTasks(db, "auth")).toEqual([]);
    // Cascade emptied the join tables too.
    const noteCount = (db.prepare("SELECT COUNT(*) AS n FROM task_notes").get() as { n: number }).n;
    const edgeCount = (db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n;
    expect(noteCount).toBe(0);
    expect(edgeCount).toBe(0);
  });

  it("leaves other workstreams completely untouched", async () => {
    state.sessions.add("mu-auth");
    state.sessions.add("mu-billing");
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    insertAgent(db, { name: "billing-1", workstream: "billing", paneId: "%9", status: "busy" });
    addTask(db, {
      localId: "invoice",
      workstream: "billing",
      title: "Invoice",
      impact: 50,
      effortDays: 1,
    });
    addNote(db, "invoice", "FILES: src/billing.rs");

    await destroyWorkstream(db, { workstream: "auth" });

    // Billing intact.
    expect(state.sessions.has("mu-billing")).toBe(true);
    expect(listAgents(db, { workstream: "billing" }).map((a) => a.name)).toEqual(["billing-1"]);
    expect(listTasks(db, "billing").map((t) => t.localId)).toEqual(["invoice"]);
    const billingNotes = db
      .prepare("SELECT COUNT(*) AS n FROM task_notes WHERE task_id = 'invoice'")
      .get() as { n: number };
    expect(billingNotes.n).toBe(1);
  });

  it("is idempotent: destroying an unknown workstream is a no-op", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    const result = await destroyWorkstream(db, { workstream: "nope" });
    expect(result).toEqual({
      killedTmux: false,
      deletedAgents: 0,
      deletedTasks: 0,
      deletedNotes: 0,
      deletedEdges: 0,
      freedWorkspaces: 0,
      alreadyGoneWorkspaces: 0,
      failedWorkspaces: [],
    });
  });

  it("succeeds when DB has rows but tmux session is already gone", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth(); // no tmux session for it

    const result = await destroyWorkstream(db, { workstream: "auth" });
    expect(result.killedTmux).toBe(false);
    expect(result.deletedAgents).toBe(2);
    expect(result.deletedTasks).toBe(3);
    expect(state.killed).toEqual([]);
  });

  it("succeeds when tmux session exists but DB has no rows", async () => {
    state.sessions.add("mu-empty");
    setTmuxExecutor(mockTmux(state).executor);

    const result = await destroyWorkstream(db, { workstream: "empty" });
    expect(result).toEqual({
      killedTmux: true,
      deletedAgents: 0,
      deletedTasks: 0,
      deletedNotes: 0,
      deletedEdges: 0,
      freedWorkspaces: 0,
      alreadyGoneWorkspaces: 0,
      failedWorkspaces: [],
    });
    expect(state.killed).toEqual(["mu-empty"]);
  });

  it("repeated destroy is a clean no-op the second time", async () => {
    state.sessions.add("mu-auth");
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();

    await destroyWorkstream(db, { workstream: "auth" });
    const second = await destroyWorkstream(db, { workstream: "auth" });
    expect(second).toEqual({
      killedTmux: false,
      deletedAgents: 0,
      deletedTasks: 0,
      deletedNotes: 0,
      deletedEdges: 0,
      freedWorkspaces: 0,
      alreadyGoneWorkspaces: 0,
      failedWorkspaces: [],
    });
  });

  it("destroys a bare-registry workstream (workstreams row but no agents/tasks)", async () => {
    // Regression for the temp_confirm_a/temp_confirm_b live bug:
    // an empty registered workstream was unreachable by destroy
    // because the cli's nothingToDo short-circuit ignored the
    // workstreams row itself. summarizeWorkstream now returns
    // `registered: true` so the cli can factor it in. At the SDK
    // layer this test pins down that destroyWorkstream itself does
    // delete the bare row.
    setTmuxExecutor(mockTmux(state).executor);
    ensureWorkstream(db, "orphan");
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name='orphan'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);

    await destroyWorkstream(db, { workstream: "orphan" });
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name='orphan'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it("summarize reports `registered: true` for an empty registered workstream", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    ensureWorkstream(db, "orphan");
    const summary = await summarizeWorkstream(db, { workstream: "orphan" });
    expect(summary.registered).toBe(true);
    expect(summary.tmuxAlive).toBe(false);
    expect(summary.agents).toBe(0);
    expect(summary.tasks).toBe(0);
    expect(summary.workspaces).toBe(0);
  });

  it("summarize reports `registered: false` for a tmux-only workstream mu never observed", async () => {
    state.sessions.add("mu-tmuxonly");
    setTmuxExecutor(mockTmux(state).executor);
    const summary = await summarizeWorkstream(db, { workstream: "tmuxonly" });
    expect(summary.registered).toBe(false);
    expect(summary.tmuxAlive).toBe(true);
  });

  // Regression for review_code_destroy_freed_workspaces_double_count:
  // freedWorkspaces was incremented in BOTH the `removed:true` and the
  // `removed:false` (already-gone-on-disk) branches, so the destroy
  // report claimed credit for cleanups it never did. Now the two cases
  // are split: actually-removed paths bump `freedWorkspaces`,
  // already-gone paths bump `alreadyGoneWorkspaces`.
  it("splits freedWorkspaces (real removal) from alreadyGoneWorkspaces (no-op on disk)", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    ensureWorkstream(db, "split");
    insertAgent(db, { name: "alive", workstream: "split", paneId: "%101", status: "free" });
    insertAgent(db, { name: "ghost", workstream: "split", paneId: "%102", status: "free" });

    const presentPath = join(tmpDir, "ws-present");
    const missingPath = join(tmpDir, "ws-missing"); // never created on disk
    mkdirSync(presentPath, { recursive: true });

    // Two registry rows in the same workstream: one whose on-disk
    // path exists (backend will actually remove it), one whose path
    // is already gone (backend free is a no-op). Use `none` because
    // its freeWorkspace is just rmDirSync — no real VCS needed.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO vcs_workspaces (agent, workstream, backend, path, parent_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("alive", "split", noneBackend.name, presentPath, null, now);
    db.prepare(
      `INSERT INTO vcs_workspaces (agent, workstream, backend, path, parent_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("ghost", "split", noneBackend.name, missingPath, null, now);

    const result = await destroyWorkstream(db, { workstream: "split" });

    expect(result.freedWorkspaces).toBe(1);
    expect(result.alreadyGoneWorkspaces).toBe(1);
    expect(result.failedWorkspaces).toEqual([]);
    expect(existsSync(presentPath)).toBe(false);
    expect(existsSync(missingPath)).toBe(false);
  });

  // Regression for review_test_destroy_failed_workspaces_uncovered:
  // every prior destroyWorkstream test asserted `failedWorkspaces: []`,
  // so the failure-accumulation path (the try/catch around
  // backend.freeWorkspace in src/workstream.ts) had zero coverage. A
  // future refactor that dropped the try/catch — turning a single bad
  // worktree into an aborted destroy with half-cleaned state — would
  // pass every existing test. These two cases pin down the v0.2
  // contract: a backend throw is captured into `failedWorkspaces` (not
  // re-raised), the destroy still proceeds, and the FK cascade still
  // wipes the registry rows.
  it("records a backend throw as a failedWorkspaces entry and still completes the destroy", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    ensureWorkstream(db, "fail");
    insertAgent(db, { name: "stuck", workstream: "fail", paneId: "%201", status: "free" });

    // Real-world analogue: `git worktree remove` refuses because of
    // uncommitted changes, or `jj workspace forget` fails on a
    // permission error. We don't need a real VCS to exercise the
    // failure shape — inject a backend whose freeWorkspace just throws.
    const ghostPath = join(tmpDir, "ws-ghost"); // never on disk; doesn't matter
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO vcs_workspaces (agent, workstream, backend, path, parent_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("stuck", "fail", noneBackend.name, ghostPath, null, now);

    const explodingBackend: VcsBackend = {
      ...noneBackend,
      async freeWorkspace() {
        throw new Error("git worktree remove --force refused: uncommitted changes");
      },
    };
    const result = await destroyWorkstream(db, {
      workstream: "fail",
      resolveBackend: () => explodingBackend,
    });

    expect(result.freedWorkspaces).toBe(0);
    expect(result.alreadyGoneWorkspaces).toBe(0);
    expect(result.failedWorkspaces).toEqual([
      {
        agent: "stuck",
        backend: noneBackend.name,
        path: ghostPath,
        error: expect.stringContaining("git worktree remove --force refused"),
      },
    ]);

    // Destroy must NOT have aborted on the throw — the FK CASCADE on
    // workstreams→vcs_workspaces still ran, the registry row is gone,
    // and the agent row is gone. A regression that re-raised would fail
    // these assertions.
    const wsRows = db
      .prepare("SELECT COUNT(*) AS n FROM vcs_workspaces WHERE workstream = 'fail'")
      .get() as { n: number };
    expect(wsRows.n).toBe(0);
    expect(listAgents(db, { workstream: "fail" })).toEqual([]);
    const wsCount = db
      .prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name = 'fail'")
      .get() as { n: number };
    expect(wsCount.n).toBe(0);
  });

  it("partitions mixed success/failure correctly (one freed, one failed)", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    ensureWorkstream(db, "mixed");
    insertAgent(db, { name: "good", workstream: "mixed", paneId: "%301", status: "free" });
    insertAgent(db, { name: "bad", workstream: "mixed", paneId: "%302", status: "free" });

    // Both rows reference the same registered backend name; the
    // injected resolver returns a per-agent backend that either
    // succeeds (delegates to noneBackend.freeWorkspace, which rmDirSync's
    // an existing tempdir) or throws.
    const goodPath = join(tmpDir, "ws-good");
    const badPath = join(tmpDir, "ws-bad");
    mkdirSync(goodPath, { recursive: true });
    mkdirSync(badPath, { recursive: true });

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO vcs_workspaces (agent, workstream, backend, path, parent_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("good", "mixed", noneBackend.name, goodPath, null, now);
    db.prepare(
      `INSERT INTO vcs_workspaces (agent, workstream, backend, path, parent_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("bad", "mixed", noneBackend.name, badPath, null, now);

    const partitioningBackend: VcsBackend = {
      ...noneBackend,
      async freeWorkspace(opts) {
        if (opts.workspacePath === badPath) {
          throw new Error(`mock backend refused to free ${opts.workspacePath}`);
        }
        return noneBackend.freeWorkspace(opts);
      },
    };
    const result = await destroyWorkstream(db, {
      workstream: "mixed",
      resolveBackend: () => partitioningBackend,
    });

    expect(result.freedWorkspaces).toBe(1);
    expect(result.alreadyGoneWorkspaces).toBe(0);
    expect(result.failedWorkspaces).toHaveLength(1);
    expect(result.failedWorkspaces[0]).toEqual({
      agent: "bad",
      backend: noneBackend.name,
      path: badPath,
      error: expect.stringContaining("mock backend refused"),
    });
    // Good path actually rm'd; bad path remains on disk for the user
    // to clean (the WARNING block in cli/workstream.ts directs them).
    expect(existsSync(goodPath)).toBe(false);
    expect(existsSync(badPath)).toBe(true);
  });
});

// ─── Workstream name validation ────────────────────────────────────────

describe("isValidWorkstreamName", () => {
  it("accepts the documented shape (lowercase alpha first; alnum/_/- after; ≤32)", () => {
    for (const ok of ["auth", "auth-refactor", "infer_rs", "x", "a1b2", "a".repeat(32)]) {
      expect(isValidWorkstreamName(ok)).toBe(true);
    }
  });

  it("rejects names tmux silently mangles ('.', ':', '/') — the bug-report regression", () => {
    // The motivating case: `mu workstream init roadmap-v0.2` succeeded
    // but tmux stored the session as `mu-roadmap-v0_2` (dot → underscore),
    // breaking every downstream verb that looked up `mu-roadmap-v0.2`.
    for (const bad of ["roadmap-v0.2", "auth:refactor", "auth/refactor"]) {
      expect(isValidWorkstreamName(bad)).toBe(false);
    }
  });

  it("rejects empty, leading-digit, leading-hyphen, uppercase, and over-long names", () => {
    for (const bad of ["", "1auth", "-auth", "_auth", "Auth", "AUTH", "a".repeat(33)]) {
      expect(isValidWorkstreamName(bad)).toBe(false);
    }
  });

  it("rejects names starting with the reserved 'mu-' prefix (would double-prefix tmux session)", () => {
    // mu auto-prepends 'mu-' to derive the tmux session name. A workstream
    // named 'mu-foo' would create session 'mu-mu-foo' — almost never
    // intended. Fail loud rather than silently double-prefix.
    for (const bad of ["mu-", "mu-foo", "mu-auth-refactor"]) {
      expect(isValidWorkstreamName(bad)).toBe(false);
    }
    // 'mufoo' (no hyphen after 'mu') is fine — only the literal 'mu-'
    // prefix is reserved.
    expect(isValidWorkstreamName("mufoo")).toBe(true);
  });

  it("the mu- error message explains the double-prefix gotcha specifically", () => {
    let caught: WorkstreamNameInvalidError | undefined;
    try {
      ensureWorkstream(db, "mu-auth");
    } catch (err) {
      if (err instanceof WorkstreamNameInvalidError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/mu-mu-auth/);
    expect(caught?.message).toMatch(/double-prefixed/);
  });
});

describe("ensureWorkstream — name validation", () => {
  it("throws WorkstreamNameInvalidError on a tmux-mangled name", () => {
    expect(() => ensureWorkstream(db, "roadmap-v0.2")).toThrow(WorkstreamNameInvalidError);
  });

  it("the thrown error names the offending input and explains why", () => {
    let caught: WorkstreamNameInvalidError | undefined;
    try {
      ensureWorkstream(db, "auth:refactor");
    } catch (err) {
      if (err instanceof WorkstreamNameInvalidError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught?.attempted).toBe("auth:refactor");
    expect(caught?.message).toMatch(/tmux/);
    expect(caught?.message).toMatch(/auth:refactor/);
  });

  it("accepts valid names without changing existing behaviour", () => {
    expect(ensureWorkstream(db, "auth-refactor")).toBe(true);
    expect(ensureWorkstream(db, "auth-refactor")).toBe(false); // idempotent
  });
});

// ─── exportWorkstream ──────────────────────────────────────────────────

import { closeTask, deleteTask } from "../src/tasks.js";
import { exportWorkstream } from "../src/workstream.js";

describe("exportWorkstream", () => {
  function exportFiles(outDir: string): string[] {
    const fs = require("node:fs") as typeof import("node:fs");
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    walk(outDir, "");
    return out.sort();
  }

  it("writes one .md per task plus INDEX.md, README.md, manifest.json", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    const outDir = join(tmpDir, "exp");

    const result = exportWorkstream(db, { workstream: "auth", outDir });

    expect(result.written).toBe(3);
    expect(result.unchanged).toBe(0);
    expect(result.preserved).toBe(0);
    expect(result.manifest.tasks.map((t) => t.id)).toEqual(["build", "design", "ship"]);
    expect(exportFiles(outDir)).toEqual([
      "INDEX.md",
      "README.md",
      "manifest.json",
      "tasks/build.md",
      "tasks/design.md",
      "tasks/ship.md",
    ]);

    const fs = await import("node:fs");
    const designMd = fs.readFileSync(join(outDir, "tasks/design.md"), "utf8");
    expect(designMd).toMatch(/^---\nid: "design"\n/);
    expect(designMd).toMatch(/status: OPEN/);
    expect(designMd).toMatch(/blocks: \["build"\]/);
    expect(designMd).toMatch(/# Design/);
    expect(designMd).toMatch(/### #1 by system,/);
    expect(designMd).toMatch(/DECISION: JWT/);
    // Manifest sha matches the file we just read.
    const sha = require("node:crypto").createHash("sha256").update(designMd, "utf8").digest("hex");
    expect(result.manifest.tasks.find((t) => t.id === "design")?.sha256).toBe(sha);
  });

  it("is idempotent: a second export against an unchanged DB rewrites zero task files", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    const outDir = join(tmpDir, "exp");

    exportWorkstream(db, { workstream: "auth", outDir });
    const fs = await import("node:fs");
    const beforeMtime = fs.statSync(join(outDir, "tasks/design.md")).mtimeMs;
    // Force a measurable mtime gap so an accidental rewrite would
    // surface even on coarse filesystems.
    await new Promise((r) => setTimeout(r, 25));

    const second = exportWorkstream(db, { workstream: "auth", outDir });
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(3);
    expect(second.preserved).toBe(0);
    const afterMtime = fs.statSync(join(outDir, "tasks/design.md")).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it("note append rewrites exactly one task file with the new note section", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    const outDir = join(tmpDir, "exp");
    exportWorkstream(db, { workstream: "auth", outDir });
    addNote(db, "build", "FOLLOWUP: handle edge case");

    const second = exportWorkstream(db, { workstream: "auth", outDir });
    expect(second.written).toBe(1);
    expect(second.unchanged).toBe(2);

    const fs = await import("node:fs");
    const buildMd = fs.readFileSync(join(outDir, "tasks/build.md"), "utf8");
    expect(buildMd).toMatch(/FOLLOWUP: handle edge case/);
    // Other tasks untouched.
    const designMd = fs.readFileSync(join(outDir, "tasks/design.md"), "utf8");
    expect(designMd).not.toMatch(/FOLLOWUP/);
  });

  it("status change rewrites the affected task's frontmatter only", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    const outDir = join(tmpDir, "exp");
    exportWorkstream(db, { workstream: "auth", outDir });
    closeTask(db, "design", { evidence: "shipped" });

    const second = exportWorkstream(db, { workstream: "auth", outDir });
    expect(second.written).toBe(1);
    expect(second.unchanged).toBe(2);

    const fs = await import("node:fs");
    const designMd = fs.readFileSync(join(outDir, "tasks/design.md"), "utf8");
    expect(designMd).toMatch(/status: CLOSED/);
  });

  it("new task added between exports gets a fresh .md", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    const outDir = join(tmpDir, "exp");
    exportWorkstream(db, { workstream: "auth", outDir });
    addTask(db, {
      localId: "deploy",
      workstream: "auth",
      title: "Deploy",
      impact: 70,
      effortDays: 1,
    });

    const second = exportWorkstream(db, { workstream: "auth", outDir });
    expect(second.written).toBe(1);
    expect(second.unchanged).toBe(3);
    expect(second.manifest.tasks.map((t) => t.id)).toEqual(["build", "deploy", "design", "ship"]);
    expect(existsSync(join(outDir, "tasks/deploy.md"))).toBe(true);
  });

  it("deleted task is preserved on disk with a banner; banner is not re-prepended on re-export", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    seedAuth();
    const outDir = join(tmpDir, "exp");
    exportWorkstream(db, { workstream: "auth", outDir });

    // Tear down `ship` (deleteTask cascades; design+build untouched).
    deleteTask(db, "ship");

    const second = exportWorkstream(db, { workstream: "auth", outDir });
    expect(second.preserved).toBe(1);
    const fs = await import("node:fs");
    const shipMd = fs.readFileSync(join(outDir, "tasks/ship.md"), "utf8");
    expect(shipMd).toMatch(/^> \*\*Deleted from DB on /);

    // A third export must NOT prepend a SECOND banner.
    const third = exportWorkstream(db, { workstream: "auth", outDir });
    expect(third.preserved).toBe(1);
    const shipMd2 = fs.readFileSync(join(outDir, "tasks/ship.md"), "utf8");
    const bannerCount = (shipMd2.match(/Deleted from DB on/g) ?? []).length;
    expect(bannerCount).toBe(1);
  });

  it("survives notes containing literal triple-fence content via dynamic fencing", async () => {
    setTmuxExecutor(mockTmux(state).executor);
    addTask(db, {
      localId: "fence",
      workstream: "auth",
      title: "Fence test",
      impact: 50,
      effortDays: 1,
    });
    addNote(db, "fence", "```ts\nconst x = 1;\n```");
    const outDir = join(tmpDir, "exp");
    exportWorkstream(db, { workstream: "auth", outDir });
    const fs = await import("node:fs");
    const md = fs.readFileSync(join(outDir, "tasks/fence.md"), "utf8");
    // Outer fence must be longer than the inner triple-fence to keep
    // it intact for downstream renderers.
    expect(md).toMatch(/````\n```ts\nconst x = 1;\n```\n````/);
  });
});
