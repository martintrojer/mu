// mu — `mu task` ownership + synchronisation verbs (claim / release / wait).
//
// claim   → CAS-style ownership transfer; dispatch via --for or
//           anonymous --self (owner stays NULL, actor in agent_logs).
// release → clears owner; auto-flips IN_PROGRESS → OPEN; --reopen
//           forces OPEN from CLOSED/REJECTED/DEFERRED.
// wait    → polls until the listed tasks reach --status (default
//           CLOSED). Exit 0 = met; exit 5 = timeout.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import { refreshAgentTitle } from "../../agents.js";
import { AgentNotFoundError } from "../../agents/errors.js";
import {
  UsageError,
  assertTaskInWorkstream,
  emitJson,
  parseQualifiedRef,
  parseStatusOption,
  resolveEntityRef,
  resolveWorkstream,
} from "../../cli.js";
import { type Db, WorkstreamNotFoundError, tryResolveWorkstreamId } from "../../db.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import { reconcile } from "../../reconcile.js";
import {
  ReaperDetectedDuringWaitError,
  TaskNotFoundError,
  type TaskWaitRef,
  type TaskWaitResult,
  type TaskWaitTaskState,
  claimTask,
  getTask,
  releaseTask,
  waitForTasks,
} from "../../tasks.js";

