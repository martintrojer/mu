// Regression test for bug_v5_name_clash_silent_misroute.
//
// Post-v5 the schema allows the SAME entity name (tasks.local_id,
// agents.name, approvals.slug) to live in two different workstreams
// at once. Before the fix landed, many SDK paths SELECT'd by bare
// name with `LIMIT 1` and silently picked an arbitrary workstream's
// row. The fix threads workstream context through every reachable
// public SDK function so the load-bearing common case
// (two operators each spawning 'worker-1' in different workstreams)
// no longer misroutes.
//
// This file seeds two workstreams (wsa, wsb) with identically-named
// entities and exercises every public SDK function that takes a bare
// name + workstream context. Each assertion checks that the SDK picks
// the RIGHT workstream's row given the resolved context.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAgent,
  deleteAgent,
  freeAgent,
  getAgent,
  insertAgent,
  refreshAgentTitle,
  updateAgentStatus,
} from "../src/agents.js";
import {
  addApproval,
  denyApproval,
  getApproval,
  grantApproval,
  listApprovals,
} from "../src/approvals.js";
import { type Db, openDb } from "../src/db.js";
import {
  addNote,
  addTask,
  claimTask,
  closeTask,
  deferTask,
  deleteTask,
  getTask,
  getTaskEdges,
  listNotes,
  listTasks,
  listTasksByOwner,
  listTasksByOwnerCrossWorkstream,
  openTask,
  rejectTask,
  releaseTask,
  setTaskStatus,
  updateTask,
  waitForTasks,
} from "../src/tasks.js";
import { resetTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-v5-clash-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  resetTmuxExecutor();
  // Two workstreams.
  ensureWorkstream(db, "wsa");
  ensureWorkstream(db, "wsb");
  // Same agent name in both. Use distinct pane ids so the registry
  // INSERT doesn't trip a UNIQUE on pane_id (none exists today, but
  // belt-and-braces).
  insertAgent(db, { name: "worker-1", workstream: "wsa", paneId: "%A1", status: "free" });
  insertAgent(db, { name: "worker-1", workstream: "wsb", paneId: "%B1", status: "free" });
  // Same task local_id in both workstreams. Distinct titles so we can
  // tell them apart on lookup.
  addTask(db, {
    localId: "design",
    workstream: "wsa",
    title: "wsa design",
    impact: 50,
    effortDays: 1,
  });
  addTask(db, {
    localId: "design",
    workstream: "wsb",
    title: "wsb design",
    impact: 50,
    effortDays: 1,
  });
  // Same approval slug in both.
  addApproval(db, {
    slug: "ship-it",
    workstream: "wsa",
    reason: "wsa reason",
    requestedBy: "userA",
  });
  addApproval(db, {
    slug: "ship-it",
    workstream: "wsb",
    reason: "wsb reason",
    requestedBy: "userB",
  });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

describe("v5 name-clash regression: getTask / getAgent / getApproval honour workstream", () => {
  it("getTask(db, id, ws) picks the right workstream's row", () => {
    const a = getTask(db, "design", "wsa");
    const b = getTask(db, "design", "wsb");
    expect(a?.workstreamName).toBe("wsa");
    expect(a?.title).toBe("wsa design");
    expect(b?.workstreamName).toBe("wsb");
    expect(b?.title).toBe("wsb design");
  });

  it("getAgent(db, name, ws) picks the right workstream's row", () => {
    const a = getAgent(db, "worker-1", "wsa");
    const b = getAgent(db, "worker-1", "wsb");
    expect(a?.workstreamName).toBe("wsa");
    expect(a?.paneId).toBe("%A1");
    expect(b?.workstreamName).toBe("wsb");
    expect(b?.paneId).toBe("%B1");
  });

  it("getApproval(db, slug, ws) picks the right workstream's row", () => {
    const a = getApproval(db, "ship-it", "wsa");
    const b = getApproval(db, "ship-it", "wsb");
    expect(a?.workstreamName).toBe("wsa");
    expect(a?.reason).toBe("wsa reason");
    expect(b?.workstreamName).toBe("wsb");
    expect(b?.reason).toBe("wsb reason");
  });

  it("listTasksByOwner(db, ws, name) returns only that workstream's tasks", () => {
    // Claim each workstream's task by its local worker-1.
    return Promise.all([
      claimTask(db, "design", { agentName: "worker-1", workstream: "wsa" }),
      claimTask(db, "design", { agentName: "worker-1", workstream: "wsb" }),
    ]).then(() => {
      const ownedA = listTasksByOwner(db, "wsa", "worker-1");
      const ownedB = listTasksByOwner(db, "wsb", "worker-1");
      expect(ownedA).toHaveLength(1);
      expect(ownedA[0]?.workstreamName).toBe("wsa");
      expect(ownedB).toHaveLength(1);
      expect(ownedB[0]?.workstreamName).toBe("wsb");
      // The cross-workstream variant returns BOTH workstreams' tasks.
      const all = listTasksByOwnerCrossWorkstream(db, "worker-1");
      expect(all).toHaveLength(2);
      expect(all.map((t) => t.workstreamName).sort()).toEqual(["wsa", "wsb"]);
    });
  });
});

describe("v5 name-clash regression: claimTask / releaseTask scope correctly", () => {
  it("claimTask(workstream=wsa) targets wsa's task even though wsb's exists", async () => {
    const r = await claimTask(db, "design", { agentName: "worker-1", workstream: "wsa" });
    expect(r.ownerName).toBe("worker-1");
    // wsa's task should now be IN_PROGRESS owned by wsa's worker-1;
    // wsb's task untouched.
    expect(getTask(db, "design", "wsa")?.status).toBe("IN_PROGRESS");
    expect(getTask(db, "design", "wsa")?.ownerName).toBe("worker-1");
    expect(getTask(db, "design", "wsb")?.status).toBe("OPEN");
    expect(getTask(db, "design", "wsb")?.ownerName).toBeNull();
  });

  it("claimTask(workstream=wsb) targets wsb's task", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "wsb" });
    expect(getTask(db, "design", "wsa")?.status).toBe("OPEN");
    expect(getTask(db, "design", "wsb")?.status).toBe("IN_PROGRESS");
  });

  it("releaseTask scopes by workstream", async () => {
    await claimTask(db, "design", { agentName: "worker-1", workstream: "wsa" });
    await claimTask(db, "design", { agentName: "worker-1", workstream: "wsb" });
    // Release wsa's only.
    releaseTask(db, "design", { workstream: "wsa" });
    expect(getTask(db, "design", "wsa")?.ownerName).toBeNull();
    // wsb's still owned.
    expect(getTask(db, "design", "wsb")?.ownerName).toBe("worker-1");
  });
});

