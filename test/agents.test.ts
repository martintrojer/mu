// Tests for src/agents.ts CRUD primitives. Uses a real SQLite temp DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STATUS_EMOJI,
  composeAgentTitle,
  deleteAgent,
  getAgent,
  getAgentByPane,
  insertAgent,
  listAgents,
  updateAgentStatus,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import { addTask, claimTask, getTask, listNotes } from "../src/tasks.js";

describe("agents CRUD", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-agents-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── insertAgent ────────────────────────────────────────────────────

  it("insertAgent stores all required fields and returns the row", () => {
    const row = insertAgent(db, {
      name: "alice",
      workstream: "auth",
      paneId: "%15",
      status: "spawning",
    });
    expect(row).toMatchObject({
      name: "alice",
      workstream: "auth",
      paneId: "%15",
      status: "spawning",
      cli: "pi", // default
      role: "full-access", // default
      tab: null,
    });
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("insertAgent accepts explicit cli, role, tab", () => {
    const row = insertAgent(db, {
      name: "revv",
      workstream: "review",
      paneId: "%20",
      status: "busy",
      cli: "claude",
      role: "read-only",
      tab: "Review",
    });
    expect(row.cli).toBe("claude");
    expect(row.role).toBe("read-only");
    expect(row.tab).toBe("Review");
  });

  it("insertAgent rejects duplicate name (PRIMARY KEY)", () => {
    insertAgent(db, { name: "alice", workstream: "a", paneId: "%1", status: "busy" });
    expect(() =>
      insertAgent(db, { name: "alice", workstream: "b", paneId: "%2", status: "busy" }),
    ).toThrow();
  });

  // ─── getAgent ───────────────────────────────────────────────────────

  it("getAgent returns undefined for unknown name", () => {
    expect(getAgent(db, "ghost")).toBeUndefined();
  });

  it("getAgent round-trips inserted data", () => {
    insertAgent(db, {
      name: "alice",
      workstream: "auth",
      paneId: "%15",
      status: "needs_input",
      tab: "Backend",
    });
    expect(getAgent(db, "alice")).toMatchObject({
      name: "alice",
      workstream: "auth",
      paneId: "%15",
      status: "needs_input",
      tab: "Backend",
    });
  });

  // ─── listAgents ─────────────────────────────────────────────────────

  it("listAgents (no filter) returns all agents ordered by workstream then name", () => {
    insertAgent(db, { name: "bob", workstream: "auth", paneId: "%2", status: "busy" });
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "carol", workstream: "billing", paneId: "%3", status: "busy" });
    const rows = listAgents(db);
    expect(rows.map((r) => r.name)).toEqual(["alice", "bob", "carol"]);
  });

  it("listAgents (with workstream filter) returns only that workstream", () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "bob", workstream: "auth", paneId: "%2", status: "busy" });
    insertAgent(db, { name: "carol", workstream: "billing", paneId: "%3", status: "busy" });
    const rows = listAgents(db, { workstream: "auth" });
    expect(rows.map((r) => r.name)).toEqual(["alice", "bob"]);
  });

  it("listAgents on empty DB returns empty array", () => {
    expect(listAgents(db)).toEqual([]);
  });

  // ─── updateAgentStatus ──────────────────────────────────────────────

  it("updateAgentStatus changes status and bumps updated_at", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1", status: "spawning" });
    const before = getAgent(db, "alice");
    if (!before) throw new Error("setup failed");
    // Sleep 5ms so updated_at can differ.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(updateAgentStatus(db, "alice", "busy")).toBe(true);
    const after = getAgent(db, "alice");
    expect(after?.status).toBe("busy");
    expect(after?.updatedAt).not.toBe(before.updatedAt);
    // created_at must NOT change.
    expect(after?.createdAt).toBe(before.createdAt);
  });

  it("updateAgentStatus returns false when no row matches", () => {
    expect(updateAgentStatus(db, "ghost", "busy")).toBe(false);
  });

  it("updateAgentStatus rejects an unknown status via the schema CHECK", () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1", status: "busy" });
    // The schema CHECK enforces the AgentStatus enum at the SQLite layer.
    // Catches `mu sql` typos that bypass the TS type system.
    expect(() => updateAgentStatus(db, "alice", "bogus" as never)).toThrow(
      /CHECK constraint failed/,
    );
    expect(getAgent(db, "alice")?.status).toBe("busy");
  });

  it("insertAgent rejects an unknown status via the schema CHECK", () => {
    expect(() =>
      insertAgent(db, {
        name: "alice",
        workstream: "auth",
        paneId: "%1",
        status: "bogus" as never,
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it("insertAgent rejects an unknown role via the schema CHECK", () => {
    expect(() =>
      insertAgent(db, {
        name: "alice",
        workstream: "auth",
        paneId: "%1",
        status: "busy",
        role: "superadmin",
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  // ─── deleteAgent ────────────────────────────────────────────────────

  it("deleteAgent removes the row and returns true", () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1", status: "busy" });
    expect(deleteAgent(db, "alice")).toBe(true);
    expect(getAgent(db, "alice")).toBeUndefined();
  });

  it("deleteAgent on missing row returns false (idempotent)", () => {
    expect(deleteAgent(db, "ghost")).toBe(false);
  });

  it("deleteAgent does not affect other workstreams", () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "carol", workstream: "billing", paneId: "%2", status: "busy" });
    deleteAgent(db, "alice");
    expect(listAgents(db).map((r) => r.name)).toEqual(["carol"]);
  });

  // ─── getAgentByPane ───────────────────────────────────────

  it("getAgentByPane returns the agent owning a given pane id", () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%7", status: "busy" });
    expect(getAgentByPane(db, "%7")?.name).toBe("alice");
  });

  it("getAgentByPane returns undefined for an unknown pane", () => {
    expect(getAgentByPane(db, "%99")).toBeUndefined();
  });

  it("getAgentByPane round-trips the same shape as getAgent", () => {
    insertAgent(db, {
      name: "alice",
      workstream: "auth",
      paneId: "%7",
      status: "busy",
      cli: "claude",
      role: "read-only",
      tab: "Review",
    });
    expect(getAgentByPane(db, "%7")).toEqual(getAgent(db, "alice"));
  });

  // ─── deleteAgent reaper ──────────────────────────────────────

  it("deleteAgent reaps stuck IN_PROGRESS tasks back to OPEN", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "Design auth",
      impact: 80,
      effortDays: 2,
    });
    await claimTask(db, "design", { agentName: "worker-1" });
    expect(getTask(db, "design")?.status).toBe("IN_PROGRESS");
    expect(getTask(db, "design")?.owner).toBe("worker-1");

    deleteAgent(db, "worker-1");

    const after = getTask(db, "design");
    expect(after?.status).toBe("OPEN");
    expect(after?.owner).toBeNull();
  });

  it("deleteAgent reaper appends a [reaper] task_note explaining the revert", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "design", { agentName: "worker-1" });
    deleteAgent(db, "worker-1");

    const notes = listNotes(db, "design");
    const reaperNote = notes.find((n) => n.author === "reaper");
    expect(reaperNote).toBeDefined();
    expect(reaperNote?.content).toContain("previous owner worker-1");
    expect(reaperNote?.content).toContain("IN_PROGRESS → OPEN");
  });

  it("deleteAgent reaper emits a `task reap` event in agent_logs", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    addTask(db, {
      localId: "design",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "design", { agentName: "worker-1" });
    deleteAgent(db, "worker-1");

    const reapEvents = listLogs(db, { kind: "event" }).filter((r) =>
      r.payload.startsWith("task reap design"),
    );
    expect(reapEvents).toHaveLength(1);
    expect(reapEvents[0]?.payload).toContain("previous owner worker-1");
  });

  it("deleteAgent does NOT reap tasks the agent didn't own", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "worker-2", workstream: "auth", paneId: "%2", status: "busy" });
    addTask(db, {
      localId: "a",
      workstream: "auth",
      title: "A",
      impact: 50,
      effortDays: 1,
    });
    addTask(db, {
      localId: "b",
      workstream: "auth",
      title: "B",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "a", { agentName: "worker-1" });
    await claimTask(db, "b", { agentName: "worker-2" });

    deleteAgent(db, "worker-1");

    expect(getTask(db, "a")?.status).toBe("OPEN");
    expect(getTask(db, "b")?.status).toBe("IN_PROGRESS");
    expect(getTask(db, "b")?.owner).toBe("worker-2");
  });

  it("deleteAgent does NOT reap CLOSED tasks (only IN_PROGRESS)", async () => {
    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    addTask(db, {
      localId: "done",
      workstream: "auth",
      title: "D",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "done", { agentName: "worker-1" });
    db.prepare("UPDATE tasks SET status = 'CLOSED' WHERE local_id = 'done'").run();

    deleteAgent(db, "worker-1");

    // Task stays CLOSED; only owner (which gets cleared via FK SET NULL).
    expect(getTask(db, "done")?.status).toBe("CLOSED");
    expect(getTask(db, "done")?.owner).toBeNull();
  });
});

