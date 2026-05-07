// Integration test for the high-level agent verbs.
//
// Real tmux server, real SQLite DB, but agents run `sh` instead of `pi`
// so we don't need pi installed. The pi-only status detector returns
// `needs_input` for sh panes (no busy/permission patterns match), which
// matches what we'd want — sh sitting idle is "needs_input."
//
// Skipped when not running inside tmux.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent, getAgent, listLiveAgents, readAgent, spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { killSession, resetTmuxExecutor } from "../src/tmux.js";

const TMUX_AVAILABLE = process.env.TMUX !== undefined && process.env.TMUX !== "";
const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

describeIfTmux("verbs integration (real tmux + real DB)", () => {
  let tempDir: string;
  let db: Db;
  let workstream: string;
  let session: string;

  beforeEach(() => {
    resetTmuxExecutor();
    // Disable the spawn liveness check (R2) for these integration tests
    // — the long-running sh subprocesses ARE alive but the 1500ms wait
    // per spawn balloons the suite. The check is covered by dedicated
    // unit tests in test/verbs.test.ts.
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    tempDir = mkdtempSync(join(tmpdir(), "mu-verbs-i-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    // Keep within the 32-char workstream-name limit. base36 keeps it short.
    const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    workstream = `t-${tag}`;
    session = `mu-${workstream}`;
  });

  afterEach(async () => {
    const key = "MU_SPAWN_LIVENESS_MS";
    delete process.env[key];
    try {
      db.close();
    } catch {}
    try {
      await killSession(session);
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  // The sh command used as the spawn target. Stays alive forever so the
  // pane doesn't terminate before we can interact with it.
  const SH_COMMAND = "sh -c 'while true; do sleep 60; done'";

  it("spawn → list → close → list (round trip)", async () => {
    const a = await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    expect(a.name).toBe("alice");
    expect(a.workstream).toBe(workstream);
    expect(a.paneId).toMatch(/^%\d+$/);
    expect(a.status).toBe("spawning");

    const view = await listLiveAgents(db, { workstream });
    expect(view.agents.map((x) => x.name)).toEqual(["alice"]);

    await closeAgent(db, "alice");
    const view2 = await listLiveAgents(db, { workstream });
    expect(view2.agents).toEqual([]);
    expect(getAgent(db, "alice")).toBeUndefined();
  });

  it("creates the mu-<workstream> tmux session on first spawn", async () => {
    await spawnAgent(db, { name: "alice", workstream, cli: "sh", command: SH_COMMAND });

    const { sessionExists } = await import("../src/tmux.js");
    expect(await sessionExists(session)).toBe(true);
  });

  it("sets the pane title to the agent name", async () => {
    const a = await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    const { getPaneTitle } = await import("../src/tmux.js");
    expect(await getPaneTitle(a.paneId)).toBe("alice");
  });

  it("multiple agents in same tab share a window with multiple panes", async () => {
    const a = await spawnAgent(db, {
      name: "alice",
      workstream,
      tab: "Backend",
      cli: "sh",
      command: SH_COMMAND,
    });
    const b = await spawnAgent(db, {
      name: "bob",
      workstream,
      tab: "Backend",
      cli: "sh",
      command: SH_COMMAND,
    });

    const { listPanes } = await import("../src/tmux.js");
    const panes = await listPanes(`${session}:Backend`);
    const ids = panes.map((p) => p.paneId).sort();
    expect(ids).toEqual([a.paneId, b.paneId].sort());
  });

  it("agents without a shared tab each get their own window", async () => {
    await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    await spawnAgent(db, {
      name: "bob",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });

    const { listWindows } = await import("../src/tmux.js");
    const windows = await listWindows(session);
    const names = windows.map((w) => w.name).sort();
    expect(names).toContain("alice");
    expect(names).toContain("bob");
  });

  it("readAgent returns scrollback (echoed marker visible)", async () => {
    const marker = `MU_VERBS_${Date.now()}`;
    await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: `sh -c 'echo ${marker}; while true; do sleep 60; done'`,
    });
    // Wait briefly for the echo to land.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const out = await readAgent(db, "alice");
    expect(out).toContain(marker);
  });

  it("listLiveAgents detects status post-spawn (sh pane → needs_input)", async () => {
    await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });

    // Allow tmux to settle.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const view = await listLiveAgents(db, { workstream });
    expect(view.agents).toHaveLength(1);
    // pi-only detector returns needs_input for sh (no patterns match).
    expect(view.agents[0]?.status).toBe("needs_input");
    expect(view.report.statusChanges).toBe(1); // spawning → needs_input
  });

  // ── The MVP step-5 acceptance test ───────────────────────────────────
  it("ACCEPTANCE: spawn 3 agents, read each, see status, close them; state survives DB reopen", async () => {
    // 1. Spawn 3 agents.
    const alice = await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    const bob = await spawnAgent(db, {
      name: "bob",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    const carol = await spawnAgent(db, {
      name: "carol",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
      tab: "Review",
    });
    expect([alice, bob, carol].every((a) => a.paneId.match(/^%\d+$/))).toBe(true);

    // 2. Read each.
    expect(await readAgent(db, "alice", { lines: 5 })).toBeDefined();
    expect(await readAgent(db, "bob", { lines: 5 })).toBeDefined();
    expect(await readAgent(db, "carol", { lines: 5 })).toBeDefined();

    // 3. List shows correct status.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const view = await listLiveAgents(db, { workstream });
    expect(view.agents.map((a) => a.name).sort()).toEqual(["alice", "bob", "carol"]);
    for (const agent of view.agents) {
      expect(agent.status).toBe("needs_input");
    }
    expect(view.orphans).toEqual([]);

    // 4. State survives a DB process restart.
    db.close();
    const db2 = openDb({ path: join(tempDir, "mu.db") });
    try {
      const view2 = await listLiveAgents(db2, { workstream });
      // Same 3 agents still listed (their tmux panes still exist).
      expect(view2.agents.map((a) => a.name).sort()).toEqual(["alice", "bob", "carol"]);
      // No ghosts pruned.
      expect(view2.report.prunedGhosts).toBe(0);
    } finally {
      db2.close();
      db = openDb({ path: join(tempDir, "mu.db") }); // restore for afterEach
    }

    // 5. Close all three.
    const r1 = await closeAgent(db, "alice");
    const r2 = await closeAgent(db, "bob");
    const r3 = await closeAgent(db, "carol");
    expect(r1).toMatchObject({ killedPane: true, deletedRow: true, workspaceKept: false });
    expect(r2).toMatchObject({ killedPane: true, deletedRow: true, workspaceKept: false });
    expect(r3).toMatchObject({ killedPane: true, deletedRow: true, workspaceKept: false });

    const view3 = await listLiveAgents(db, { workstream });
    expect(view3.agents).toEqual([]);
  });
});

if (!TMUX_AVAILABLE) {
  describe("verbs integration", () => {
    it.skip("skipped — set $TMUX (run inside tmux) to enable", () => {});
  });
}
