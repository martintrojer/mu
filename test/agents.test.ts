// Tests for src/agents.ts CRUD primitives. Uses a real SQLite temp DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