// ─── composeAgentTitle (mu's interpreted state on the pane border) ───

describe("composeAgentTitle", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-title-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("renders just the agent name when status is 'spawning' (initial state)", () => {
    insertAgent(db, { name: "worker-a", workstream: "ws", paneId: "%1", status: "spawning" });
    const a = getAgent(db, "worker-a");
    if (!a) throw new Error("agent missing");
    expect(composeAgentTitle(db, a)).toBe("worker-a");
  });

  it("renders 'name · emoji' when status is busy / needs_input / etc and no claim", () => {
    insertAgent(db, { name: "worker-a", workstream: "ws", paneId: "%1", status: "busy" });
    let a = getAgent(db, "worker-a");
    if (!a) throw new Error();
    expect(composeAgentTitle(db, a)).toBe(`worker-a · ${STATUS_EMOJI.busy}`);

    updateAgentStatus(db, "worker-a", "needs_input");
    a = getAgent(db, "worker-a");
    if (!a) throw new Error();
    expect(composeAgentTitle(db, a)).toBe(`worker-a · ${STATUS_EMOJI.needs_input}`);

    updateAgentStatus(db, "worker-a", "free");
    a = getAgent(db, "worker-a");
    if (!a) throw new Error();
    expect(composeAgentTitle(db, a)).toBe(`worker-a · ${STATUS_EMOJI.free}`);
  });

  // Drift guard: pin every STATUS_EMOJI codepoint into composeAgentTitle
  // so any one-codepoint change (e.g. swapping unreachable's glyph) fails
  // loud. 'spawning' is intentionally undecorated (see composeAgentTitle
  // comment) so we assert the bare-name shape for it instead.
  it("interpolates STATUS_EMOJI for every status (and skips it for 'spawning')", () => {
    for (const status of Object.keys(STATUS_EMOJI) as (keyof typeof STATUS_EMOJI)[]) {
      insertAgent(db, {
        name: `w_${status}`,
        workstream: "ws",
        paneId: `%${status}`,
        status,
      });
      const a = getAgent(db, `w_${status}`);
      if (!a) throw new Error();
      const expected =
        status === "spawning" ? `w_${status}` : `w_${status} · ${STATUS_EMOJI[status]}`;
      expect(composeAgentTitle(db, a), `status=${status}`).toBe(expected);
    }
  });

  it("appends task id when agent owns one task", () => {
    insertAgent(db, { name: "worker-a", workstream: "ws", paneId: "%1", status: "busy" });
    addTask(db, { localId: "build_x", workstream: "ws", title: "X", impact: 50, effortDays: 1 });
    db.prepare("UPDATE tasks SET owner='worker-a' WHERE local_id='build_x'").run();
    const a = getAgent(db, "worker-a");
    if (!a) throw new Error();
    expect(composeAgentTitle(db, a)).toBe(`worker-a · ${STATUS_EMOJI.busy} · build_x`);
  });

  it("compresses to '⊕N tasks' when agent owns multiple tasks", () => {
    insertAgent(db, { name: "worker-a", workstream: "ws", paneId: "%1", status: "busy" });
    for (const id of ["t_a", "t_b", "t_c"]) {
      addTask(db, { localId: id, workstream: "ws", title: id, impact: 50, effortDays: 1 });
      db.prepare("UPDATE tasks SET owner='worker-a' WHERE local_id=?").run(id);
    }
    const a = getAgent(db, "worker-a");
    if (!a) throw new Error();
    expect(composeAgentTitle(db, a)).toBe(`worker-a · ${STATUS_EMOJI.busy} · ⊕3 tasks`);
  });

  it("excludes CLOSED / REJECTED / DEFERRED tasks from the count (live work view)", () => {
    insertAgent(db, { name: "worker-a", workstream: "ws", paneId: "%1", status: "busy" });
    for (const id of ["live", "shipped", "wontdo"]) {
      addTask(db, { localId: id, workstream: "ws", title: id, impact: 50, effortDays: 1 });
      db.prepare("UPDATE tasks SET owner='worker-a' WHERE local_id=?").run(id);
    }
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='shipped'").run();
    db.prepare("UPDATE tasks SET status='REJECTED' WHERE local_id='wontdo'").run();
    const a = getAgent(db, "worker-a");
    if (!a) throw new Error();
    // Only 'live' is OPEN+owned → single-task form, not ⊕N.
    expect(composeAgentTitle(db, a)).toBe(`worker-a · ${STATUS_EMOJI.busy} · live`);
  });

  it("truncates titles longer than 64 chars with '…'", () => {
    const longName = "agent_with_a_very_long_name_that_pushes_us_over";
    insertAgent(db, { name: longName, workstream: "ws", paneId: "%1", status: "busy" });
    addTask(db, {
      localId: "task_with_an_unusually_long_id_too",
      workstream: "ws",
      title: "X",
      impact: 50,
      effortDays: 1,
    });
    db.prepare("UPDATE tasks SET owner=? WHERE local_id='task_with_an_unusually_long_id_too'").run(
      longName,
    );
    const a = getAgent(db, longName);
    if (!a) throw new Error();
    const title = composeAgentTitle(db, a);
    expect(title.length).toBeLessThanOrEqual(64);
    expect(title.endsWith("…")).toBe(true);
    // Agent name (canonical identity) MUST remain intact at the start
    // so the claim-protocol parser keeps working.
    expect(title.startsWith(longName)).toBe(true);
  });
});