describe("v5 name-clash regression: lifecycle verbs scope correctly", () => {
  it("setTaskStatus({ workstream }) only flips the right row", () => {
    setTaskStatus(db, "design", "CLOSED", { workstream: "wsa" });
    expect(getTask(db, "design", "wsa")?.status).toBe("CLOSED");
    expect(getTask(db, "design", "wsb")?.status).toBe("OPEN");
  });

  it("closeTask({ workstream }) scopes correctly", () => {
    closeTask(db, "design", { workstream: "wsb" });
    expect(getTask(db, "design", "wsa")?.status).toBe("OPEN");
    expect(getTask(db, "design", "wsb")?.status).toBe("CLOSED");
  });

  it("openTask({ workstream }) scopes correctly", () => {
    setTaskStatus(db, "design", "CLOSED", { workstream: "wsa" });
    openTask(db, "design", { workstream: "wsa" });
    expect(getTask(db, "design", "wsa")?.status).toBe("OPEN");
    // wsb never touched.
    expect(getTask(db, "design", "wsb")?.status).toBe("OPEN");
  });

  it("rejectTask({ workstream }) scopes correctly", () => {
    rejectTask(db, "design", { workstream: "wsa" });
    expect(getTask(db, "design", "wsa")?.status).toBe("REJECTED");
    expect(getTask(db, "design", "wsb")?.status).toBe("OPEN");
  });

  it("deferTask({ workstream }) scopes correctly", () => {
    deferTask(db, "design", { workstream: "wsb" });
    expect(getTask(db, "design", "wsa")?.status).toBe("OPEN");
    expect(getTask(db, "design", "wsb")?.status).toBe("DEFERRED");
  });
});

describe("v5 name-clash regression: edit verbs scope correctly", () => {
  it("addNote({ workstream }) attaches to the right task", () => {
    addNote(db, "design", "wsa note", { author: "tester", workstream: "wsa" });
    addNote(db, "design", "wsb note", { author: "tester", workstream: "wsb" });
    const notesA = listNotes(db, "design", "wsa");
    const notesB = listNotes(db, "design", "wsb");
    expect(notesA.map((n) => n.content)).toEqual(["wsa note"]);
    expect(notesB.map((n) => n.content)).toEqual(["wsb note"]);
  });

  it("updateTask({ workstream }) only mutates the right row", () => {
    updateTask(db, "design", { title: "renamed wsa" }, { workstream: "wsa" });
    expect(getTask(db, "design", "wsa")?.title).toBe("renamed wsa");
    expect(getTask(db, "design", "wsb")?.title).toBe("wsb design");
  });

  it("deleteTask({ workstream }) only deletes the right row", () => {
    deleteTask(db, "design", "wsa");
    expect(getTask(db, "design", "wsa")).toBeUndefined();
    expect(getTask(db, "design", "wsb")?.workstreamName).toBe("wsb");
  });

  it("getTaskEdges({ workstream }) returns the right edges", () => {
    // Create a blocker in wsa only and check edges resolve in wsa but not
    // wsb.
    addTask(db, {
      localId: "blocker",
      workstream: "wsa",
      title: "wsa blocker",
      impact: 10,
      effortDays: 1,
      blockedBy: [],
    });
    addTask(db, {
      localId: "dep",
      workstream: "wsa",
      title: "wsa dependent",
      impact: 10,
      effortDays: 1,
      blockedBy: ["blocker"],
    });
    const edgesA = getTaskEdges(db, "dep", "wsa");
    expect(edgesA.blockers).toEqual(["blocker"]);
    // wsb has no 'dep' task.
    const edgesB = getTaskEdges(db, "dep", "wsb");
    expect(edgesB.blockers).toEqual([]);
    expect(edgesB.dependents).toEqual([]);
  });
});

