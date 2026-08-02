// Fast-tier unit tests for pollAgents — the non-blocking, read-only
// snapshot of all agents in a workstream (the dual of waitForAgents /
// `mu agent wait`). Each agent reports {name,status,idleMs,
// lastActivitySeq,workspaceBehind,dead}. See src/agents.ts pollAgents.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pollAgents, spawnAgent, updateAgentStatus } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { appendLog } from "../src/logs.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

describe("pollAgents", () => {
  let dir: string;
  let db: Db;
  let mock: MockState;
  const ws = "scratch";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mu-agentpoll-"));
    db = openDb({ path: join(dir, "mu.db") });
    mock = freshMockState();
    setTmuxExecutor(mockTmux(mock).executor);
    setSleepForTests(async () => {});
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    await spawnAgent(db, { name: "worker-1", workstream: ws, cli: "sh" });
    await spawnAgent(db, { name: "worker-2", workstream: ws, cli: "sh" });
  });

  afterEach(() => {
    const key = "MU_SPAWN_LIVENESS_MS";
    delete process.env[key];
    resetSleep();
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns one snapshot per agent in {items,count} shape", async () => {
    const view = await pollAgents(db, { workstream: ws });
    expect(view.count).toBe(2);
    expect(view.items.map((i) => i.name).sort()).toEqual(["worker-1", "worker-2"]);
    for (const item of view.items) {
      expect(typeof item.status).toBe("string");
      expect(item.idleMs).toBeGreaterThanOrEqual(0);
      expect(item.lastActivitySeq).toBe(0);
      expect(item.workspaceBehind).toBeNull();
      expect(item.dead).toBe(false);
    }
  });

  it("returns an empty view for a workstream with no agents", async () => {
    const view = await pollAgents(db, { workstream: "nonexistent" });
    expect(view).toEqual({ items: [], count: 0 });
  });

  it("reflects the persisted runtime status", async () => {
    updateAgentStatus(db, "worker-1", "needs_input", ws);
    const view = await pollAgents(db, { workstream: ws });
    const w1 = view.items.find((i) => i.name === "worker-1");
    expect(w1?.status).toBe("needs_input");
  });

  it("tracks lastActivitySeq from agent-sourced log entries", async () => {
    appendLog(db, { workstream: ws, source: "worker-1", kind: "message", payload: "a" });
    const second = appendLog(db, {
      workstream: ws,
      source: "worker-1",
      kind: "message",
      payload: "b",
    });
    // An entry from a different source must not bleed into worker-1.
    appendLog(db, { workstream: ws, source: "worker-2", kind: "message", payload: "c" });

    const view = await pollAgents(db, { workstream: ws });
    const w1 = view.items.find((i) => i.name === "worker-1");
    const w2 = view.items.find((i) => i.name === "worker-2");
    expect(w1?.lastActivitySeq).toBe(second.seq);
    expect(w2?.lastActivitySeq).toBeGreaterThan(0);
    expect(w2?.lastActivitySeq).not.toBe(second.seq);
  });

  it("flags an agent dead when its pane is gone from the session", async () => {
    // Drop worker-2's pane from the mock tmux session to simulate a
    // crashed / killed pane that the next reconcile would prune.
    const agentPaneIds = [...mock.panes.values()].map((p) => p.paneId);
    // worker-2 was the second spawn; remove the last pane.
    const lastPane = agentPaneIds[agentPaneIds.length - 1];
    if (lastPane) mock.panes.delete(lastPane);

    const view = await pollAgents(db, { workstream: ws });
    const dead = view.items.filter((i) => i.dead);
    expect(dead.length).toBe(1);
    expect(dead[0]?.name).toBe("worker-2");
  });

  it("does NOT mutate the DB (read-only): status survives unchanged", async () => {
    updateAgentStatus(db, "worker-1", "busy", ws);
    await pollAgents(db, { workstream: ws });
    const view = await pollAgents(db, { workstream: ws });
    expect(view.items.find((i) => i.name === "worker-1")?.status).toBe("busy");
  });
});
