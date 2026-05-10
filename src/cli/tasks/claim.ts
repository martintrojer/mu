// mu — `mu task` ownership + synchronisation verbs (claim / release / wait).
//
// claim   → CAS-style ownership transfer; dispatch via --for or
//           anonymous --self (owner stays NULL, actor in agent_logs).
// release → clears owner; --reopen also flips status to OPEN.
// wait    → polls until the listed tasks reach --status (default
//           CLOSED). Exit 0 = met; exit 5 = timeout.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import { refreshAgentTitle } from "../../agents.js";
import {
  UsageError,
  applyQualifiedRef,
  assertTaskInWorkstream,
  emitJson,
  parseStatusOption,
  resolveEntityRef,
  resolveWorkstream,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import { reconcile } from "../../reconcile.js";
import {
  ReaperDetectedDuringWaitError,
  type TaskWaitResult,
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
  const sdkOpts: {
    agentName?: string;
    self?: boolean;
    actor?: string;
    evidence?: string;
    workstream: string;
  } = { workstream: ws };
  if (opts.for) sdkOpts.agentName = opts.for;
  if (opts.self) sdkOpts.self = true;
  if (opts.actor !== undefined) sdkOpts.actor = opts.actor;
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const result = await claimTask(db, localId, sdkOpts);
  // Title push for the new owner. Anonymous claims (--self) leave
  // owner=null — nothing to refresh.
  if (result.ownerName) await refreshAgentTitle(db, result.ownerName, ws);
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

export async function cmdTaskWait(
  db: Db,
  ids: readonly string[],
  opts: {
    status?: string;
    any?: boolean;
    timeout?: number;
    stuckAfter?: number;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  if (ids.length === 0) {
    throw new UsageError("mu task wait: at least one task id is required");
  }
  // Validate status (default CLOSED). Same parser as mu task list --status.
  const statusOpt = opts.status !== undefined ? parseStatusOption(opts.status) : undefined;
  // Each id may carry a `<workstream>/` qualifier; applyQualifiedRef
  // pushes the workstream onto opts (so the standard chain picks it
  // up below) and throws UsageError if two ids disagree.
  // verb_arg_qualified_workstream_name.
  const bareIds = ids.map((id) => applyQualifiedRef(id, opts));
  // Scope: every id must be in the workstream we resolved (-w error
  // semantics matching every other task verb). resolveEntityRef on
  // the first id covers the bare-name+ambiguity-disambiguation path;
  // subsequent ids only need scope assertion.
  if (bareIds.length > 0 && bareIds[0] !== undefined) {
    await resolveEntityRef(db, bareIds[0], opts, "task");
  }
  for (const id of bareIds) {
    assertTaskInWorkstream(db, id, opts.workstream);
  }
  const ws = await resolveWorkstream(opts.workstream);

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
    workstream: string;
    beforePoll?: () => Promise<void>;
  } = { timeoutMs, stuckAfterMs, workstream: ws };
  if (statusOpt !== undefined) sdkOpts.status = statusOpt;
  if (opts.any) sdkOpts.any = true;

  // task_wait_reconcile_dead_panes: per-poll reconcile + reaper-flip
  // detection. We keep a snapshot of each watched task's prior
  // (status, owner) so that AFTER reconcile (which may have flipped
  // IN_PROGRESS → OPEN for a dead-pane worker) we can spot the
  // transition and abort with exit 6 instead of running out the
  // operator's --timeout.
  //
  //   - Reconcile runs on EVERY poll regardless of target. The
  //     reaper is exactly what we want to fire, and it only does so
  //     during a `"full"` reconcile (the prune deletes the agent row
  //     which triggers the IN_PROGRESS → OPEN flip). When the wait
  //     target is OPEN, a dead-pane worker reaching OPEN-via-reaper
  //     IS the success condition — the reconcile call is what makes
  //     that succeed at all.
  //   - Reconcile is per-workstream; cmdTaskWait already enforces
  //     single-workstream scope via assertTaskInWorkstream above, so
  //     one reconcile call covers every watched task.
  //   - Exit-6 suppression: only when the wait target is CLOSED.
  //     Other targets treat reaper-flip as a legitimate state change
  //     (target=OPEN: it's the success; target=IN_PROGRESS: an
  //     operator polling for the next worker to claim doesn't want
  //     a dead predecessor to abort their wait).
  //   - First-iteration coverage: beforePoll runs BEFORE the initial
  //     snapshot too (waitForTasks contract), so a worker that died
  //     BEFORE the operator typed `mu task wait` still triggers exit
  //     6 on the first tick.
  const target = statusOpt ?? "CLOSED";
  const reaperExitEnabled = target === "CLOSED";
  const priorState = new Map<string, { status: string; owner: string | null }>();
  sdkOpts.beforePoll = async () => {
    // Cheap (~few ms) tmux list-panes + per-survivor capture-pane.
    // "status-only" mode would skip the prune — but the prune is
    // exactly what fires the reaper that flips the task. Use
    // "full" mode so dead panes get cleaned up AND the reaper runs.
    try {
      await reconcile(db, { workstream: ws, mode: "full" });
    } catch {
      // Tmux substrate hiccup mid-wait: don't crash the wait. The
      // next iteration retries; the exit-6 path stays correct
      // because the prior-state map only fires on a real flip we
      // observed.
    }
    if (!reaperExitEnabled) return;
    for (const id of bareIds) {
      const row = getTask(db, id, ws);
      const status = row?.status ?? "OPEN";
      const owner = row?.ownerName ?? null;
      const prior = priorState.get(id);
      if (prior !== undefined && prior.status === "IN_PROGRESS" && status === "OPEN") {
        // Reaper-flip detected on a watched task. The prior owner
        // is the agent whose pane just got pruned (the FK
        // CASCADE-SET-NULL on agents.id has already cleared the
        // current row's owner; we use the snapshot from the
        // previous tick).
        throw new ReaperDetectedDuringWaitError(id, prior.owner, ws);
      }
      priorState.set(id, { status, owner });
    }
  };

  const result = await waitForTasks(db, bareIds, sdkOpts);

  // Build nextSteps: for each task that DIDN'T reach the target, suggest
  // mu task show so the operator can investigate. Always include
  // 'pick the next ready task' for the unblocked-orchestrator pattern.
  const stuck = result.tasks.filter((t) => !t.reachedTarget);

  const nextSteps: NextStep[] = [];
  for (const t of stuck) {
    nextSteps.push({
      intent: `Investigate ${t.name} (status=${t.status})`,
      command: `mu task show ${t.name} -w ${ws}`,
    });
  }
  if (!result.timedOut) {
    nextSteps.push({ intent: "Pick the next ready task", command: `mu task next -w ${ws}` });
  }

  if (opts.json) {
    emitJson({ ...result, nextSteps });
    if (result.timedOut) process.exit(5);
    return;
  }

  // Human output: per-task line with status + reached marker.
  const targetStatus = statusOpt ?? "CLOSED";
  const summary = result.timedOut
    ? pc.yellow(`Timed out after ${result.elapsedMs}ms`)
    : pc.green(
        `${opts.any ? "any-of" : "all-of"} ${bareIds.length} reached ${targetStatus} in ${result.elapsedMs}ms`,
      );
  console.log(summary);
  for (const t of result.tasks) {
    const marker = t.reachedTarget ? pc.green("✓") : pc.dim("•");
    console.log(`  ${marker} ${pc.bold(t.name)} ${pc.dim(`(${t.status})`)}`);
  }
  printNextSteps(nextSteps);
  if (result.timedOut) process.exit(5);
}
