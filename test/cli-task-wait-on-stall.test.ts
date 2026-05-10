// Unit tests for `mu task wait --on-stall <warn|exit>`
// (task_wait_stall_action_flag).
//
// Real SQLite (in-temp-dir), no tmux. Drives the CLI in-process via
// runCli — same pattern as test/cli-task-wait-cross-ws.test.ts.
// Determinism comes from running outside any tmux session: the
// per-poll reconcile in cmdTaskWait wraps `reconcile()` in
// try/catch, so the absence of tmux silently no-ops the reaper —
// and the stall predicate (which is pure DB read on the agent row's
// status + updated_at) takes the spotlight.
//
// What we cover:
//   1. --on-stall exit (target=CLOSED): stuck task → exit 7;
//      stderr names the task + agent + needs_input phrase.
//   2. --on-stall exit + --status OPEN carve-out: behaves as warn-only.
//   3. --stuck-after 0 disables both warn AND exit.
//   4. Multi-ref --on-stall exit fires on the FIRST stalled ref (argv
//      order; the loop iterates refs in order).
//
// The dead-pane-vs-stall PRECEDENCE proof lives at the SDK level in
// test/tasks.test.ts ("--on-stall exit: a beforePoll throw pre-empts
// the stuck-check throw"). An integration version of that test is
// unavoidably racy: tick 0 snapshot vs tmux's pane-death propagation
// can land in either order depending on system load (a `mu state
// --hud` background process running concurrently is enough to
// trigger a spurious reaper-flip in the wait pipeline). The SDK
// seam reaches the same assertion deterministically.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { setWaitSleepForTests } from "../src/tasks/wait.js";
import { type TmuxExecutor, resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task wait --on-stall warn|exit", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;
  let workstream: string;
  let restoreSleep: ((ms: number) => Promise<void>) | undefined;

  // Track every paneId seeded by setupStalledWorker so the mock
  // tmux executor below reports them all as live (otherwise the
  // per-poll reconcile would treat them as ghosts and reap them —
  // exactly the failure mode that breaks integration runs of this
  // test under load from a background `mu state --hud` or similar).
  const liveAgentPaneIds = new Set<string>();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-stall-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    // Per-test unique workstream so even if a future change runs the
    // file in parallel-test mode the rows don't bleed across tests.
    const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    workstream = `stall-${tag}`;
    ensureWorkstream(db, workstream);
    liveAgentPaneIds.clear();
    // Mock tmux so the per-poll reconcile in cmdTaskWait sees every
    // seeded agent's pane as alive (no ghost-prune → no reaper-flip).
    // We answer ONLY the calls reconcile makes and return harmless
    // empties for everything else; tests don't exercise other tmux
    // paths.
    const executor: TmuxExecutor = async (args) => {
      // list-panes for `mu-<ws>`: synthesize one row per live pane id.
      if (args[0] === "list-panes") {
        const lines = [...liveAgentPaneIds].map((paneId) => `@1\t${paneId}\tagent\tsh`).join("\n");
        return { stdout: `${lines}\n`, stderr: "", exitCode: 0 };
      }
      // capture-pane: empty scrollback → detector falls through to
      // 'needs_input' → matches the seeded status → no UPDATE →
      // updated_at stays stale (the desired stuck state).
      if (args[0] === "capture-pane") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      // refreshAgentTitle / set-option / display-message etc.: noop.
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    setTmuxExecutor(executor);
    // Tight poll-sleep so timeout-path tests don't burn real wall time.
    restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)));
    });
  });

  afterEach(() => {
    if (restoreSleep !== undefined) setWaitSleepForTests(restoreSleep);
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Set up a registered worker owning an IN_PROGRESS task. The
   *  agent's status is set to needs_input with `updated_at` 10min
   *  in the past so the --stuck-after predicate fires immediately.
   *
   *  Direct DB manipulation (instead of `claimTask`) keeps the
   *  setup deterministic outside any tmux session: claimTask
   *  resolves an actor identity via tmux/$USER and would fail
   *  silently in this no-tmux unit harness. Mirrors the same
   *  pattern in test/tasks.test.ts ("emits exactly one STUCK warning
   *  per stuck task per wait call"). */
  function setupStalledWorker(agentName: string, taskName: string): void {
    const paneId = `%${Math.floor(Math.random() * 1e6)}`;
    liveAgentPaneIds.add(paneId);
    insertAgent(db, {
      name: agentName,
      workstream,
      paneId,
      status: "needs_input",
    });
    addTask(db, { localId: taskName, workstream, title: "T", impact: 50, effortDays: 1 });
    db.prepare(
      `UPDATE tasks SET status = 'IN_PROGRESS',
              owner_id = (SELECT id FROM agents WHERE name = ?),
              updated_at = ?
        WHERE local_id = ?`,
    ).run(agentName, new Date().toISOString(), taskName);
    // Back-date the agent's updated_at AFTER the claim so the
    // staleness check fires immediately on tick 0.
    db.prepare("UPDATE agents SET status = 'needs_input', updated_at = ? WHERE name = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      agentName,
    );
  }

  it("--on-stall exit: stall → exit 7; stderr names task + agent + needs_input", async () => {
    setupStalledWorker("alice", "build");

    const start = Date.now();
    const { exitCode, stderr } = await runCli(
      [
        "task",
        "wait",
        "build",
        "-w",
        workstream,
        "--stuck-after",
        "1",
        "--on-stall",
        "exit",
        "--timeout",
        "30",
      ],
      dbPath,
    );
    const elapsedMs = Date.now() - start;

    expect(exitCode).toBe(7);
    expect(stderr).toContain("build");
    expect(stderr).toContain("alice");
    expect(stderr).toMatch(/needs_input/i);
    // Fail-fast property: well under --timeout. The 10ms sleep clamp
    // means we land in <1s in practice.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("--on-stall exit + --status OPEN: warn-only (carve-out mirrors exit-6)", async () => {
    // The carve-out rule: --on-stall exit is suppressed when the
    // wait target is anything other than CLOSED. Same logic as
    // exit-6's reaper-flip suppression — with --status OPEN the
    // worker reaching needs_input might BE the success path, so
    // exiting on stall would race the wait-condition check.
    setupStalledWorker("carol", "review");

    const { exitCode, stderr } = await runCli(
      [
        "task",
        "wait",
        "review",
        "-w",
        workstream,
        "--status",
        "OPEN",
        "--stuck-after",
        "1",
        "--on-stall",
        "exit",
        "--timeout",
        "1",
      ],
      dbPath,
    );

    expect(exitCode).toBe(5); // timed out, NOT exit 7
    // Stderr STILL got the warning — the SDK still emits + persists
    // when --on-stall is downgraded to warn-only.
    expect(stderr).toMatch(/stuck/i);
  });

  it("--stuck-after 0 disables both warn and exit (--on-stall exit no-ops)", async () => {
    setupStalledWorker("eve", "audit");

    const { exitCode, stderr } = await runCli(
      [
        "task",
        "wait",
        "audit",
        "-w",
        workstream,
        "--stuck-after",
        "0",
        "--on-stall",
        "exit",
        "--timeout",
        "1",
      ],
      dbPath,
    );

    expect(exitCode).toBe(5); // timed out, never fired stall
    expect(stderr).not.toMatch(/stuck/i);
  });

  it("multi-ref --on-stall exit fires on the FIRST stalled task (argv order)", async () => {
    setupStalledWorker("w1", "t1");
    setupStalledWorker("w2", "t2");

    const { exitCode, stderr } = await runCli(
      [
        "task",
        "wait",
        "t1",
        "t2",
        "-w",
        workstream,
        "--stuck-after",
        "1",
        "--on-stall",
        "exit",
        "--timeout",
        "30",
      ],
      dbPath,
    );

    expect(exitCode).toBe(7);
    // Names t1 (first in argv), not t2.
    expect(stderr).toContain("t1");
    expect(stderr).toContain("w1");
  });

  it("--on-stall warn (default): stuck task → warning, polling continues, eventual timeout (exit 5)", async () => {
    // The default is byte-for-byte identical to today's --stuck-after
    // behaviour. The test validates that the new --on-stall flag at
    // its default value doesn't change anything.
    setupStalledWorker("dave", "ship");

    const { exitCode, stderr } = await runCli(
      ["task", "wait", "ship", "-w", workstream, "--stuck-after", "1", "--timeout", "1"],
      dbPath,
    );

    expect(exitCode).toBe(5); // timed out, NOT exit 7
    expect(stderr).toMatch(/stuck/i);
    expect(stderr).toContain("ship");
    expect(stderr).toContain("dave");
  });

  it("--on-stall warn (explicit): same as default warn", async () => {
    setupStalledWorker("frank", "deploy");

    const { exitCode, stderr } = await runCli(
      [
        "task",
        "wait",
        "deploy",
        "-w",
        workstream,
        "--stuck-after",
        "1",
        "--on-stall",
        "warn",
        "--timeout",
        "1",
      ],
      dbPath,
    );

    expect(exitCode).toBe(5); // timed out, warn-only
    expect(stderr).toMatch(/stuck/i);
  });

  it("--on-stall <bad>: usage error", async () => {
    addTask(db, {
      localId: "x",
      workstream,
      title: "X",
      impact: 50,
      effortDays: 1,
    });

    const { exitCode, stderr } = await runCli(
      ["task", "wait", "x", "-w", workstream, "--on-stall", "bogus"],
      dbPath,
    );

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--on-stall/);
  });
});
