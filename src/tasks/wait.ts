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
//
// Implementation:
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
//      timeout to exit code 5.
//
// Extracted from src/tasks.ts as part of refactor_split_large_src_files.

import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { getTask } from "../tasks.js";
import { StallDetectedDuringWaitError, TaskNotFoundError } from "./errors.js";
import type { TaskStatus } from "./status.js";

// ─── Test seams: poll-sleep + poll counter + stuck-warn writer ─────────
//
// Mirror src/tmux.ts's setSleepForTests pattern. Default sleep is a real
// setTimeout; tests can swap in an instant + counted version to assert
// poll cadence (the bug fixed alongside this hook silently sleeps a full
// pollMs past the deadline when pollMs > timeoutMs — see test/tasks.test.ts
// 'waitForTasks' regression cases).
//
// The stuck-warn writer is the second seam: agent_close_discipline_gap
// added a per-poll "this task is IN_PROGRESS but owner is needs_input
// for too long" warning emitted to stderr; tests intercept it via
// setWaitStuckWarnForTests so they can assert exactly-once dedupe
// without scraping process.stderr.

let currentWaitSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
let pollCount = 0;
const defaultStuckWarn: (msg: string) => void = (msg) => {
  process.stderr.write(msg);
};
let currentStuckWarn: (msg: string) => void = defaultStuckWarn;

export function setWaitSleepForTests(
  impl: ((ms: number) => Promise<void>) | undefined,
): (ms: number) => Promise<void> {
  const previous = currentWaitSleep;
  currentWaitSleep = impl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return previous;
}

/** Test seam: swap the stderr writer used by the stuck-task warning so
 *  unit tests can capture warnings without spying on process.stderr. */
