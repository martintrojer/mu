// Integration test for the claim protocol via real tmux.
//
// The claim protocol's headline property: an agent can run `mu claim
// <task>` from inside its own pane WITHOUT passing its name explicitly.
// mu reads `tmux display-message -t $TMUX_PANE -p '#{pane_title}'` to
// derive the agent identity from the pane title set on spawn.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, claimTask, getTask } from "../src/tasks.js";
import { killSession, resetTmuxExecutor } from "../src/tmux.js";

const TMUX_AVAILABLE = process.env.TMUX !== undefined && process.env.TMUX !== "";
const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

describeIfTmux("claim integration (real tmux + real DB)", () => {
  let tempDir: string;
  let db: Db;
  let workstream: string;
  let session: string;

  beforeEach(() => {
    resetTmuxExecutor();
    // Disable spawn liveness (R2): the long-running sh subprocesses ARE
    // alive but the 1500ms wait per spawn slows the suite. The check is
    // covered by dedicated unit tests in test/verbs.test.ts.
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    tempDir = mkdtempSync(join(tmpdir(), "mu-claim-i-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    workstream = `claimtest-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    session = `mu-${workstream}`;
  });

  afterEach(async () => {
    const livenessKey = "MU_SPAWN_LIVENESS_MS";
    delete process.env[livenessKey];
    try {
      db.close();
    } catch {}
    try {
      await killSession(session);
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper: run a callback with $TMUX_PANE temporarily set. Computed-key
  // form for env deletion so Biome's noDelete rule doesn't trip.
  async function withPane<T>(paneId: string, fn: () => Promise<T>): Promise<T> {
    const key = "TMUX_PANE";
    const original = process.env[key];
    process.env[key] = paneId;
    try {
      return await fn();
    } finally {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }

  it("claim from a spawned pane derives owner = agent name (zero-config)", async () => {
    // 1. Spawn an agent. spawnAgent sets the pane title to the agent name.
    const agent = await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: "sh -c 'while true; do sleep 60; done'",
    });

    // 2. Create a task to claim.
    addTask(db, {
      localId: "design",
      workstream: "test",
      title: "Design auth",
      impact: 80,
      effortDays: 2,
    });

    // 3. Simulate "running mu claim from inside alice's pane" by setting
    //    $TMUX_PANE to alice's pane id and calling claimTask with no
    //    explicit agentName.
    const result = await withPane(agent.paneId, () => claimTask(db, "design"));

    // 4. The claim should have derived owner = "alice" from the pane title.
    expect(result.owner).toBe("alice");
    expect(result.previousOwner).toBeNull();
    expect(result.previousStatus).toBe("OPEN");
    expect(result.status).toBe("IN_PROGRESS");
    expect(getTask(db, "design")?.owner).toBe("alice");
  });

  it("two agents cannot claim the same task (atomic CAS via real tmux identities)", async () => {
    const alice = await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: "sh -c 'while true; do sleep 60; done'",
    });
    const bob = await spawnAgent(db, {
      name: "bob",
      workstream,
      cli: "sh",
      command: "sh -c 'while true; do sleep 60; done'",
    });
    addTask(db, {
      localId: "task1",
      workstream: "test",
      title: "Task 1",
      impact: 50,
      effortDays: 1,
    });

    // Alice claims first.
    const aliceResult = await withPane(alice.paneId, () => claimTask(db, "task1"));
    expect(aliceResult.owner).toBe("alice");

    // Bob's claim attempt fails — task is already owned.
    await expect(withPane(bob.paneId, () => claimTask(db, "task1"))).rejects.toThrow(
      /already owned by alice/,
    );

    // Final state: alice still owns it.
    expect(getTask(db, "task1")?.owner).toBe("alice");
  });

  it("re-claim by the same agent is a no-op (idempotent)", async () => {
    const alice = await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: "sh -c 'while true; do sleep 60; done'",
    });
    addTask(db, {
      localId: "task1",
      workstream: "test",
      title: "Task 1",
      impact: 50,
      effortDays: 1,
    });

    await withPane(alice.paneId, () => claimTask(db, "task1"));
    // Second claim by alice succeeds (no error).
    const second = await withPane(alice.paneId, () => claimTask(db, "task1"));
    expect(second.owner).toBe("alice");
    expect(second.previousStatus).toBe("IN_PROGRESS"); // already in progress
  });
});

if (!TMUX_AVAILABLE) {
  describe("claim integration", () => {
    it.skip("skipped — set $TMUX (run inside tmux) to enable", () => {});
  });
}
