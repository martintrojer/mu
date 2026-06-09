// mu — waitForAgents: block until agents finish working.
//
// The off-the-cuff / scratch pattern: spawn one or more task-less
// helpers, send them work, then wait until they're done before reading
// their output. Unlike `mu task wait` (which watches the task DAG),
// scratch/subagent flows have NO task to wait on — the only signal is
// the agent's own runtime status. This is that primitive.
//
// "Done" semantics (chosen in dogfood): an agent fires when it
// transitions **busy → any other state**. The agent MUST have been
// observed `busy` first, so a helper that is already idle when the wait
// starts does NOT instantly fire — the caller is waiting for *this*
// piece of work to finish, not for "is idle right now". An agent that
// never goes busy (e.g. the prompt didn't land) just keeps the wait
// pending until timeout, which is the honest outcome.
//
// Mirrors waitForTasks' shape: poll cadence + sleep test-seam, a
// beforePoll hook so the CLI can re-detect live status each tick
// without this SDK module importing tmux, --any/--all, and a timeout.
// The CLI wrapper maps the result to task-wait-symmetric exit codes.

import type { Db } from "../db.js";
import type { AgentStatus } from "../detect.js";
import { AgentNotFoundError } from "./errors.js";

// ─── Test seam: poll-sleep (mirrors waitForTasks / tmux setSleepForTests)
let currentWaitSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setAgentWaitSleepForTests(
  impl: ((ms: number) => Promise<void>) | undefined,
): (ms: number) => Promise<void> {
  const previous = currentWaitSleep;
  currentWaitSleep = impl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return previous;
}

/** A single agent the wait verb is watching. Each ref carries its own
 *  workstream so a cross-workstream wait can span sessions, mirroring
 *  TaskWaitRef. */
export interface AgentWaitRef {
  workstreamName: string;
  name: string;
}

/** Snapshot of one watched agent at a poll tick. Supplied by the
 *  caller's `readStatus` hook so this SDK stays free of tmux imports. */
export interface AgentStatusSnapshot {
  /** Current detected status, or null when the pane is gone (dead). */
  status: AgentStatus | null;
}

export interface AgentWaitOptions {
  /** When true, succeed as soon as ONE agent fires. Default false:
   *  every listed agent must fire. */
  any?: boolean;
  /** Maximum time to wait, in ms. Default 600_000 (10 min). 0 = forever. */
  timeoutMs?: number;
  /** Poll interval. Default 1000ms; overridable for tests. */
  pollMs?: number;
  /** Per-agent live-status reader, called once per agent per tick.
   *  The CLI implements this with capturePane + detectPiStatus; kept
   *  as a hook so this module never imports tmux/detect wiring beyond
   *  the AgentStatus type. Returning `status: null` means the pane is
   *  gone — the agent is treated as DEAD (see AgentWaitAgentState). */
  readStatus: (ref: AgentWaitRef) => Promise<AgentStatusSnapshot>;
}

export interface AgentWaitAgentState {
  workstreamName: string;
  name: string;
  /** Status at exit time (null = pane gone / dead). */
  status: AgentStatus | null;
  /** True once we observed this agent `busy` at any tick. */
  wasBusy: boolean;
  /** True when the agent fired: was busy, then moved to a non-busy
   *  live status. */
  fired: boolean;
  /** True when the agent's pane vanished mid-wait (capture returned
   *  null). Surfaced separately so the CLI can exit non-zero rather
   *  than treating a crash as a clean finish. */
  dead: boolean;
}

export interface AgentWaitResult {
  /** Per-agent state at exit, same order as input. */
  agents: AgentWaitAgentState[];
  /** True when we exited on the timeout, not because the condition met. */
  timedOut: boolean;
}

/**
 * Block until watched agents finish (busy → any other state).
 *
 * Pre-flight: every agent in `input` MUST exist; missing ones throw
 * AgentNotFoundError before any waiting begins (loud-fail; a typo'd
 * name silently waiting forever is the worst UX, mirrors waitForTasks).
 *
 * Returns the final per-agent state; the CLI decides exit codes
 * (0 met / 5 timeout / 6 a watched agent died).
 */
export async function waitForAgents(
  db: Db,
  input: readonly AgentWaitRef[],
  opts: AgentWaitOptions,
): Promise<AgentWaitResult> {
  if (input.length === 0) throw new Error("waitForAgents: refs must be non-empty");

  // Pre-flight existence check.
  for (const ref of input) {
    const row = db
      .prepare(
        `SELECT 1 FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id
          WHERE a.name = ? AND ws.name = ?`,
      )
      .get(ref.name, ref.workstreamName);
    if (row === undefined) throw new AgentNotFoundError(ref.name);
  }

  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const any = opts.any === true;
  const startedAt = Date.now();

  // Mutable per-agent tracking.
  const state: AgentWaitAgentState[] = input.map((ref) => ({
    workstreamName: ref.workstreamName,
    name: ref.name,
    status: null,
    wasBusy: false,
    fired: false,
    dead: false,
  }));

  const conditionMet = (): boolean => {
    const done = state.filter((s) => s.fired || s.dead);
    return any ? done.length > 0 : done.length === state.length;
  };

  // One detection pass over all not-yet-settled agents.
  const tick = async (): Promise<void> => {
    for (let i = 0; i < input.length; i++) {
      const st = state[i];
      const ref = input[i];
      if (st === undefined || ref === undefined) continue;
      if (st.fired || st.dead) continue;
      const snap = await opts.readStatus(ref);
      if (snap.status === null) {
        st.dead = true;
        st.status = null;
        continue;
      }
      st.status = snap.status;
      if (snap.status === "busy") {
        st.wasBusy = true;
      } else if (st.wasBusy) {
        // busy → any other state = fired.
        st.fired = true;
      }
    }
  };

  // Initial pass — seeds wasBusy for agents already busy; an agent that
  // is already idle here just sits pending (it must go busy first).
  await tick();
  if (conditionMet()) return { agents: state, timedOut: false };

  while (true) {
    const elapsed = Date.now() - startedAt;
    if (timeoutMs > 0 && elapsed >= timeoutMs) {
      return { agents: state, timedOut: true };
    }
    // Sleep, but never past the deadline (mirrors waitForTasks' clamp).
    const remaining = timeoutMs > 0 ? timeoutMs - elapsed : pollMs;
    await currentWaitSleep(Math.min(pollMs, remaining));
    await tick();
    if (conditionMet()) return { agents: state, timedOut: false };
  }
}