export function setWaitStuckWarnForTests(
  impl: ((msg: string) => void) | undefined,
): (msg: string) => void {
  const previous = currentStuckWarn;
  currentStuckWarn = impl ?? defaultStuckWarn;
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

/** A single task ref the wait verb is watching. Cross-workstream
 *  waits arrive as a heterogeneous list of (workstream, name) pairs;
 *  the legacy single-workstream call passes the same workstream on
 *  every ref. task_wait_cross_workstream. */
export interface TaskWaitRef {
  /** The workstream the task lives in. Each ref carries its own so
   *  the SDK doesn't need a single "the workstream" — cross-ws waits
   *  pass refs from multiple workstreams in one call. */
  workstreamName: string;
  /** The task's per-workstream-unique local id. */
  name: string;
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
  /** Workstream context applied to bare-string ids. Required when the
   *  caller passes `string[]`; ignored when the caller passes
   *  `TaskWaitRef[]` (each ref carries its own ws). The legacy
   *  single-ws SDK call site keeps its today's shape; the cross-ws
   *  callers (CLI verb) pass `TaskWaitRef[]` and omit `workstream`.
   *  task_wait_cross_workstream. */
  workstream?: string;
  /** Emit a yellow STUCK warning to stderr (once per task per wait call)
   *  when an IN_PROGRESS task's owner has been in `needs_input` for at
   *  least this many milliseconds since the agent row's last update.
   *  Default 300_000 (5 min). Pass 0 to disable.
   *
   *  Surfaced by agent_close_discipline_gap in mufeedback: workers
   *  occasionally finish + commit + go idle without running
   *  `mu task close <id>`, leaving wait blocked indefinitely. The
   *  warning is observation-only — wait keeps polling so the operator
   *  (or a wrapping policy) decides whether to force-close, re-prompt,
   *  or escalate. */
  stuckAfterMs?: number;
  /** What to do when the `--stuck-after` predicate fires on a watched
   *  task. `'warn'` (default) = today's behaviour: yellow STUCK line
   *  to stderr (deduped per task per wait call) + corroborating
   *  `kind='event'` agent_logs row; wait keeps polling. `'exit'` =
   *  same emit + persist, but THEN throw `StallDetectedDuringWaitError`
   *  so the CLI wrapper exits 7 (STALL_DETECTED). The exit-action is
   *  the unattended-orchestrator escape: a wrapping policy can branch
   *  on 7 (idle, ambiguous — operator decides poke vs release) vs 6
   *  (dead pane, unambiguous — re-dispatch).
   *
   *  Carve-out (lives at the call site, not here): the CLI passes
   *  `'exit'` only when the wait target is CLOSED — mirrors exit-6's
   *  reaper-flip suppression. With `--status OPEN` the worker reaching
   *  needs_input might BE the success path. See
   *  task_wait_stall_action_flag. */
  onStall?: "warn" | "exit";
  /** Optional async hook run BEFORE every snapshot (initial + each
   *  poll iteration). The CLI uses this to reconcile the workstream
   *  each tick (reaper flips IN_PROGRESS → OPEN for dead-pane
   *  workers) and to throw a typed error when a reaper-flip on a
   *  watched task should abandon the wait — see
   *  task_wait_reconcile_dead_panes. Throwing from `beforePoll`
   *  propagates out of `waitForTasks` unchanged.
   *
   *  Kept as a generic seam (not a `--reconcile`-shaped option) so
   *  the SDK module stays free of tmux/reconcile imports — that
   *  layering belongs above the SDK in the CLI wrapper. */
  beforePoll?: () => Promise<void>;
}

export interface TaskWaitTaskState {
  /** The workstream this task lives in. Cross-workstream waits
   *  return a mixed list; the workstream is part of identity.
   *  task_wait_cross_workstream. */
  workstreamName: string;
  /** The task's per-workstream-unique name. */
  name: string;
  /** Current status (at the moment we exit). */
  status: TaskStatus;
  /** Owner at exit time (NULL when unowned, after release, or after
   *  the reaper flipped IN_PROGRESS → OPEN due to a dead pane). */
  owner: string | null;
  /** True when this task's status equals the target. */
  reachedTarget: boolean;
  /** True when the task is IN_PROGRESS, owned by a registered agent
   *  whose detected status is `needs_input` for >= `stuckAfterMs`.
   *  Surfaces the agent_close_discipline_gap pattern: worker finished +
   *  committed but skipped `mu task close <id>`. Backwards-compatible
   *  signal — callers ignoring it see no behaviour change. */
  stuck: boolean;
}

export interface TaskWaitResult {
  /** Per-task state at exit time. Same length and order as the input
   *  list. The caller derives all-reached / any-reached / elapsed
   *  from this list (count `r.reachedTarget`) and from its own
   *  startedAt clock — keeping the SDK return minimal. */
  refs: TaskWaitTaskState[];
  /** True when we exited because of the timeout, not because the wait
   *  condition was met. Refs that did reach the target are still
   *  reflected in `refs[i].reachedTarget` on partial-progress timeout. */
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
  input: readonly TaskWaitRef[] | readonly string[],
  opts: TaskWaitOptions,
): Promise<TaskWaitResult> {
  if (input.length === 0) {
    throw new Error("waitForTasks: refs must be non-empty");
  }
  // Normalise to TaskWaitRef[]. The string[] shape preserves today's
  // single-workstream SDK contract (callers pass `workstream` on
  // opts); the TaskWaitRef[] shape carries its own ws per ref so
  // cross-workstream waits don't need a sentinel.
  const refs: readonly TaskWaitRef[] = input.map((entry) => {
    if (typeof entry === "string") {
      if (opts.workstream === undefined)
        throw new Error(
          "waitForTasks: string ids require opts.workstream; pass TaskWaitRef[] for cross-workstream waits",
        );
      return { workstreamName: opts.workstream, name: entry };
    }
    return entry;
  });
  const target: TaskStatus = opts.status ?? "CLOSED";
  const wantAny = opts.any === true;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 1000;
  const stuckAfterMs = opts.stuckAfterMs ?? 300_000;
  const onStall: "warn" | "exit" = opts.onStall ?? "warn";
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;

  // Pre-flight: every ref must exist in its own workstream scope.
  // Cross-workstream waits validate each ref against its declared ws
  // — a typo in the workstream half of `<ws>/<name>` should land here
  // with a clear TaskNotFoundError, not silently wait forever.
  for (const ref of refs) {
    if (getTask(db, ref.name, ref.workstreamName) === undefined)
      throw new TaskNotFoundError(`${ref.workstreamName}/${ref.name}`);
  }

  // Per-(ws,name) dedupe: emit the STUCK warning at most ONCE per wait
  // call, not once per poll cycle. Operators don't want their stderr
  // filled with the same yellow line every second; one nudge is enough.
  const stuckWarned = new Set<string>();
  const refKey = (ref: TaskWaitRef): string => `${ref.workstreamName}/${ref.name}`;

  /**
   * Detect the agent_close_discipline_gap pattern for one task:
   * IN_PROGRESS in the DB, owned by a registered agent whose status
   * is `needs_input` and whose `updated_at` is older than
   * `stuckAfterMs`. We query agents directly (not via getAgent) to
   * avoid an import cycle (src/agents.ts already imports from
   * src/tasks.ts).
   */
  const isStuck = (status: TaskStatus, owner: string | null, workstream: string): boolean => {
    if (stuckAfterMs <= 0) return false;
    if (status !== "IN_PROGRESS" || !owner) return false;
    // owner is the operator-facing agent name; agents.name is
    // per-workstream unique in v5. Scope the lookup by workstream so
    // a same-named worker elsewhere doesn't spuriously mark this task
    // stuck.
    const row = db
      .prepare(
        `SELECT a.status AS status, a.updated_at AS updated_at
           FROM agents a
           JOIN workstreams ws ON ws.id = a.workstream_id
          WHERE a.name = ? AND ws.name = ?`,
      )
      .get(owner, workstream) as { status: string; updated_at: string } | undefined;
    if (!row || row.status !== "needs_input") return false;
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    return ageMs >= stuckAfterMs;
  };

  /** Read current state of all tasks; returns the result shape. */
  const snapshot = (): TaskWaitResult => {
    const refStates: TaskWaitTaskState[] = refs.map((ref) => {
      const row = getTask(db, ref.name, ref.workstreamName);
      // Defensive: if a task was deleted mid-wait, treat as 'never
      // reached'. (Not the same as TaskNotFoundError pre-flight —
      // deletion mid-wait shouldn't crash the wait; it's a legitimate
      // state change.)
      const status = (row?.status ?? "OPEN") as TaskStatus;
      const owner = row?.ownerName ?? null;
      const stuck = isStuck(status, owner, ref.workstreamName);
      const key = refKey(ref);
      if (stuck && !stuckWarned.has(key)) {
        stuckWarned.add(key);
        // Yellow ANSI escape inline (no picocolors import — keeps the
        // SDK module dep-free; the CLI layer already pulls picocolors).
        // The message is one line, prefixed with `mu task wait:` so
        // log greppers can target it. Cross-ws waits include the
        // qualified `<ws>/<name>` so the operator sees which.
        currentStuckWarn(
          `\x1b[33mmu task wait: ${key} stuck — owner=${owner ?? "<none>"} in needs_input ` +
            `(>= ${stuckAfterMs}ms since last status change). ` +
            `Worker likely committed but skipped \`mu task close ${ref.name}\`.\x1b[0m\n`,
        );
        // Persist a corroborating kind='event' row so other consumers
        // (mu state, mu log --kind event, dashboards) see the same
        // signal that the new derived `idle` flag surfaces in the
        // agents table. The stderr warning stays — observation-only,
        // operator decides recovery. See idle_assigned_agent_detection.
        const ageSecs = Math.round(stuckAfterMs / 1000);
        emitEvent(
          db,
          ref.workstreamName,
          `agent stalled ${owner ?? "<none>"} owns ${ref.name} for ${ageSecs}s`,
          owner ?? "system",
        );
        // task_wait_stall_action_flag: with `--on-stall exit` (the
        // unattended-orchestrator escape), the same emit + persist
        // happens but we then throw — the CLI's classifyError maps
        // this to exit code 7 (STALL_DETECTED). The carve-out
        // (target=CLOSED only) lives at the call site: the CLI
        // wrapper passes `onStall: 'exit'` only when target=CLOSED.
        // Precedence vs exit-6 (dead pane): the reaper-flip check
        // throws inside `beforePoll` BEFORE snapshot() runs, so a
        // watched task that's both reaper-flipped AND stale never
        // reaches this branch (status would already be OPEN).
        if (onStall === "exit") {
          throw new StallDetectedDuringWaitError(ref.name, owner, ref.workstreamName, ageSecs);
        }
      }
      return {
        workstreamName: ref.workstreamName,
        name: ref.name,
        status,
        owner,
        reachedTarget: status === target,
        stuck,
      };
    });
    return {
      refs: refStates,
      timedOut: false,
    };
  };

  /** Has the wait condition been met? */
  const isDone = (snap: TaskWaitResult): boolean => {
    const reached = snap.refs.filter((r) => r.reachedTarget).length;
    return wantAny ? reached > 0 : reached === snap.refs.length;
  };

  // Initial check: maybe we're already done. Run beforePoll first so
  // the CLI's per-poll reconcile (task_wait_reconcile_dead_panes) runs
  // even on the immediate-exit path — a dead-pane worker that died
  // BEFORE the operator typed `mu task wait` should still fail fast.
  if (opts.beforePoll) await opts.beforePoll();
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
    if (opts.beforePoll) await opts.beforePoll();
    snap = snapshot();
    if (isDone(snap)) return snap;
  }
}
