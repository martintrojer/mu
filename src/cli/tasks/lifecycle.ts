// mu — `mu task` lifecycle verbs (status transitions).
//
// close / open / reject / defer + the cascade preview helper. Each
// snapshots the DB before mutating (via the SDK closeTask / openTask
// / etc.); --cascade is dry-run by default and requires --yes to
// commit (the deliberate friction; surfaced live by
// bug_cascade_reject_too_aggressive).
//
// Extracted from src/cli/tasks.ts as part of refactor_split_large_src_files.

import { refreshAgentTitle } from "../../agents.js";
import {
  UsageError,
  assertTaskInWorkstream,
  emitJson,
  resolveEntityRef,
  resolveWorkstream,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import {
  closeTask,
  deferTask,
  getTask,
  openTask,
  rejectTask,
  resolveActorIdentity,
} from "../../tasks.js";
import { backendByName } from "../../vcs.js";
import { getWorkspaceForAgent } from "../../workspace.js";

export async function cmdTaskClose(
  db: Db,
  rawId: string,
  opts: { evidence?: string; ifReady?: boolean; workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const actor = await resolveActorIdentity();
  const sdkOpts: {
    evidence?: string;
    ifReady?: boolean;
    workstream: string;
    author?: string;
  } = { workstream: ws };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  if (opts.ifReady) sdkOpts.ifReady = true;
  // mufeedback task_close_evidence_does_not_append_the: closeTask
  // auto-inserts a `CLOSE: <evidence>` note when --evidence is
  // non-empty. Resolve the actor identity once per close so the note is
  // attributed to the closing worker (mu-spawned worker via
  // MU_AGENT_NAME, adopted pane via title, otherwise $USER /
  // 'orchestrator') and so the success Next: hints can inspect that
  // actor's workspace without resolving identity a second time.
  if (opts.evidence !== undefined && opts.evidence !== "") {
    sdkOpts.author = actor;
  }
  // Capture the owner BEFORE closeTask so we can refresh their title
  // even though closeTask doesn't return owner info. owner won't
  // change as a result of close (FK SET NULL only fires on delete).
  const taskRow = getTask(db, localId, ws);
  const r = closeTask(db, localId, sdkOpts);
  // --if-ready can return a CloseSkippedResult (no mutation). Branch
  // first so the typed `skipped` field stays in scope below.
  if ("skipped" in r) {
    const blockingNextSteps: NextStep[] = [
      {
        intent: "Watch the remaining blockers (returns when one closes)",
        command: `mu task wait ${r.blockingIds.join(" ")} -w ${ws} --first --any`,
      },
      { intent: "Show the umbrella + blockers", command: `mu task show ${localId} -w ${ws}` },
      {
        intent: "Close anyway (override --if-ready)",
        command: `mu task close ${localId} -w ${ws}`,
      },
    ];
    if (opts.json) {
      emitJson({ taskName: localId, ...r, nextSteps: blockingNextSteps });
      return;
    }
    const total = r.blockingIds.length;
    const shown = r.blockingIds.slice(0, 8).join(", ");
    const tail = total > 8 ? ", \u2026" : "";
    console.log(
      pc.dim(
        `Skipped ${pc.bold(localId)}: blocked by ${total} task(s) (${shown}${tail}); rerun without --if-ready to close anyway`,
      ),
    );
    printNextSteps(blockingNextSteps);
    return;
  }
  if (r.changed && taskRow?.ownerName) await refreshAgentTitle(db, taskRow.ownerName, ws);
  const nextSteps: NextStep[] = [
    { intent: "Reopen if needed", command: `mu task open ${localId} -w ${ws}` },
    { intent: "Pick the next ready task", command: `mu task next -w ${ws}` },
    { intent: "See full state", command: `mu state -w ${ws}` },
  ];
  if (r.changed && r.status === "CLOSED") {
    await maybeAppendDirtyWorkspaceCommitHint(db, nextSteps, actor, ws, taskRow?.title ?? localId);
  }
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already CLOSED (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Closed ${pc.bold(localId)} ${pc.dim(`(${r.previousStatus} → ${r.status})`)}`);
  if (ev) console.log(ev);
  printNextSteps(nextSteps);
}

async function maybeAppendDirtyWorkspaceCommitHint(
  db: Db,
  nextSteps: NextStep[],
  actor: string,
  workstream: string,
  taskTitle: string,
): Promise<void> {
  if (actor.length === 0) return;
  try {
    const row = getWorkspaceForAgent(db, actor, workstream);
    if (row === undefined || row.backend === "none") return;
    const backend = backendByName(row.backend);
    const clean = await backend.isClean(row.path);
    if (clean) return;
    nextSteps.push({
      intent: "Don't forget to commit",
      command: `cd $(mu workspace path ${actor} -w ${workstream}) && git commit -am ${shellSingleQuote(taskTitle)}`,
    });
  } catch {
    // Best-effort hint only: a VCS probe failure must never make
    // `mu task close` fail after the task successfully closed.
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function cmdTaskOpen(
  db: Db,
  rawId: string,
  opts: { evidence?: string; workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const sdkOpts: { evidence?: string; workstream: string } = { workstream: ws };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const r = openTask(db, localId, sdkOpts);
  const nextSteps: NextStep[] = [
    {
      intent: "Claim it",
      command: `mu task claim ${localId} -w ${ws}  (--self / --for <worker>)`,
    },
    { intent: "Close again", command: `mu task close ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already OPEN (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  const ev = opts.evidence ? pc.dim(`  evidence: ${opts.evidence}`) : "";
  console.log(`Reopened ${pc.bold(localId)} ${pc.dim(`(${r.previousStatus} → ${r.status})`)}`);
  if (ev) console.log(ev);
  printNextSteps(nextSteps);
}

// ─── reject / defer (terminal-but-blocking transitions) ────────────────

interface RejectDeferOpts {
  evidence?: string;
  cascade?: boolean;
  yes?: boolean;
  workstream?: string;
  json?: boolean;
}

export async function cmdTaskReject(
  db: Db,
  localId: string,
  opts: RejectDeferOpts = {},
): Promise<void> {
  return cmdTaskRejectOrDefer(db, localId, "reject", opts);
}

export async function cmdTaskDefer(
  db: Db,
  localId: string,
  opts: RejectDeferOpts = {},
): Promise<void> {
  return cmdTaskRejectOrDefer(db, localId, "defer", opts);
}

export async function cmdTaskRejectOrDefer(
  db: Db,
  rawId: string,
  verb: "reject" | "defer",
  opts: RejectDeferOpts,
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  if (opts.yes && !opts.cascade) {
    throw new UsageError(
      `--yes requires --cascade (--yes only meaningful when committing a cascade preview; for single-task ${verb}, --yes is a no-op)`,
    );
  }
  const sdkOpts: { evidence?: string; cascade?: boolean; yes?: boolean; workstream: string } = {
    workstream: ws,
  };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  if (opts.cascade) sdkOpts.cascade = true;
  if (opts.yes) sdkOpts.yes = true;
  const r = verb === "reject" ? rejectTask(db, localId, sdkOpts) : deferTask(db, localId, sdkOpts);
  // Title push for every affected task's owner (the verb compresses
  // potentially-multi-task work; refresh each owner once). Skipped
  // on dry-run since nothing changed.
  if (r.changed) {
    const owners = new Set<string>();
    for (const id of r.changedIds) {
      const t = getTask(db, id, ws);
      if (t?.ownerName) owners.add(t.ownerName);
    }
    for (const owner of owners) await refreshAgentTitle(db, owner, ws);
  }
  const past = verb === "reject" ? "Rejected" : "Deferred";
  const status = verb === "reject" ? "REJECTED" : "DEFERRED";

  // Cascade dry-run: render the affected list with each task's
  // current status + title so the operator can spot 'wait, that
  // dependent has independent merit, I want to keep it'. Surfaced
  // in mufeedback bug_cascade_reject_too_aggressive.
  if (r.dryRun) {
    if (opts.json) {
      emitJson({
        taskName: localId,
        ...r,
        nextSteps: [
          {
            intent: "Commit the cascade after reviewing the list",
            command: `mu task ${verb} ${localId} --cascade --yes -w ${ws}`,
          },
          {
            intent: "Address one dependent first, then re-preview",
            command: `mu task ${verb} <dep> -w ${ws}`,
          },
        ],
      });
      return;
    }
    console.log(
      `${past === "Rejected" ? "Reject" : "Defer"} ${pc.bold(localId)} would sweep ${r.affectedIds.length} task(s) (root + ${r.affectedIds.length - 1} dependent(s)):`,
    );
    for (const id of r.affectedIds) {
      const t = getTask(db, id, ws);
      const title = t ? (t.title.length > 50 ? `${t.title.slice(0, 49)}…` : t.title) : "?";
      const marker = id === localId ? pc.bold("  *") : "   ";
      console.log(`${marker} ${pc.bold(id)}  ${pc.dim(title)}`);
    }
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually sweep)"));
    printNextSteps([
      {
        intent: "Commit the cascade after reviewing the list",
        command: `mu task ${verb} ${localId} --cascade --yes -w ${ws}`,
      },
      {
        intent: "Address one dependent first, then re-preview",
        command: `mu task ${verb} <dep> -w ${ws}`,
      },
    ]);
    return;
  }

  const nextSteps: NextStep[] = [
    { intent: "Reopen if reconsidered", command: `mu task open ${localId} -w ${ws}` },
    { intent: "See full state", command: `mu state -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already ${status} (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  console.log(`${past} ${pc.bold(localId)} ${pc.dim(`(→ ${status})`)}`);
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
  if (r.changedIds.length > 1) {
    const cascaded = r.changedIds.slice(1);
    console.log(
      pc.dim(
        `  cascaded to ${cascaded.length} dependent(s): ${cascaded.slice(0, 8).join(", ")}${cascaded.length > 8 ? ", …" : ""}`,
      ),
    );
  }
  printNextSteps(nextSteps);
}
