// waitForTasks (verb). Sort-key helper tests live in
// test/tasks-sort.test.ts and test/cli-task-sort.test.ts. The wait
// suite is the bulk of this file: poll-loop semantics, --any vs
// --all, timeout clamp, deletion
// mid-wait, --on-stall, and the stuck-warn dedupe (one warning per
// stuck task per call, not one per poll cycle).
//
// Split out of test/tasks.test.ts under
// testreview_test_files_past_800loc — see test/tasks-crud.integration.test.ts
// for the full split rationale.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import {
  StallDetectedDuringWaitError,
  TaskNotFoundError,
  addTask,
  deleteTask,
  getWaitPollCount,
  resetWaitPollCount,
  setTaskStatus,
  setWaitSleepForTests,
  setWaitStuckWarnForTests,
  waitForTasks,
} from "../src/tasks.js";
import { resetTmuxExecutor } from "../src/tmux.js";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-tasks-wait-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  resetTmuxExecutor();
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

// ─── waitForTasks (verb) ───────────────────────────────────────────────────

describe("waitForTasks", () => {
  beforeEach(() => {
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "test", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "test", title: "C", impact: 50, effortDays: 1 });
  });

  it("returns immediately when the wait condition is already satisfied (--all default)", async () => {
    setTaskStatus(db, "a", "CLOSED", { workstream: "test" });
    setTaskStatus(db, "b", "CLOSED", { workstream: "test" });
    setTaskStatus(db, "c", "CLOSED", { workstream: "test" });
    const startedAt = Date.now();
    const r = await waitForTasks(db, ["a", "b", "c"], { pollMs: 50, workstream: "test" });
    expect(r.timedOut).toBe(false);
    expect(r.refs.every((t) => t.reachedTarget)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(100); // didn't sleep through any poll cycle
    expect(r.refs).toEqual([
      {
        workstreamName: "test",
        name: "a",
        status: "CLOSED",
        owner: null,
        reachedTarget: true,
        stuck: false,
      },
      {
        workstreamName: "test",
        name: "b",
        status: "CLOSED",
        owner: null,
        reachedTarget: true,
        stuck: false,
      },
      {
        workstreamName: "test",
        name: "c",
        status: "CLOSED",
        owner: null,
        reachedTarget: true,
        stuck: false,
      },
    ]);
  });

  it("returns immediately on --any when at least one task already reached the target", async () => {
    setTaskStatus(db, "b", "CLOSED", { workstream: "test" });
    const r = await waitForTasks(db, ["a", "b", "c"], {
      any: true,
      pollMs: 50,
      workstream: "test",
    });
    const reached = r.refs.filter((t) => t.reachedTarget).length;
    expect(reached).toBe(1);
    expect(r.timedOut).toBe(false);
  });

  it("blocks until the condition is met (poll loop wakes up on the next snapshot)", async () => {
    // Schedule a status change to fire after one poll interval.
    const flipAt = Date.now();
    setTimeout(() => setTaskStatus(db, "a", "CLOSED", { workstream: "test" }), 60);
    const r = await waitForTasks(db, ["a"], { pollMs: 30, timeoutMs: 1000, workstream: "test" });
    expect(r.refs.every((t) => t.reachedTarget)).toBe(true);
    expect(r.timedOut).toBe(false);
    // Allow generous slack; assert we DID wait (not the immediate-exit path).
    expect(Date.now() - flipAt).toBeGreaterThanOrEqual(30);
  });

  it("times out with timedOut=true and exit-code-mappable result when condition not met", async () => {
    const r = await waitForTasks(db, ["a", "b"], {
      timeoutMs: 100,
      pollMs: 30,
      workstream: "test",
    });
    expect(r.timedOut).toBe(true);
    expect(r.refs.some((t) => t.reachedTarget)).toBe(false);
    // Per-task state at exit time still useful for the caller.
    expect(r.refs.map((t) => t.status)).toEqual(["OPEN", "OPEN"]);
  });

  it("--any times out cleanly when no task reaches the target", async () => {
    const r = await waitForTasks(db, ["a", "b"], {
      any: true,
      timeoutMs: 100,
      pollMs: 30,
      workstream: "test",
    });
    expect(r.timedOut).toBe(true);
    expect(r.refs.some((t) => t.reachedTarget)).toBe(false);
  });

  it("respects a non-default --status target (e.g. IN_PROGRESS)", async () => {
    setTaskStatus(db, "a", "IN_PROGRESS", { workstream: "test" });
    setTaskStatus(db, "b", "IN_PROGRESS", { workstream: "test" });
    const r = await waitForTasks(db, ["a", "b"], {
      status: "IN_PROGRESS",
      pollMs: 50,
      workstream: "test",
    });
    expect(r.refs.every((t) => t.reachedTarget)).toBe(true);
    expect(r.refs.every((t) => t.status === "IN_PROGRESS")).toBe(true);
  });

  it("throws TaskNotFoundError pre-flight if any listed task doesn't exist (loud-fail)", async () => {
    await expect(
      waitForTasks(db, ["a", "ghost", "b"], { timeoutMs: 1000, workstream: "test" }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("rejects an empty id list", async () => {
    await expect(waitForTasks(db, [], { workstream: "test" })).rejects.toThrow(/non-empty/);
  });

  it("partial-progress on timeout: some tasks reached, others didn't", async () => {
    setTaskStatus(db, "a", "CLOSED", { workstream: "test" });
    // b stays OPEN → all-of fails on timeout but one ref reached.
    const r = await waitForTasks(db, ["a", "b"], { timeoutMs: 80, pollMs: 30, workstream: "test" });
    expect(r.timedOut).toBe(true);
    const reached = r.refs.filter((t) => t.reachedTarget).length;
    expect(reached).toBe(1); // 'a' reached, 'b' did not
    expect(r.refs[0]?.reachedTarget).toBe(true);
    expect(r.refs[1]?.reachedTarget).toBe(false);
  });

  it("survives a task being deleted mid-wait (treats it as 'never reached')", async () => {
    setTimeout(() => deleteTask(db, "b", "test"), 40);
    const r = await waitForTasks(db, ["a", "b"], {
      timeoutMs: 120,
      pollMs: 30,
      workstream: "test",
    });
    expect(r.timedOut).toBe(true);
    // 'b' was deleted; defensive snapshot defaults to 'OPEN' / not reached.
    const bState = r.refs.find((t) => t.name === "b");
    expect(bState?.reachedTarget).toBe(false);
  });

  // Regression for the pre-clamp bug: with `pollMs > timeoutMs` the loop
  // used to await a full pollMs before re-checking the deadline, so a
  // caller asking for a 50ms timeout with a 1000ms poll would block ~1s.
  // Post-fix the sleep is clamped to `min(pollMs, deadline - now)`; the
  // function returns inside `timeoutMs + small slack`.
  it("returns within timeoutMs even when pollMs > timeoutMs (clamped sleep)", async () => {
    const startedAt = Date.now();
    const r = await waitForTasks(db, ["a"], { pollMs: 1000, timeoutMs: 50, workstream: "test" });
    const elapsed = Date.now() - startedAt;
    expect(r.timedOut).toBe(true);
    expect(r.refs.some((t) => t.reachedTarget)).toBe(false);
    // Pre-fix this would have been ~1000ms. 200ms is generous slack for
    // CI noise; the bug regression bound is ~1000.
    expect(elapsed).toBeLessThan(200);
  });

  // Sibling-progress when one task in the wait set is deleted mid-wait:
  // the original gap from the deferred test review. Deletion of 'b'
  // should not affect the wait correctly observing 'a' reach CLOSED.
  it("deletion of one task mid-wait does not block sibling progress detection", async () => {
    setTimeout(() => {
      deleteTask(db, "b", "test");
      setTaskStatus(db, "a", "CLOSED", { workstream: "test" });
    }, 30);
    const r = await waitForTasks(db, ["a", "b"], {
      any: true,
      pollMs: 20,
      timeoutMs: 1000,
      workstream: "test",
    });
    expect(r.timedOut).toBe(false);
    expect(r.refs.some((t) => t.reachedTarget)).toBe(true);
    const aState = r.refs.find((t) => t.name === "a");
    const bState = r.refs.find((t) => t.name === "b");
    expect(aState?.reachedTarget).toBe(true);
    expect(bState?.reachedTarget).toBe(false);
  });

  // Poll-count assertion via the test side-channel. With pollMs=10 and
  // timeoutMs=100 we expect ~10 polls; allow a tight 5-15 range to
  // tolerate scheduler jitter without losing the regression signal.
  it("polls roughly timeoutMs/pollMs times (asserts cadence via test seam)", async () => {
    resetWaitPollCount();
    let sleeps = 0;
    const restore = setWaitSleepForTests(async (ms) => {
      sleeps += 1;
      // Honour the requested duration so the deadline math still drives
      // termination; without this the loop would terminate after a
      // single iteration regardless of pollMs.
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    try {
      const r = await waitForTasks(db, ["a"], { pollMs: 10, timeoutMs: 100, workstream: "test" });
      expect(r.timedOut).toBe(true);
      const polls = getWaitPollCount();
      expect(polls).toBeGreaterThanOrEqual(5);
      expect(polls).toBeLessThanOrEqual(15);
      expect(sleeps).toBe(polls);
    } finally {
      setWaitSleepForTests(restore);
      resetWaitPollCount();
    }
  });

  // Regression for agent_close_discipline_gap: a worker that
  // committed + reported done in chat-style but skipped
  // `mu task close <id>` leaves the task IN_PROGRESS while the agent
  // sits in `needs_input`. mu task wait should keep polling but emit
  // exactly ONE yellow STUCK warning per stuck task per wait call —
  // not one per poll cycle (operators don't want stderr spam).
  it("emits exactly one STUCK warning per stuck task per wait call (agent_close_discipline_gap)", async () => {
    // Set up: a registered worker owns task 'a' which is IN_PROGRESS,
    // and the worker's status is `needs_input` with an `updated_at`
    // timestamp deep in the past so the staleness check fires on the
    // very first poll. We mutate updated_at directly via SQL because
    // updateAgentStatus auto-bumps it to now().
    insertAgent(db, {
      name: "worker-stuck",
      workstream: "test",
      paneId: "%99",
      status: "needs_input",
    });
    db.prepare(
      `UPDATE tasks SET status = 'IN_PROGRESS',
              owner_id = (SELECT id FROM agents WHERE name = ?),
              updated_at = ?
        WHERE local_id = ?`,
    ).run("worker-stuck", new Date().toISOString(), "a");
    db.prepare("UPDATE agents SET status = 'needs_input', updated_at = ? WHERE name = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      "worker-stuck",
    );

    const warnings: string[] = [];
    const restoreWarn = setWaitStuckWarnForTests((msg) => {
      warnings.push(msg);
    });
    // Use the sleep seam to actually sleep so the deadline math
    // terminates after several polls (mirrors the cadence test).
    const restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    try {
      const r = await waitForTasks(db, ["a", "b"], {
        pollMs: 10,
        timeoutMs: 80,
        stuckAfterMs: 1000, // 1s; agent is 10min stale so always stuck
        workstream: "test",
      });
      expect(r.timedOut).toBe(true);
      // 'a' is stuck; 'b' is just OPEN with no owner (not stuck).
      const aState = r.refs.find((t) => t.name === "a");
      const bState = r.refs.find((t) => t.name === "b");
      expect(aState?.stuck).toBe(true);
      expect(bState?.stuck).toBe(false);
      // Multiple poll cycles ran (the timeout/poll math gives ~8) but
      // only ONE warning was emitted — dedupe is the point.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("a stuck");
      expect(warnings[0]).toContain("worker-stuck");
      expect(warnings[0]).toContain("mu task close a");
      // idle_assigned_agent_detection: the stderr warn is one-shot
      // and dies with the wait process; the kind='event' row is the
      // durable corroborating signal that mu state, mu log, and
      // downstream tools surface. Assert the persist actually
      // happened (FK intact, prefix matches EVENT_VERB_PREFIXES,
      // workstream id resolved) and obeys the same one-per-wait
      // dedupe as the warning.
      const stalledEvents = listLogs(db, { workstream: "test", kind: "event" }).filter((r) =>
        r.payload.startsWith("agent stalled"),
      );
      expect(stalledEvents).toHaveLength(1);
      expect(stalledEvents[0]?.payload).toMatch(/^agent stalled worker-stuck owns a for \d+s$/);
      // Dedupe-across-calls property: a second wait call emits its own
      // single event (count → 2), not one per poll cycle.
      const r2 = await waitForTasks(db, ["a", "b"], {
        pollMs: 10,
        timeoutMs: 80,
        stuckAfterMs: 1000,
        workstream: "test",
      });
      expect(r2.timedOut).toBe(true);
      const stalledEvents2 = listLogs(db, { workstream: "test", kind: "event" }).filter((r) =>
        r.payload.startsWith("agent stalled"),
      );
      expect(stalledEvents2).toHaveLength(2);
    } finally {
      setWaitStuckWarnForTests(restoreWarn);
      setWaitSleepForTests(restoreSleep);
    }
  });

  // task_wait_stall_action_flag: --on-stall exit reuses the existing
  // --stuck-after predicate but THROWS instead of returning to polling.
  // Same emit + persist path; new exit code (7) is mapped at the CLI
  // boundary by classifyError. The SDK contract is the typed throw.
  it("--on-stall exit: throws StallDetectedDuringWaitError instead of polling forward", async () => {
    insertAgent(db, {
      name: "worker-onstall",
      workstream: "test",
      paneId: "%101",
      status: "needs_input",
    });
    db.prepare(
      `UPDATE tasks SET status = 'IN_PROGRESS',
              owner_id = (SELECT id FROM agents WHERE name = ?),
              updated_at = ?
        WHERE local_id = ?`,
    ).run("worker-onstall", new Date().toISOString(), "a");
    db.prepare("UPDATE agents SET status = 'needs_input', updated_at = ? WHERE name = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      "worker-onstall",
    );

    const warnings: string[] = [];
    const restoreWarn = setWaitStuckWarnForTests((msg) => {
      warnings.push(msg);
    });
    const restoreSleep = setWaitSleepForTests(async () => {});
    try {
      await expect(
        waitForTasks(db, ["a"], {
          pollMs: 10,
          timeoutMs: 5000,
          stuckAfterMs: 1000,
          onStall: "exit",
          workstream: "test",
        }),
      ).rejects.toBeInstanceOf(StallDetectedDuringWaitError);
      // Same emit + persist path: warning was still written, event row persisted.
      expect(warnings).toHaveLength(1);
      const stalledEvent = listLogs(db, { workstream: "test", kind: "event" }).find((r) =>
        r.payload.includes("agent stalled worker-onstall"),
      );
      expect(stalledEvent).toBeDefined();
    } finally {
      setWaitStuckWarnForTests(restoreWarn);
      setWaitSleepForTests(restoreSleep);
    }
  });

  it("--on-stall exit: error carries taskName + owner + workstream + ageSecs", async () => {
    insertAgent(db, {
      name: "w-fields",
      workstream: "test",
      paneId: "%102",
      status: "needs_input",
    });
    db.prepare(
      `UPDATE tasks SET status = 'IN_PROGRESS',
              owner_id = (SELECT id FROM agents WHERE name = ?)
        WHERE local_id = ?`,
    ).run("w-fields", "a");
    db.prepare("UPDATE agents SET status = 'needs_input', updated_at = ? WHERE name = ?").run(
      new Date(Date.now() - 600_000).toISOString(),
      "w-fields",
    );
    const restoreWarn = setWaitStuckWarnForTests(() => {});
    const restoreSleep = setWaitSleepForTests(async () => {});
    try {
      const err = await waitForTasks(db, ["a"], {
        pollMs: 10,
        timeoutMs: 5000,
        stuckAfterMs: 2000,
        onStall: "exit",
        workstream: "test",
      }).catch((e) => e);
      expect(err).toBeInstanceOf(StallDetectedDuringWaitError);
      const e = err as StallDetectedDuringWaitError;
      expect(e.taskName).toBe("a");
      expect(e.owner).toBe("w-fields");
      expect(e.workstream).toBe("test");
      expect(e.ageSecs).toBe(2); // round(stuckAfterMs / 1000)
      // HasNextSteps surface: poke + release + show.
      const steps = e.errorNextSteps();
      expect(steps.some((s) => s.command.includes("mu agent send w-fields"))).toBe(true);
      expect(steps.some((s) => s.command.includes("mu task release a --reopen"))).toBe(true);
    } finally {
      setWaitStuckWarnForTests(restoreWarn);
      setWaitSleepForTests(restoreSleep);
    }
  });

  // PRECEDENCE: deterministic SDK-level proof that a beforePoll throw
  // (ReaperDetectedDuringWaitError equivalent here — we throw a
  // sentinel from beforePoll) wins over the in-snapshot stuck-throw,
  // because beforePoll runs FIRST in the wait loop. Mirrors the
  // exit-6-vs-exit-7 precedence rule the CLI relies on (the CLI's
  // beforePoll throws ReaperDetectedDuringWaitError; this test asserts
  // the throw escapes BEFORE waitForTasks gets to snapshot's stuck-check).
  it("--on-stall exit: a beforePoll throw pre-empts the stuck-check throw (precedence)", async () => {
    insertAgent(db, {
      name: "w-precedence",
      workstream: "test",
      paneId: "%103",
      status: "needs_input",
    });
    db.prepare(
      `UPDATE tasks SET status = 'IN_PROGRESS',
              owner_id = (SELECT id FROM agents WHERE name = ?)
        WHERE local_id = ?`,
    ).run("w-precedence", "a");
    db.prepare("UPDATE agents SET status = 'needs_input', updated_at = ? WHERE name = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      "w-precedence",
    );
    const restoreWarn = setWaitStuckWarnForTests(() => {});
    const restoreSleep = setWaitSleepForTests(async () => {});
    try {
      class SentinelError extends Error {}
      const err = await waitForTasks(db, ["a"], {
        pollMs: 10,
        timeoutMs: 5000,
        stuckAfterMs: 1000,
        onStall: "exit",
        workstream: "test",
        beforePoll: async () => {
          throw new SentinelError("beforePoll-wins");
        },
      }).catch((e) => e);
      // beforePoll's throw escapes; stuck-check never runs.
      expect(err).toBeInstanceOf(SentinelError);
      expect((err as Error).message).toBe("beforePoll-wins");
    } finally {
      setWaitStuckWarnForTests(restoreWarn);
      setWaitSleepForTests(restoreSleep);
    }
  });

  it("stuckAfterMs=0 disables the stuck warning entirely", async () => {
    insertAgent(db, {
      name: "worker-stuck2",
      workstream: "test",
      paneId: "%100",
      status: "needs_input",
    });
    db.prepare(
      `UPDATE tasks SET status = 'IN_PROGRESS',
              owner_id = (SELECT id FROM agents WHERE name = ?),
              updated_at = ?
        WHERE local_id = ?`,
    ).run("worker-stuck2", new Date().toISOString(), "a");
    db.prepare("UPDATE agents SET status = 'needs_input', updated_at = ? WHERE name = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      "worker-stuck2",
    );

    const warnings: string[] = [];
    const restoreWarn = setWaitStuckWarnForTests((msg) => {
      warnings.push(msg);
    });
    const restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    try {
      const r = await waitForTasks(db, ["a"], {
        pollMs: 10,
        timeoutMs: 50,
        stuckAfterMs: 0,
        workstream: "test",
      });
      expect(r.timedOut).toBe(true);
      expect(r.refs[0]?.stuck).toBe(false);
      expect(warnings).toHaveLength(0);
    } finally {
      setWaitStuckWarnForTests(restoreWarn);
      setWaitSleepForTests(restoreSleep);
    }
  });
});
