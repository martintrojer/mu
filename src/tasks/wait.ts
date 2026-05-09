// mu — waitForTasks: block until tasks reach a target status.
//
// The orchestrator pattern: dispatch N workers via mu task claim --for,
// then wait until they're all done before reviewing/merging.
//
// Pre-existing alternatives + why this verb exists:
//
//   awk pipe over `mu log --tail`: works for ONE event but the
//     awk script becomes stateful (tracking 'which of N have closed?')
//     for multi-task waits. Bad shape for SKILL examples.
//   mu approve wait: same pattern but for approvals; this is the
//     symmetric verb for the task graph.
//
// Implementation mirrors waitApproval (in src/approvals.ts):
//
//   1. Initial check — if the wait condition is already satisfied,
//      exit immediately. No subscription needed.
//   2. Otherwise, poll the tasks table every pollMs. Same cadence as
//      mu log --tail (default 1000ms). We don't subscribe to
//      agent_logs because (a) we'd still need to re-query tasks to
//      learn the current status, (b) some status changes happen via
//      mu sql which doesn't emit events, and (c) the polling cost is
//      one indexed SELECT every second — cheaper than parsing the
//      log stream.
//   3. Exit on success (all/any reached) OR timeout. Caller maps
//      timeout to exit code 5 (mirrors mu approve wait).
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import type { Db } from "../db.js";
import { getTask } from "../tasks.js";
import { TaskNotFoundError } from "./errors.js";
import type { TaskStatus } from "./status.js";

// ─── Test seam: poll-sleep + poll counter ──────────────────────────────
//
// Mirror src/tmux.ts's setSleepForTests pattern. Default sleep is a real
// setTimeout; tests can swap in an instant + counted version to assert
// poll cadence (the bug fixed alongside this hook silently sleeps a full
// pollMs past the deadline when pollMs > timeoutMs — see test/tasks.test.ts
// 'waitForTasks' regression cases).

let currentWaitSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
let pollCount = 0;

export function setWaitSleepForTests(
  impl: ((ms: number) => Promise<void>) | undefined,
): (ms: number) => Promise<void> {
  const previous = currentWaitSleep;
  currentWaitSleep = impl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return previous;
}

/** Total number of polls performed across all `waitForTasks` calls in this
 *  process. Tests typically reset before exercising and read after. */
export function getWaitPollCount(): number {
  return pollCount;
}

export function resetWaitPollCount(): void {
  pollCount = 0;
}

export interface TaskWaitOptions {
  /** Target status. Default 'CLOSED'. */
  status?: TaskStatus;
  /** When true, succeed as soon as ONE listed task reaches the target.
   *  Default false: every listed task must reach the target. */
  any?: boolean;
  /** Maximum time to wait, in milliseconds. Default 600_000 (10 min).
   *  Pass 0 to wait forever. */
  timeoutMs?: number;
  /** Polling interval. Default 1000ms; overridable for tests. */
  pollMs?: number;
}

export interface TaskWaitTaskState {
  /** The task's local_id. */
  localId: string;
  /** Current status (at the moment we exit). */
  status: TaskStatus;
  /** True when this task's status equals the target. */
  reachedTarget: boolean;
}

export interface TaskWaitResult {
  /** Per-task state at exit time. Same length and order as the input list. */
  tasks: TaskWaitTaskState[];
  /** True when EVERY task reached the target (the --all condition). */
  allReached: boolean;
  /** True when AT LEAST ONE task reached the target (the --any condition). */
  anyReached: boolean;
  /** Wall-clock time spent waiting, in ms (always >= 0). */
  elapsedMs: number;
  /** True when we exited because of the timeout, not because the wait
   *  condition was met. allReached / anyReached can still be true on
   *  partial progress when timedOut is true. */
  timedOut: boolean;
}

/**
 * Block until a set of tasks reaches `opts.status` (default CLOSED).
 * Returns a result describing the final state — the caller decides
 * whether to treat partial-progress timeouts as success or failure
 * (the CLI maps a clean exit to 0, a timeout to 5).
 *
 * Pre-flight: every task in `localIds` MUST exist; missing ones throw
 * TaskNotFoundError before any waiting begins. This is loud-fail by
 * design — a typo'd id silently waiting forever is the worst-case UX.
 */
export async function waitForTasks(
  db: Db,
  localIds: readonly string[],
  opts: TaskWaitOptions = {},
): Promise<TaskWaitResult> {
  if (localIds.length === 0) {
    throw new Error("waitForTasks: localIds must be non-empty");
  }
  const target: TaskStatus = opts.status ?? "CLOSED";
  const wantAny = opts.any === true;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  const startedAt = Date.now();

  // Pre-flight: every id must exist.
  for (const id of localIds) {
    if (getTask(db, id) === undefined) throw new TaskNotFoundError(id);
  }

  /** Read current state of all tasks; returns the result shape. */
  const snapshot = (): TaskWaitResult => {
    const tasks: TaskWaitTaskState[] = localIds.map((id) => {
      const row = getTask(db, id);
      // Defensive: if a task was deleted mid-wait, treat as 'never
      // reached'. (Not the same as TaskNotFoundError pre-flight —
      // deletion mid-wait shouldn't crash the wait; it's a legitimate
      // state change.)
      const status = (row?.status ?? "OPEN") as TaskStatus;
      return { localId: id, status, reachedTarget: status === target };
    });
    const reachedCount = tasks.filter((t) => t.reachedTarget).length;
    return {
      tasks,
      allReached: reachedCount === tasks.length,
      anyReached: reachedCount > 0,
      elapsedMs: Date.now() - startedAt,
      timedOut: false,
    };
  };

  /** Has the wait condition been met? */
  const isDone = (snap: TaskWaitResult): boolean => (wantAny ? snap.anyReached : snap.allReached);

  // Initial check: maybe we're already done.
  let snap = snapshot();
  if (isDone(snap)) return snap;

  // Poll loop.
  //
  // Sleep is clamped to `min(pollMs, deadline - now)` so the function
  // returns within `timeoutMs + small slack`, never `pollMs` later.
  // Without the clamp, `pollMs=10000, timeoutMs=100` sleeps a full 10s
  // before noticing the deadline expired. When the clamp goes <= 0 we
  // skip the sleep entirely and re-snapshot before bailing on the
  // timeout — gives the wait one last chance at a winning state right
  // at the deadline boundary, and avoids passing 0 / negatives to
  // setTimeout (which has implementation-defined behaviour).
  for (;;) {
    const now = Date.now();
    if (now >= deadline) {
      return { ...snap, timedOut: true };
    }
    const sleepMs =
      deadline === Number.POSITIVE_INFINITY ? pollMs : Math.min(pollMs, deadline - now);
    if (sleepMs > 0) {
      await currentWaitSleep(sleepMs);
    }
    pollCount += 1;
    snap = snapshot();
    if (isDone(snap)) return snap;
  }
}