export async function cmdTaskRelease(
  db: Db,
  rawId: string,
  opts: { reopen?: boolean; evidence?: string; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const sdkOpts: { reopen: boolean; evidence?: string; workstream: string } = {
    reopen: opts.reopen ?? false,
    workstream: ws,
  };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const r = releaseTask(db, localId, sdkOpts);
  // Title push for the agent that just lost the task. Prev-owner could
  // be null (anonymous claim release — nothing to refresh).
  if (r.previousOwnerName) await refreshAgentTitle(db, r.previousOwnerName, ws);
  const nextSteps: NextStep[] = [
    {
      intent: "Reclaim",
      command: `mu task claim ${localId} -w ${ws}  (--self / --for <worker>)`,
    },
    { intent: "Show current state", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already unowned (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  const ownerBit = r.previousOwnerName ? `was ${pc.bold(r.previousOwnerName)}` : "was unowned";
  const statusBit = r.previousStatus !== r.status ? ` (${r.previousStatus} → ${r.status})` : "";
  console.log(`Released ${pc.bold(localId)} ${pc.dim(`(${ownerBit})${statusBit}`)}`);
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
  printNextSteps(nextSteps);
}

export async function cmdClaim(
  db: Db,
  rawId: string,
  opts: {
    for?: string;
    self?: boolean;
    actor?: string;
    evidence?: string;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  if (opts.self === true && opts.for !== undefined) {
    throw new UsageError("--self and --for are mutually exclusive");
  }
  if (opts.actor !== undefined && opts.self !== true) {
    throw new UsageError("--actor only meaningful with --self (it overrides the actor name)");
  }
  // Parse `--for` for an optional qualified ref: bare `<name>`
  // resolves the agent in the task's workstream (today); qualified
  // `<workstream>/<name>` resolves the agent in its own workstream
  // and dispatches across the workstream boundary
  // (task_claim_for_cross_workstream).
  let forName: string | undefined;
  let forWorkstream: string | undefined;
  if (opts.for !== undefined) {
    const parsed = parseQualifiedRef(opts.for);
    forName = parsed.name;
    if (parsed.workstream !== undefined) {
      forWorkstream = parsed.workstream;
      // Pre-flight: workstream must exist (typed error so the operator
      // sees the canonical exit-3 mapping instead of a bare
      // ClaimerNotRegisteredError pointing at the wrong cause).
      if (tryResolveWorkstreamId(db, forWorkstream) === null) {
        throw new WorkstreamNotFoundError(forWorkstream);
      }
      // Pre-flight: agent must exist in that workstream. Without this
      // the SDK surfaces ClaimerNotRegisteredError (the bare-name
      // shape) which doesn't carry the qualifying workstream context
      // — AgentNotFoundError(name, workstream) is the right shape for
      // the cross-ws path.
      const wsId = tryResolveWorkstreamId(db, forWorkstream);
      if (wsId !== null) {
        const row = db
          .prepare("SELECT 1 FROM agents WHERE name = ? AND workstream_id = ?")
          .get(forName, wsId);
        if (!row) throw new AgentNotFoundError(forName, forWorkstream);
      }
    }
  }
  const sdkOpts: {
    agentName?: string;
    agentWorkstream?: string;
    self?: boolean;
    actor?: string;
    evidence?: string;
    workstream: string;
  } = { workstream: ws };
  if (forName !== undefined) sdkOpts.agentName = forName;
  if (forWorkstream !== undefined) sdkOpts.agentWorkstream = forWorkstream;
  if (opts.self) sdkOpts.self = true;
  if (opts.actor !== undefined) sdkOpts.actor = opts.actor;
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const result = await claimTask(db, localId, sdkOpts);
  // Title push for the new owner. Anonymous claims (--self) leave
  // owner=null — nothing to refresh. Refresh in the agent's OWN
  // workstream (forWorkstream when the dispatch was cross-ws), not
  // the task's — the agent row only exists in its own workstream.
  if (result.ownerName) {
    await refreshAgentTitle(db, result.ownerName, forWorkstream ?? ws);
  }
  const nextSteps: NextStep[] = [
    {
      // Single-quoted example: shell metachars (`...`, $VAR, $(...))
      // inside a double-quoted string expand in YOUR shell before mu
      // sees the note (mufeedback note #257). Single quotes defer
      // expansion to the agent.
      intent: "Drop a note (single-quote to defer shell expansion)",
      command: `mu task note ${localId} 'FILES: ...\\nDECISION: ...' -w ${ws}`,
    },
    {
      intent: "Close with grounding",
      command: `mu task close ${localId} --evidence "..." -w ${ws}`,
    },
    { intent: "Release if blocked", command: `mu task release ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ ...result, nextSteps });
    return;
  }
  if (result.ownerName === null) {
    console.log(
      `Claimed ${pc.bold(localId)} ${pc.dim(`(--self by ${result.actorName}; ${result.previousStatus} → ${result.status}; owner=NULL)`)}`,
    );
  } else {
    console.log(
      `Claimed ${pc.bold(localId)} for ${pc.bold(result.ownerName)} ${pc.dim(`(${result.previousStatus} → ${result.status})`)}`,
    );
  }
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
  printNextSteps(nextSteps);
}

/** Qualified id `<ws>/<name>` for a watched ref — used in messages,
 *  --json output, and stuck-task hints. */
function qualifiedId(ref: { workstreamName: string; name: string }): string {
  return `${ref.workstreamName}/${ref.name}`;
}

/** Resolve a single `<ws>/<name>` or bare id into a TaskWaitRef.
 *  - Qualified refs use their prefix; -w is NOT consulted (so a
 *    cross-workstream wait can name two different workstreams).
 *  - Bare refs fall back to the standard chain via resolveWorkstream.
 *  - When neither qualifier nor -w/MU_SESSION/tmux session resolves a
 *    workstream for a bare ref, surface the canonical UsageError from
 *    resolveWorkstream so the operator gets the same diagnostic as
 *    every other task verb.
 *  - Existence is asserted up-front: a typo in either half throws
 *    TaskNotFoundError listing the qualified form. (waitForTasks
 *    repeats this check; we duplicate here so the error names the
 *    raw arg the operator typed, not the normalised internal form.)
 */
async function resolveWaitRef(
  db: Db,
  raw: string,
  fallbackWs: string | undefined,
): Promise<TaskWaitRef> {
  const parsed = parseQualifiedRef(raw);
  let workstreamName: string;
  if (parsed.workstream !== undefined) {
    workstreamName = parsed.workstream;
  } else {
    // Bare ref — use the standard chain (--workstream / $MU_SESSION /
    // tmux session). resolveWorkstream throws UsageError if none of
    // those resolve, which is the same error operators see today on
    // every other task verb.
    workstreamName = await resolveWorkstream(fallbackWs);
  }
  if (getTask(db, parsed.name, workstreamName) === undefined) {
    // Use the raw form (qualified or bare) so the error message
    // matches what the operator typed.
    throw new TaskNotFoundError(parsed.workstream !== undefined ? raw : parsed.name);
  }
  return { workstreamName, name: parsed.name };
}

export async function cmdTaskWait(
  db: Db,
  ids: readonly string[],
  opts: {
    status?: string;
    any?: boolean;
    /** --first is a CLI alias for --any with a richer return shape
     *  (prints the firing ref's qualified id; --json gains a
     *  `firing` field). task_wait_cross_workstream. */
    first?: boolean;
    timeout?: number;
    stuckAfter?: number;
    onStall?: "warn" | "exit";
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  if (ids.length === 0) {
    throw new UsageError("mu task wait: at least one task id is required");
  }
  // task_wait_stall_action_flag: validate --on-stall up-front so a
  // typo errors loud at the verb boundary instead of being silently
  // ignored by the SDK. Default 'warn' (today's behaviour).
  const onStallRaw = opts.onStall ?? "warn";
  if (onStallRaw !== "warn" && onStallRaw !== "exit") {
    throw new UsageError(`--on-stall: expected 'warn' or 'exit', got '${onStallRaw}'`);
  }
  // Validate status (default CLOSED). Same parser as mu task list --status.
  const statusOpt = opts.status !== undefined ? parseStatusOption(opts.status) : undefined;

  // --first is a CLI alias for --any (same exit-condition; differs
  // only in output shape: --first emphasises WHICH ref fired so the
  // operator can pipe the qualified id into the next step).
  const wantAny = opts.any === true || opts.first === true;
  // emphasise WHICH ref fired in stdout / --json (today's --any kept
  // the per-task list as-is).
  const wantFirstShape = opts.first === true || opts.any === true;

  // Resolve every ref — cross-workstream-aware. Each ref carries its
  // own workstream so the wait set can span multiple workstreams.
  // Pre-flight existence check is inside resolveWaitRef; failures
  // throw before any waiting begins.
  const refs: TaskWaitRef[] = [];
  for (const id of ids) {
    refs.push(await resolveWaitRef(db, id, opts.workstream));
  }
  // Workstream set: every workstream we'll reconcile per poll. May be
  // 1 (legacy single-ws wait) or N (cross-ws). Used both for the
  // reconcile-each-poll path and for the human output below.
  const workstreamSet = new Set(refs.map((r) => r.workstreamName));

  // --timeout in seconds for shell ergonomics; SDK takes ms.
  // 0 in the SDK = wait forever; same convention here.
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : 600_000;
  // --stuck-after also in seconds; 0 disables. Default mirrors the SDK.
  const stuckAfterMs = opts.stuckAfter !== undefined ? opts.stuckAfter * 1000 : 300_000;

  const sdkOpts: {
    status?: TaskWaitResult["tasks"][number]["status"];
    any?: boolean;
    timeoutMs: number;
    stuckAfterMs: number;
    onStall?: "warn" | "exit";
    beforePoll?: () => Promise<void>;
  } = { timeoutMs, stuckAfterMs };
  if (statusOpt !== undefined) sdkOpts.status = statusOpt;
  if (wantAny) sdkOpts.any = true;

  // task_wait_reconcile_dead_panes (extended for cross-workstream by
  // task_wait_cross_workstream): per-poll reconcile + reaper-flip
  // detection. We keep a snapshot of each watched task's prior
  // (status, owner) so that AFTER reconcile (which may have flipped
  // IN_PROGRESS → OPEN for a dead-pane worker) we can spot the
  // transition and abort with exit 6 instead of running out the
  // operator's --timeout.
  //
  //   - Reconcile runs on EVERY poll regardless of target, and once
  //     per workstream in the wait set (NOT just the resolved -w —
  //     cross-ws waits span multiple workstreams). The reaper is
  //     exactly what we want to fire, and it only does so during a
  //     `"full"` reconcile (the prune deletes the agent row which
  //     triggers the IN_PROGRESS → OPEN flip).
  //   - Exit-6 suppression: only when the wait target is CLOSED.
  //     Other targets treat reaper-flip as a legitimate state change
  //     (target=OPEN: it's the success; target=IN_PROGRESS: an
  //     operator polling for the next worker to claim doesn't want
  //     a dead predecessor to abort their wait).
  //   - Cross-ws scoping: a reaper-flip in workstream B while we're
  //     waiting on A's task does NOT trigger exit 6 — the
  //     priorState/check loop runs ONLY over the watched refs. A
  //     reconcile of B is harmless to A's wait.
  //   - First-iteration coverage: beforePoll runs BEFORE the initial
  //     snapshot too (waitForTasks contract), so a worker that died
  //     BEFORE the operator typed `mu task wait` still triggers exit
  //     6 on the first tick.
  const target = statusOpt ?? "CLOSED";
  const reaperExitEnabled = target === "CLOSED";
  // task_wait_stall_action_flag: same target=CLOSED carve-out as
  // exit-6's reaper-flip suppression. With --status OPEN/IN_PROGRESS
  // the worker reaching needs_input might BE the success path —
  // exiting on stall would race the wait-condition check. Operators
  // who pass --on-stall exit + --status OPEN get warn-only behaviour
  // (the SDK still emits the stderr warning + agent_logs event).
  if (onStallRaw === "exit" && target === "CLOSED") sdkOpts.onStall = "exit";
  const priorState = new Map<string, { status: string; owner: string | null }>();
  sdkOpts.beforePoll = async () => {
    // Reconcile each unique workstream in the wait set. Each call is
    // a cheap (~few ms) tmux list-panes + per-survivor capture-pane.
    // "status-only" mode would skip the prune — but the prune is
    // exactly what fires the reaper that flips the task. Use
    // "full" mode so dead panes get cleaned up AND the reaper runs.
    for (const wsName of workstreamSet) {
      try {
        await reconcile(db, { workstream: wsName, mode: "full" });
      } catch {
        // Tmux substrate hiccup mid-wait: don't crash the wait. The
        // next iteration retries; the exit-6 path stays correct
        // because the prior-state map only fires on a real flip we
        // observed.
      }
    }
    if (!reaperExitEnabled) return;
    for (const ref of refs) {
      const key = qualifiedId(ref);
      const row = getTask(db, ref.name, ref.workstreamName);
      const status = row?.status ?? "OPEN";
      const owner = row?.ownerName ?? null;
      const prior = priorState.get(key);
      if (prior !== undefined && prior.status === "IN_PROGRESS" && status === "OPEN") {
        // Reaper-flip detected on a watched task. The prior owner
        // is the agent whose pane just got pruned (the FK
        // CASCADE-SET-NULL on agents.id has already cleared the
        // current row's owner; we use the snapshot from the
        // previous tick).
        throw new ReaperDetectedDuringWaitError(ref.name, prior.owner, ref.workstreamName);
      }
      priorState.set(key, { status, owner });
    }
  };

  const result = await waitForTasks(db, refs, sdkOpts);

  // ─── WHICH-result shaping ────────────────────────────────────────
  // "firing" = the first ref that reached the target on the closing
  // snapshot, for --first / --any. NULL on --all (every ref reached;
  // no "first" to single out) and on timeout (nothing reached).
  // The order matches the input refs order; tie-breaks by argv.
  const firingRef: TaskWaitTaskState | null =
    wantFirstShape && !result.timedOut ? (result.tasks.find((t) => t.reachedTarget) ?? null) : null;
  const reachedRefs = result.tasks.filter((t) => t.reachedTarget);
  const unmetRefs = result.tasks.filter((t) => !t.reachedTarget);

  // Build nextSteps. The structure differs by exit shape:
  //   - --first / --any success: name the firing ref, suggest
  //     cherry-pick + verify + free + recreate (the dispatch-pipeline
  //     recipe). The cherry-pick command uses the firing ref's owner
  //     as the worker name when known.
  //   - --all success: list closed refs, suggest verify.
  //   - timeout / partial: list unmet refs, suggest mu task show.
  const nextSteps: NextStep[] = [];
  if (!result.timedOut && firingRef !== null) {
    const owner = firingRef.owner;
    if (owner !== null) {
      // Workspace path lookup is per-owner; the cherry-pick command
      // captures HEAD from the worker's workspace and applies it to
      // the orchestrator's repo. `mu workspace path` prints just the
      // path on stdout (no JSON needed), so we wrap it in $(cd $(...)
      // && git log -1) for the HEAD lookup. Operator copy-pastes;
      // the deferred shell expansion is handled by the operator's
      // shell, not ours.
      nextSteps.push({
        intent: `Cherry-pick ${owner}'s HEAD onto your branch`,
        command: `git cherry-pick $(cd $(mu workspace path ${owner} -w ${firingRef.workstreamName}) && git log -1 --format=%H)`,
      });
    }
    nextSteps.push({
      intent: "Verify the cherry-pick",
      command: "npm run typecheck && npm run lint && npm run test && npm run build",
    });
    if (owner !== null) {
      nextSteps.push({
        intent: `Free + recreate ${owner}'s workspace for the next dispatch`,
        command: `mu workspace free ${owner} -w ${firingRef.workstreamName} && mu workspace create ${owner} -w ${firingRef.workstreamName}`,
      });
    }
  } else if (!result.timedOut && wantFirstShape === false) {
    // --all success path — every ref reached. No single "firing"
    // worker to cherry-pick; the operator presumably already
    // picked along the way (or runs a single verify here).
    nextSteps.push({
      intent: "Verify the merged work",
      command: "npm run typecheck && npm run lint && npm run test && npm run build",
    });
  }
  for (const t of unmetRefs) {
    nextSteps.push({
      intent: `Investigate ${qualifiedId(t)} (status=${t.status})`,
      command: `mu task show ${t.name} -w ${t.workstreamName}`,
    });
  }
  if (!result.timedOut) {
    // Surface the next-ready hint for each workstream we waited on —
    // a cross-ws operator wants both `mu task next` candidates.
    for (const wsName of workstreamSet) {
      nextSteps.push({
        intent: `Pick the next ready task in ${wsName}`,
        command: `mu task next -w ${wsName}`,
      });
    }
  }

  if (opts.json) {
    // JSON shape (task_wait_cross_workstream):
    //   firing    — the first ref to reach target on --first/--any,
    //              else null. { workstreamName, name, status }.
    //   all       — per-ref state for refs that reached target.
    //   timedOut  — per-ref state for refs that did NOT reach target.
    //              On the success path this is [].
    // The legacy `tasks`/`allReached`/`anyReached`/`elapsedMs`/
    // `timedOut` fields stay (back-compat for any caller pinned to
    // the prior shape).
    const firingJson =
      firingRef === null
        ? null
        : {
            workstreamName: firingRef.workstreamName,
            name: firingRef.name,
            qualifiedId: qualifiedId(firingRef),
            status: firingRef.status,
            owner: firingRef.owner,
          };
    // The JSON shape for the cross-ws + WHICH design is:
    //   firing   — the firing ref on --first/--any success, else null
    //   all      — refs that REACHED target (on success: every ref for
    //              --all; the firing ref for --first/--any. On partial
    //              timeout: only the ones that made it.)
    //   timedOut — refs that did NOT reach target. ALWAYS [] on a
    //              clean exit (every --all ref reached, OR --any saw
    //              one). Populated on actual timeout only.
    //
    // The legacy boolean `timedOut` from the SDK spread is intentionally
    // overwritten by an array; downstream callers branch on
    // `firing === null && timedOut.length > 0` for partial-progress.
    const timedOutArray = result.timedOut
      ? unmetRefs.map((t) => ({ ...t, qualifiedId: qualifiedId(t) }))
      : [];
    emitJson({
      ...result,
      firing: firingJson,
      all: reachedRefs.map((t) => ({
        ...t,
        qualifiedId: qualifiedId(t),
        reachedAt: new Date().toISOString(),
      })),
      timedOut: timedOutArray,
      nextSteps,
    });
    if (result.timedOut) process.exit(5);
    return;
  }

  // Human output:
  //   --first / --any success: print qualified id of firing ref on
  //     stdout (so `... | head -1` and `read REF < <(mu task wait
  //     ...)` both work), then a dim summary + per-task lines.
  //   --all success / timeout: today's summary line + per-task list.
  const targetStatus = statusOpt ?? "CLOSED";
  if (firingRef !== null) {
    console.log(qualifiedId(firingRef));
  }
  const summary = result.timedOut
    ? pc.yellow(`Timed out after ${result.elapsedMs}ms`)
    : pc.green(
        `${wantAny ? "any-of" : "all-of"} ${refs.length} reached ${targetStatus} in ${result.elapsedMs}ms`,
      );
  console.log(summary);
  for (const t of result.tasks) {
    const marker = t.reachedTarget ? pc.green("✓") : pc.dim("•");
    // Cross-ws: show the qualified id so a mixed list is unambiguous.
    // Single-ws (workstreamSet.size === 1) keeps today's bare-name
    // output to avoid noise.
    const label = workstreamSet.size > 1 ? qualifiedId(t) : t.name;
    console.log(`  ${marker} ${pc.bold(label)} ${pc.dim(`(${t.status})`)}`);
  }
  printNextSteps(nextSteps);
  if (result.timedOut) process.exit(5);
}
