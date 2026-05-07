// MVP acceptance test.
//
// Scripted version of the canonical demo (see CHANGELOG.md):
// build a 10-task graph (with one diamond), spawn 3 agents, run the
// claim → send → task-note → close lifecycle, recover from an external
// pane death. All against a real tmux server with a real SQLite DB.
//
// This is the "if this passes, MVP is done" test. Skipped when not
// running inside tmux.
//
// Uses the CLI's underlying programmatic API directly (faster than
// shelling out to `mu` for every step). The CLI itself wraps the same
// functions, so this exercises the same code path the real CLI does.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent, insertAgent, listAgents, listLiveAgents, spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addNote, addTask, claimTask, getTask, listReady } from "../src/tasks.js";
import { killPane, killSession, resetTmuxExecutor } from "../src/tmux.js";
import { getParallelTracks } from "../src/tracks.js";

const TMUX_AVAILABLE = process.env.TMUX !== undefined && process.env.TMUX !== "";
const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

describeIfTmux("MVP acceptance — full demo end-to-end", () => {
  let tempDir: string;
  let db: Db;
  let workstream: string;
  let session: string;

  const SH_COMMAND = "sh -c 'while true; do sleep 60; done'";

  beforeEach(() => {
    resetTmuxExecutor();
    // Disable the spawn liveness check (R2): real tmux + a long-running
    // sh subprocess is alive, but the 1500ms wait per spawn would push
    // the 3-agent demo past the default test timeout. The check is
    // exercised by dedicated unit tests in test/verbs.test.ts.
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    tempDir = mkdtempSync(join(tmpdir(), "mu-accept-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    // Keep within the workstream-name length limit (32 chars). Encode
    // pid + timestamp + random in base36 for compactness.
    const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    workstream = `accept-${tag}`;
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

  it("the canonical 10-task / 3-agent / diamond demo", async () => {
    // ── Plan: 10-task graph with one diamond (lib joins api+ui) ────────
    addTask(db, { localId: "specs", workstream, title: "Write specs", impact: 90, effortDays: 1 });
    addTask(db, {
      localId: "api",
      workstream,
      title: "Design API",
      impact: 80,
      effortDays: 2,
      blocks: ["specs"],
    });
    addTask(db, {
      localId: "ui",
      workstream,
      title: "Design UI",
      impact: 70,
      effortDays: 2,
      blocks: ["specs"],
    });
    addTask(db, {
      localId: "lib",
      workstream,
      title: "Build shared lib",
      impact: 80,
      effortDays: 3,
      blocks: ["api", "ui"],
    });
    addTask(db, {
      localId: "backend",
      workstream,
      title: "Build backend",
      impact: 80,
      effortDays: 5,
      blocks: ["lib"],
    });
    addTask(db, {
      localId: "frontend",
      workstream,
      title: "Build frontend",
      impact: 70,
      effortDays: 5,
      blocks: ["lib"],
    });
    addTask(db, {
      localId: "tests",
      workstream,
      title: "Write tests",
      impact: 60,
      effortDays: 3,
      blocks: ["backend", "frontend"],
    });
    addTask(db, {
      localId: "docs",
      workstream,
      title: "Write docs",
      impact: 50,
      effortDays: 2,
      blocks: ["api", "ui"],
    });
    addTask(db, {
      localId: "deploy",
      workstream,
      title: "Deploy to staging",
      impact: 70,
      effortDays: 1,
      blocks: ["tests"],
    });
    addTask(db, {
      localId: "launch",
      workstream,
      title: "Launch",
      impact: 100,
      effortDays: 1,
      blocks: ["deploy", "docs"],
    });

    // ── Verify the graph: only `specs` is ready, launch is the only goal ──
    expect(listReady(db, workstream).map((t) => t.localId)).toEqual(["specs"]);
    const tracks0 = getParallelTracks(db, workstream);
    expect(tracks0).toHaveLength(1);
    expect(tracks0[0]?.roots.map((r) => r.localId)).toEqual(["launch"]);
    expect(tracks0[0]?.taskIds.size).toBe(10);

    // ── Spawn a 3-agent crew ──────────────────────────────────────────
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
    const revv = await spawnAgent(db, {
      name: "revv",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
      tab: "Review",
      role: "read-only",
    });

    // 3 agents, alice/bob in their own windows, revv in "Review".
    expect(
      listAgents(db, { workstream })
        .map((a) => a.name)
        .sort(),
    ).toEqual(["alice", "bob", "revv"]);

    // ── Workflow: alice claims specs, drops a note, closes specs ──────
    const claimResult = await claimTask(db, "specs", { agentName: "alice" });
    expect(claimResult.owner).toBe("alice");
    expect(claimResult.previousStatus).toBe("OPEN");
    expect(claimResult.status).toBe("IN_PROGRESS");

    addNote(db, "specs", "DECISION: API will be REST + JSON, no GraphQL", { author: "alice" });

    // Close specs by direct SQL (the escape hatch underneath the typed verbs).
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='specs'").run();

    // ── After closing specs: api and ui both become ready ────────────
    const readyAfterSpecs = listReady(db, workstream)
      .map((t) => t.localId)
      .sort();
    expect(readyAfterSpecs).toEqual(["api", "ui"]);

    // bob and revv each take one of the now-ready tasks.
    await claimTask(db, "api", { agentName: "bob" });
    await claimTask(db, "ui", { agentName: "revv" });
    expect(getTask(db, "api")?.owner).toBe("bob");
    expect(getTask(db, "ui")?.owner).toBe("revv");

    // ── Reconciliation: agent state visible in mission control ───────
    await new Promise((resolve) => setTimeout(resolve, 200));
    const view1 = await listLiveAgents(db, { workstream });
    expect(view1.agents).toHaveLength(3);
    for (const agent of view1.agents) {
      expect(agent.status).toBe("needs_input"); // sh panes show no busy/permission patterns
    }

    // ── Recovery: bob's pane dies externally ──────────────────────────
    await killPane(bob.paneId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const view2 = await listLiveAgents(db, { workstream });
    expect(view2.report.prunedGhosts).toBe(1);
    expect(view2.agents.map((a) => a.name).sort()).toEqual(["alice", "revv"]);
    // bob's row was pruned by reconciliation.

    // ── Survival: close the DB connection, reopen, agents still listed ──
    db.close();
    const db2 = openDb({ path: join(tempDir, "mu.db") });
    try {
      const view3 = await listLiveAgents(db2, { workstream });
      // alice and revv still alive (their tmux panes survived).
      expect(view3.agents.map((a) => a.name).sort()).toEqual(["alice", "revv"]);
      // Tasks survived too.
      const closedSpecs = getTask(db2, "specs");
      expect(closedSpecs?.status).toBe("CLOSED");
      // api.owner was 'bob', but bob's pane died externally and reconcile
      // pruned bob's agent row. With tasks.owner now a real FK to
      // agents(name) ON DELETE SET NULL, api.owner clears automatically
      // — the canonical "owner = current ownership, not history" model.
      // Historical attribution lives in task notes.
      expect(getTask(db2, "api")?.owner).toBeNull();
    } finally {
      db2.close();
      db = openDb({ path: join(tempDir, "mu.db") });
    }

    // ── Orphan surfacing: insert a fake row that points at no real pane,
    //    then reconcile to verify it's pruned.
    insertAgent(db, {
      name: "ghost",
      workstream,
      paneId: "%999999",
      status: "busy",
    });
    const view4 = await listLiveAgents(db, { workstream });
    expect(view4.report.prunedGhosts).toBe(1);
    expect(view4.agents.find((a) => a.name === "ghost")).toBeUndefined();

    // ── Cleanup: close the surviving agents ──────────────────────────
    const r1 = await closeAgent(db, "alice");
    const r2 = await closeAgent(db, "revv");
    expect(r1.killedPane && r1.deletedRow).toBe(true);
    expect(r2.killedPane && r2.deletedRow).toBe(true);

    const view5 = await listLiveAgents(db, { workstream });
    expect(view5.agents).toEqual([]);
  });
});

if (!TMUX_AVAILABLE) {
  describe("MVP acceptance", () => {
    it.skip("skipped — set $TMUX (run inside tmux) to enable", () => {});
  });
}
