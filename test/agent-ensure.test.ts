// Fast-tier unit tests for ensureAgent — idempotent spawn-or-reuse
// backing `mu agent ensure`. Missing agent spawns with spawnAgent;
// existing prompt/free agents are reused; --idle-only turns active
// statuses into a typed conflict for watcher concurrency locks.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentBusyError,
  ensureAgent,
  getAgent,
  spawnAgent,
  updateAgentStatus,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { type MockState, freshMockState, mockTmux } from "./_verbs-mock.js";

describe("ensureAgent", () => {
  let dir: string;
  let db: Db;
  let mock: MockState;
  const ws = "scratch";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-agentensure-"));
    db = openDb({ path: join(dir, "mu.db") });
    mock = freshMockState();
    setTmuxExecutor(mockTmux(mock).executor);
    setSleepForTests(async () => {});
    process.env.MU_SPAWN_LIVENESS_MS = "0";
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

  it("spawns the agent when it does not exist", async () => {
    const result = await ensureAgent(db, { name: "watcher-1", workstream: ws, cli: "sh" });

    expect(result.changed).toBe(true);
    expect(result.created).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.busy).toBe(false);
    expect(result.existed).toBe(false);
    expect(result.previousStatus).toBeNull();
    expect(result.agent.name).toBe("watcher-1");
    expect(getAgent(db, "watcher-1", ws)?.paneId).toBe(result.agent.paneId);
  });

  it("reuses an existing needs_input agent without spawning another pane", async () => {
    const spawned = await spawnAgent(db, { name: "watcher-1", workstream: ws, cli: "sh" });
    updateAgentStatus(db, "watcher-1", "needs_input", ws);
    const paneCount = mock.panes.size;

    const result = await ensureAgent(db, { name: "watcher-1", workstream: ws, cli: "sh" });

    expect(result.changed).toBe(false);
    expect(result.created).toBe(false);
    expect(result.reused).toBe(true);
    expect(result.busy).toBe(false);
    expect(result.existed).toBe(true);
    expect(result.previousStatus).toBe("needs_input");
    expect(result.agent.paneId).toBe(spawned.paneId);
    expect(mock.panes.size).toBe(paneCount);
  });

  it("reuses an existing busy agent by default without mutation", async () => {
    await spawnAgent(db, { name: "fixer-1", workstream: ws, cli: "sh" });
    updateAgentStatus(db, "fixer-1", "busy", ws);
    const paneCount = mock.panes.size;

    const result = await ensureAgent(db, { name: "fixer-1", workstream: ws, cli: "sh" });

    expect(result.changed).toBe(false);
    expect(result.created).toBe(false);
    expect(result.reused).toBe(true);
    expect(result.busy).toBe(true);
    expect(result.previousStatus).toBe("busy");
    expect(getAgent(db, "fixer-1", ws)?.status).toBe("busy");
    expect(mock.panes.size).toBe(paneCount);
  });

  it("respawns when the existing agent's pane has died (ghost row)", async () => {
    const spawned = await spawnAgent(db, { name: "watcher-1", workstream: ws, cli: "sh" });
    updateAgentStatus(db, "watcher-1", "needs_input", ws);
    // Simulate a crashed pane: drop it from the mock tmux session while the
    // DB row lingers (no reconcile has pruned the ghost yet).
    mock.panes.delete(spawned.paneId);

    const result = await ensureAgent(db, { name: "watcher-1", workstream: ws, cli: "sh" });

    expect(result.created).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.existed).toBe(false);
    // A fresh pane replaced the dead one.
    expect(result.agent.paneId).not.toBe(spawned.paneId);
    expect(getAgent(db, "watcher-1", ws)?.paneId).toBe(result.agent.paneId);
  });

  it("throws AgentBusyError for an existing busy agent with idleOnly", async () => {
    await spawnAgent(db, { name: "fixer-1", workstream: ws, cli: "sh" });
    updateAgentStatus(db, "fixer-1", "busy", ws);

    await expect(
      ensureAgent(db, { name: "fixer-1", workstream: ws, cli: "sh", idleOnly: true }),
    ).rejects.toBeInstanceOf(AgentBusyError);
  });

  it("treats needs_permission as busy for idleOnly", async () => {
    await spawnAgent(db, { name: "fixer-1", workstream: ws, cli: "sh" });
    updateAgentStatus(db, "fixer-1", "needs_permission", ws);

    await expect(
      ensureAgent(db, { name: "fixer-1", workstream: ws, cli: "sh", idleOnly: true }),
    ).rejects.toMatchObject({ name: "AgentBusyError" });
  });
});
