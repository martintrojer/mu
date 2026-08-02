// Fast-tier unit tests for reapIdleAgents — the one-line graveyard
// cleanup that sweeps a workstream and closes finished, idle, SAFE
// helpers (the scratch `fixer-N` pile-up). See src/agents.ts
// reapIdleAgents.
//
// Sweep predicate:
//   status in {needs_input, needs_permission, free}  (NOT busy/spawning)
//   AND (now - updated_at) >= idleForMs
//   AND workspace clean (unless --discard-dirty)
//
// We back-date agents.updated_at directly (the only column the idle
// predicate reads) rather than injecting a clock seam, mirroring
// test/agent-idle.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, reapIdleAgents, spawnAgent, updateAgentStatus } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

/** Back-date an agent's updated_at by `ageMs` so the idle predicate fires
 *  without waiting wall-clock time. */
function ageAgent(db: Db, name: string, ageMs: number): void {
  const past = new Date(Date.now() - ageMs).toISOString();
  db.prepare("UPDATE agents SET updated_at = ? WHERE name = ?").run(past, name);
}

describe("reapIdleAgents", () => {
  let dir: string;
  let db: Db;
  let mock: MockState;
  const ws = "scratch";

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mu-reapidle-"));
    db = openDb({ path: join(dir, "mu.db") });
    mock = freshMockState();
    setTmuxExecutor(mockTmux(mock).executor);
    setSleepForTests(async () => {});
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    const key = "MU_IDLE_THRESHOLD_MS";
    delete process.env[key];
    await spawnAgent(db, { name: "fixer-1", workstream: ws, cli: "sh" });
    await spawnAgent(db, { name: "fixer-2", workstream: ws, cli: "sh" });
  });

  afterEach(() => {
    for (const key of ["MU_SPAWN_LIVENESS_MS", "MU_IDLE_THRESHOLD_MS"]) {
      delete process.env[key];
    }
    resetSleep();
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("closes finished agents idle past --idle-for and returns {items,count}", async () => {
    updateAgentStatus(db, "fixer-1", "needs_input", ws);
    updateAgentStatus(db, "fixer-2", "needs_input", ws);
    ageAgent(db, "fixer-1", 10 * 60_000);
    ageAgent(db, "fixer-2", 10 * 60_000);

    const view = await reapIdleAgents(db, { workstream: ws, idleForMs: 5 * 60_000 });
    expect(view.count).toBe(2);
    expect(view.items.every((i) => i.action === "closed")).toBe(true);
    expect(getAgent(db, "fixer-1", ws)).toBeUndefined();
    expect(getAgent(db, "fixer-2", ws)).toBeUndefined();
  });

  it("skips busy agents regardless of age", async () => {
    updateAgentStatus(db, "fixer-1", "busy", ws);
    ageAgent(db, "fixer-1", 60 * 60_000);
    updateAgentStatus(db, "fixer-2", "needs_input", ws);
    ageAgent(db, "fixer-2", 60 * 60_000);

    const view = await reapIdleAgents(db, { workstream: ws, idleForMs: 5 * 60_000 });
    expect(view.count).toBe(1);
    const busy = view.items.find((i) => i.name === "fixer-1");
    expect(busy?.action).toBe("skipped");
    expect(busy?.reason).toContain("busy");
    // The busy agent survives.
    expect(getAgent(db, "fixer-1", ws)).toBeDefined();
    expect(getAgent(db, "fixer-2", ws)).toBeUndefined();
  });

  it("skips agents that are idle but not yet past the threshold", async () => {
    updateAgentStatus(db, "fixer-1", "needs_input", ws);
    ageAgent(db, "fixer-1", 60_000); // 1 minute

    const view = await reapIdleAgents(db, { workstream: ws, idleForMs: 5 * 60_000 });
    expect(view.count).toBe(0);
    const item = view.items.find((i) => i.name === "fixer-1");
    expect(item?.action).toBe("skipped");
    expect(item?.reason).toContain("<");
    expect(getAgent(db, "fixer-1", ws)).toBeDefined();
  });

  it("dry-run reports closeable agents without mutating", async () => {
    updateAgentStatus(db, "fixer-1", "needs_input", ws);
    ageAgent(db, "fixer-1", 10 * 60_000);

    const view = await reapIdleAgents(db, {
      workstream: ws,
      idleForMs: 5 * 60_000,
      dryRun: true,
    });
    expect(view.count).toBe(1);
    expect(view.items.find((i) => i.name === "fixer-1")?.action).toBe("closed");
    // Nothing was actually closed.
    expect(getAgent(db, "fixer-1", ws)).toBeDefined();
  });

  it("defaults the threshold to idleThresholdMs() when idleForMs is omitted", async () => {
    updateAgentStatus(db, "fixer-1", "free", ws);
    ageAgent(db, "fixer-1", 10 * 60_000); // > 5m default

    const view = await reapIdleAgents(db, { workstream: ws });
    expect(view.items.find((i) => i.name === "fixer-1")?.action).toBe("closed");
  });

  it("does NOT close a recently-idle agent when idleForMs is NaN (falls back to default threshold)", async () => {
    // A non-numeric --idle-for would yield NaN; `idleMs < NaN` is always
    // false, which previously bypassed the guard and closed everything.
    updateAgentStatus(db, "fixer-1", "needs_input", ws);
    ageAgent(db, "fixer-1", 1_000); // 1 second idle — well under the 5m default

    const view = await reapIdleAgents(db, { workstream: ws, idleForMs: Number.NaN });
    expect(view.count).toBe(0);
    expect(view.items.find((i) => i.name === "fixer-1")?.action).toBe("skipped");
    expect(getAgent(db, "fixer-1", ws)).toBeDefined();
  });

  it("treats a negative idleForMs as the default threshold (does not close recently-idle agents)", async () => {
    updateAgentStatus(db, "fixer-1", "needs_input", ws);
    ageAgent(db, "fixer-1", 1_000);

    const view = await reapIdleAgents(db, { workstream: ws, idleForMs: -1 });
    expect(view.count).toBe(0);
    expect(getAgent(db, "fixer-1", ws)).toBeDefined();
  });

  it("returns an empty view for a workstream with no agents", async () => {
    const view = await reapIdleAgents(db, { workstream: "nonexistent" });
    expect(view).toEqual({ items: [], count: 0 });
  });
});
