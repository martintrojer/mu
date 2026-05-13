// Integration test for `mu task wait` per-poll reconcile + reaper-flip
// detection (task_wait_reconcile_dead_panes).
//
// Real tmux + real SQLite. Skipped when not running inside tmux.
//
// What we cover (Option B of the design spec):
//   1. Wait CLOSED → kill the worker pane mid-wait → exit 6 within
//      ~poll-interval seconds (NOT --timeout).
//   2. stderr message includes the task id, the prior owner, and the
//      word `reaper`.
//   3. Wait OPEN → reaper-flip → wait succeeds (target reached;
//      no exit-6 noise; reaper-flip TO open IS the success).
//   4. Pane stays alive + the task closes normally → exit 0; no
//      exit-6 noise (the reconcile-each-poll path doesn't break the
//      happy case).
//   5. --any with multiple watched tasks: first ref to either CLOSE
//      or DIE wins.
//
// Cadence: tests use a generous --timeout and a tight pollMs (via
// MU_TEST_WAIT_POLL_MS) so a successful exit-6 lands in <1s rather
// than running out the timeout. The fail-fast property is exactly
// what the verb's promotion criteria require.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, claimTask, getTask, setTaskStatus } from "../src/tasks.js";
import { setWaitSleepForTests } from "../src/tasks/wait.js";
import { killPane, killSession, paneExists, resetTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { pollUntil } from "./_env.js";
import { freshWorkstream } from "./_fixture.js";
import { runCli } from "./_runCli.js";

const TMUX_AVAILABLE = process.env.TMUX !== undefined && process.env.TMUX !== "";
const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

describeIfTmux("mu task wait — reaper-detection integration", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;
  let workstream: string;
  let session: string;
  // Restore-the-default poll-sleep on teardown; tests below shrink it
  // to a few ms so `wait` fails fast.
  let restoreSleep: ((ms: number) => Promise<void>) | undefined;

  beforeEach(() => {
    resetTmuxExecutor();
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-i-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    workstream = freshWorkstream("wait");
    session = `mu-${workstream}`;
    ensureWorkstream(db, workstream);
    // Tight poll cadence so the reconcile-each-poll path observes the
    // dead pane well before any --timeout. 25ms keeps the suite snappy
    // without starving the tmux helpers.
    restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 25)));
    });
  });

  afterEach(async () => {
    if (restoreSleep !== undefined) setWaitSleepForTests(restoreSleep);
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

  const SH_COMMAND = "sh -c 'while true; do sleep 60; done'";

  // tmux briefly reports a killed pane as still alive; poll until the
  // pane id has actually disappeared. Shared helper from test/_env.ts.
  async function waitForPaneGone(paneId: string): Promise<void> {
    await pollUntil(async () => !(await paneExists(paneId)), {
      description: `pane ${paneId} gone from tmux`,
    });
  }

  function runDuringFirstWaitSleep(action: () => Promise<void> | void): void {
    let fired = false;
    setWaitSleepForTests(async (ms) => {
      if (!fired) {
        fired = true;
        await action();
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 25)));
    });
  }

  it("kills the worker mid-wait → exit 6 within poll-interval (NOT --timeout)", async () => {
    const agent = await spawnAgent(db, {
      name: "alice",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    addTask(db, {
      localId: "build",
      workstream,
      title: "Build",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "build", { agentName: "alice", workstream });
    expect(getTask(db, "build", workstream)?.status).toBe("IN_PROGRESS");

    // Kill only after waitForTasks has taken its initial snapshot and
    // entered the first poll sleep. A fixed 100ms timer raced under
    // multi-agent stress: on a loaded machine the pane could die before
    // cmdTaskWait seeded its prior-state map, turning the expected
    // exit-6 into a timeout.
    runDuringFirstWaitSleep(() => killPane(agent.paneId));

    const start = Date.now();
    // Generous --timeout (60s); if exit 6 doesn't fire fast we'd
    // notice the test taking >> a second.
    const { exitCode, stderr, error } = await runCli(
      ["task", "wait", "build", "-w", workstream, "--timeout", "60"],
      dbPath,
    );
    const elapsedMs = Date.now() - start;

    expect(error).toBeUndefined();
    expect(exitCode).toBe(6);
    expect(stderr).toMatch(/reaper/i);
    expect(stderr).toContain("build");
    expect(stderr).toContain("alice");
    // Fail-fast property: well under any reasonable --timeout. Allow
    // a generous 10s ceiling for slow CI; the real number is <1s.
    expect(elapsedMs).toBeLessThan(10_000);
    // Pane really did die (defensive — confirms the test set up the
    // race correctly, not just that exit 6 fired for some other reason).
    await waitForPaneGone(agent.paneId);
  });

  it("--status OPEN + reaper-flip → exit 0 (reaper flip IS the success)", async () => {
    const agent = await spawnAgent(db, {
      name: "bob",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    addTask(db, {
      localId: "deploy",
      workstream,
      title: "Deploy",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "deploy", { agentName: "bob", workstream });

    runDuringFirstWaitSleep(() => killPane(agent.paneId));

    const { exitCode, stderr, error } = await runCli(
      ["task", "wait", "deploy", "-w", workstream, "--status", "OPEN", "--timeout", "60"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull(); // clean return; no process.exit
    expect(stderr).not.toMatch(/reaper/i);
    expect(getTask(db, "deploy", workstream)?.status).toBe("OPEN");
  });

  it("pane stays alive + task closes normally → exit 0; no exit-6 noise", async () => {
    await spawnAgent(db, {
      name: "carol",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    addTask(db, {
      localId: "review",
      workstream,
      title: "Review",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "review", { agentName: "carol", workstream });

    // Close the task after the wait loop has started (normal happy
    // path). Avoid fixed timers: under stress they can fire before
    // the CLI reaches waitForTasks.
    runDuringFirstWaitSleep(() => {
      setTaskStatus(db, "review", "CLOSED", { workstream });
    });

    const { exitCode, stderr, error } = await runCli(
      ["task", "wait", "review", "-w", workstream, "--timeout", "60"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).not.toMatch(/reaper/i);
    expect(getTask(db, "review", workstream)?.status).toBe("CLOSED");
  });

  it("--any: first watched task to die wins (exit 6)", async () => {
    const a1 = await spawnAgent(db, {
      name: "w1",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    await spawnAgent(db, {
      name: "w2",
      workstream,
      cli: "sh",
      command: SH_COMMAND,
    });
    addTask(db, { localId: "t1", workstream, title: "T1", impact: 50, effortDays: 1 });
    addTask(db, { localId: "t2", workstream, title: "T2", impact: 50, effortDays: 1 });
    await claimTask(db, "t1", { agentName: "w1", workstream });
    await claimTask(db, "t2", { agentName: "w2", workstream });

    // Kill w1's pane mid-wait. With --any the wait normally returns 0
    // as soon as ONE task reaches CLOSED; here, with neither closing,
    // the reaper-flip on t1 wins and we get exit 6 (suppression rule
    // is target=CLOSED, which is the default).
    runDuringFirstWaitSleep(() => killPane(a1.paneId));

    const { exitCode, stderr } = await runCli(
      ["task", "wait", "t1", "t2", "--any", "-w", workstream, "--timeout", "60"],
      dbPath,
    );
    expect(exitCode).toBe(6);
    // Should name t1 (the dead one) — not t2.
    expect(stderr).toContain("t1");
    expect(stderr).toMatch(/reaper/i);
  });
});

// task_wait_cross_workstream: a reaper-flip on a task we are NOT
// watching must not trigger exit 6. We wait on workstream A's task
// (the worker pane stays alive); meanwhile workstream B has its
// own dead-pane worker whose task gets reaper-flipped. The wait on
// A times out (or completes when we close A's task), but never
// surfaces exit 6 because the priorState/check loop is scoped to
// the watched refs.
describeIfTmux("mu task wait — cross-workstream reaper isolation", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;
  let wsA: string;
  let wsB: string;
  let sessionA: string;
  let sessionB: string;
  let restoreSleep: ((ms: number) => Promise<void>) | undefined;

  beforeEach(() => {
    resetTmuxExecutor();
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-x-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    wsA = freshWorkstream("wxa");
    wsB = freshWorkstream("wxb");
    sessionA = `mu-${wsA}`;
    sessionB = `mu-${wsB}`;
    ensureWorkstream(db, wsA);
    ensureWorkstream(db, wsB);
    restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 25)));
    });
  });

  afterEach(async () => {
    if (restoreSleep !== undefined) setWaitSleepForTests(restoreSleep);
    const key = "MU_SPAWN_LIVENESS_MS";
    delete process.env[key];
    try {
      db.close();
    } catch {}
    try {
      await killSession(sessionA);
    } catch {}
    try {
      await killSession(sessionB);
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  const SH = "sh -c 'while true; do sleep 60; done'";

  function runDuringFirstWaitSleep(action: () => Promise<void> | void): void {
    let fired = false;
    setWaitSleepForTests(async (ms) => {
      if (!fired) {
        fired = true;
        await action();
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 25)));
    });
  }

  it("reaper-flip on UNWATCHED workstream B does NOT trigger exit 6 on watch of A", async () => {
    // wsA: alive worker owns alphaTask; we'll wait on alphaTask only.
    await spawnAgent(db, { name: "a-worker", workstream: wsA, cli: "sh", command: SH });
    addTask(db, {
      localId: "alphatask",
      workstream: wsA,
      title: "A",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "alphatask", { agentName: "a-worker", workstream: wsA });

    // wsB: a worker owning betaTask, then we kill its pane mid-wait.
    // The reaper-flip happens in wsB; the wait verb only watches wsA.
    const beta = await spawnAgent(db, {
      name: "b-worker",
      workstream: wsB,
      cli: "sh",
      command: SH,
    });
    addTask(db, { localId: "betatask", workstream: wsB, title: "B", impact: 50, effortDays: 1 });
    await claimTask(db, "betatask", { agentName: "b-worker", workstream: wsB });

    // Kill B's pane after the wait loop has started. Then close A's
    // task on the following sleep so the wait succeeds (proving the
    // reaper event from the unwatched workstream did not abort it).
    let sleeps = 0;
    setWaitSleepForTests(async (ms) => {
      sleeps += 1;
      if (sleeps === 1) await killPane(beta.paneId);
      if (sleeps === 2) setTaskStatus(db, "alphatask", "CLOSED", { workstream: wsA });
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 25)));
    });

    const { exitCode, stderr } = await runCli(
      // Bare ref + -w wsA (NOT a cross-ws wait — the cross-ws part
      // here is the side-effect: B's reaper firing during a wsA wait
      // must NOT bleed into the wsA exit code).
      ["task", "wait", "alphatask", "-w", wsA, "--timeout", "30"],
      dbPath,
    );
    expect(exitCode).toBeNull(); // clean exit, NOT exit 6
    expect(stderr).not.toMatch(/reaper/i);
  });

  it("cross-ws qualified refs: reaper on a watched ref in B fires exit 6", async () => {
    // Same setup, but we ALSO watch wsB/betaTask via qualified ref.
    // Now the reaper-flip on B IS the watched event — exit 6 fires.
    await spawnAgent(db, { name: "a-worker", workstream: wsA, cli: "sh", command: SH });
    addTask(db, {
      localId: "alphatask",
      workstream: wsA,
      title: "A",
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, "alphatask", { agentName: "a-worker", workstream: wsA });

    const beta = await spawnAgent(db, {
      name: "b-worker",
      workstream: wsB,
      cli: "sh",
      command: SH,
    });
    addTask(db, { localId: "betatask", workstream: wsB, title: "B", impact: 50, effortDays: 1 });
    await claimTask(db, "betatask", { agentName: "b-worker", workstream: wsB });

    runDuringFirstWaitSleep(() => killPane(beta.paneId));

    const { exitCode, stderr } = await runCli(
      ["task", "wait", `${wsA}/alphatask`, `${wsB}/betatask`, "--timeout", "30"],
      dbPath,
    );
    expect(exitCode).toBe(6);
    // Names the dead ref's bare id (the typed error names the local
    // task id; the wait set is qualified-aware).
    expect(stderr).toContain("betatask");
    expect(stderr).toMatch(/reaper/i);
  });
});