describe("v5 name-clash regression: agent verbs scope correctly", () => {
  it("updateAgentStatus({ workstream }) only mutates the right row", () => {
    updateAgentStatus(db, "worker-1", "busy", "wsa");
    expect(getAgent(db, "worker-1", "wsa")?.status).toBe("busy");
    expect(getAgent(db, "worker-1", "wsb")?.status).toBe("free");
  });

  it("freeAgent({ workstream }) only mutates the right row", () => {
    updateAgentStatus(db, "worker-1", "busy", "wsa");
    updateAgentStatus(db, "worker-1", "busy", "wsb");
    freeAgent(db, "worker-1", "wsa");
    expect(getAgent(db, "worker-1", "wsa")?.status).toBe("free");
    expect(getAgent(db, "worker-1", "wsb")?.status).toBe("busy");
  });

  it("deleteAgent({ workstream }) only deletes the right row", () => {
    deleteAgent(db, "worker-1", "wsa");
    expect(getAgent(db, "worker-1", "wsa")).toBeUndefined();
    expect(getAgent(db, "worker-1", "wsb")?.workstreamName).toBe("wsb");
  });

  it("closeAgent({ workstream }) only closes the right row", async () => {
    await closeAgent(db, "worker-1", { workstream: "wsa" });
    expect(getAgent(db, "worker-1", "wsa")).toBeUndefined();
    expect(getAgent(db, "worker-1", "wsb")?.workstreamName).toBe("wsb");
  });

  it("refreshAgentTitle({ workstream }) doesn't touch the wrong row", async () => {
    // Best-effort title refresh shouldn't throw or mutate the wrong row;
    // we just call it and confirm both registry rows are intact.
    await refreshAgentTitle(db, "worker-1", "wsa");
    await refreshAgentTitle(db, "worker-1", "wsb");
    expect(getAgent(db, "worker-1", "wsa")?.workstreamName).toBe("wsa");
    expect(getAgent(db, "worker-1", "wsb")?.workstreamName).toBe("wsb");
  });
});

describe("v5 name-clash regression: approval verbs scope correctly", () => {
  it("grantApproval({ workstream }) only grants the right row", () => {
    grantApproval(db, "ship-it", { decidedBy: "user", workstream: "wsa" });
    expect(getApproval(db, "ship-it", "wsa")?.status).toBe("granted");
    expect(getApproval(db, "ship-it", "wsb")?.status).toBe("pending");
  });

  it("denyApproval({ workstream }) only denies the right row", () => {
    denyApproval(db, "ship-it", { decidedBy: "user", workstream: "wsb" });
    expect(getApproval(db, "ship-it", "wsa")?.status).toBe("pending");
    expect(getApproval(db, "ship-it", "wsb")?.status).toBe("denied");
  });

  it("listApprovals({ workstream }) only returns that workstream's approvals", () => {
    expect(listApprovals(db, { workstream: "wsa" })).toHaveLength(1);
    expect(listApprovals(db, { workstream: "wsb" })).toHaveLength(1);
  });
});

describe("v5 name-clash regression: read verbs scope correctly", () => {
  it("listTasks({ workstream }) only returns that workstream's tasks", () => {
    expect(listTasks(db, "wsa").map((t) => t.workstreamName)).toEqual(["wsa"]);
    expect(listTasks(db, "wsb").map((t) => t.workstreamName)).toEqual(["wsb"]);
  });

  it("waitForTasks({ workstream }) only waits on that workstream's task", async () => {
    // Close wsa's task; wsb's left OPEN. With workstream=wsa the SDK
    // should consider the wait satisfied (wsa's design is CLOSED) even
    // though wsb's design with the same local_id is still OPEN.
    closeTask(db, "design", { workstream: "wsa" });
    const r = await waitForTasks(db, ["design"], {
      workstream: "wsa",
      timeoutMs: 100,
      pollMs: 10,
    });
    expect(r.allReached).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.tasks[0]?.status).toBe("CLOSED");
    // And the same wait targeting wsb times out (wsb's design still
    // OPEN).
    const r2 = await waitForTasks(db, ["design"], {
      workstream: "wsb",
      timeoutMs: 80,
      pollMs: 10,
    });
    expect(r2.timedOut).toBe(true);
    expect(r2.tasks[0]?.status).toBe("OPEN");
  });
});
