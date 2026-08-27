// mu — `mu task` lifecycle verbs (status transitions).
//
// close / open. Each delegates to the SDK; changes are captured as ops
// and optionally reported as evidence notes.
//
// Extracted from src/cli/tasks.ts as part of refactor_split_large_src_files.

import { refreshAgentTitle } from "../../agents.js";
import {
  assertTaskInWorkstream,
  emitJson,
  resolveEntityRef,
  resolveWorkstream,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import { closeTask, getTask, openTask, resolveActorIdentity } from "../../tasks.js";
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
