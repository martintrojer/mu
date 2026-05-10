// mu — `mu task` graph-edge verbs (block / unblock / reparent / delete).
//
// All four mutate task_edges (block/unblock/reparent) or cascade through
// it via FK (delete). Each is idempotent and emits typed errors that
// `handle()` in src/cli.ts maps to exit codes.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import {
  assertTaskInWorkstream,
  emitJson,
  parseCsvFlag,
  resolveEntityRef,
  resolveWorkstream,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import { addBlockEdge, deleteTask, removeBlockEdge, reparentTask } from "../../tasks.js";

export async function cmdTaskBlock(
  db: Db,
  rawBlocked: string,
  opts: { by: string; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: blocked } = await resolveEntityRef(db, rawBlocked, opts, "task");
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const r = addBlockEdge(db, ws, blocked, opts.by);
  const nextSteps: NextStep[] = [
    { intent: "Show the dependency tree", command: `mu task tree ${blocked} -w ${ws}` },
    { intent: "Remove this edge", command: `mu task unblock ${blocked} --by ${opts.by} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ blockedName: blocked, blockerName: opts.by, ...r, nextSteps });
    return;
  }
  if (!r.added) {
    console.log(pc.dim(`${opts.by} → ${blocked}: edge already exists (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  console.log(`Added edge ${pc.bold(opts.by)} → ${pc.bold(blocked)}`);
  printNextSteps(nextSteps);
}

export async function cmdTaskUnblock(
  db: Db,
  rawBlocked: string,
  opts: { by: string; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: blocked } = await resolveEntityRef(db, rawBlocked, opts, "task");
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const r = removeBlockEdge(db, ws, blocked, opts.by);
  const nextSteps: NextStep[] = [
    { intent: "Show what now blocks this task", command: `mu task tree ${blocked} -w ${ws}` },
    { intent: "Re-add the edge", command: `mu task block ${blocked} --by ${opts.by} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ blockedName: blocked, blockerName: opts.by, ...r, nextSteps });
    return;
  }
  if (!r.removed) {
    console.log(pc.dim(`${opts.by} → ${blocked}: no such edge (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  console.log(`Removed edge ${pc.bold(opts.by)} → ${pc.bold(blocked)}`);
  printNextSteps(nextSteps);
}

export async function cmdTaskReparent(
  db: Db,
  rawId: string,
  opts: { blockedBy: string[]; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const blockers = parseCsvFlag(opts.blockedBy);
  const r = reparentTask(db, localId, blockers, { workstream: ws });
  const nextSteps: NextStep[] = [
    { intent: "Show the new dependency tree", command: `mu task tree ${localId} -w ${ws}` },
    { intent: "Show the task", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, blockerNames: blockers, ...r, nextSteps });
    return;
  }
  console.log(
    `Reparented ${pc.bold(localId)} ${pc.dim(`(removed ${r.removedEdges} edges, added ${r.addedEdges})`)}`,
  );
  printNextSteps(nextSteps);
}

export async function cmdTaskDelete(
  db: Db,
  rawId: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const r = deleteTask(db, localId, ws);
  const nextSteps: NextStep[] = [
    {
      // A snapshot was taken by deleteTask itself before the cascade
      // (snap_schema commit ab82a11). `mu undo` reverts the latest one.
      intent: "Undo (a snapshot was taken before the delete)",
      command: "mu undo --yes",
    },
    {
      intent: "List remaining tasks",
      command: `mu task list -w ${ws}`,
    },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.deleted) {
    console.log(pc.dim(`no task named ${localId} (already deleted?)`));
    return;
  }
  console.log(
    `Deleted ${pc.bold(localId)} ${pc.dim(`(edges: ${r.deletedEdges}, notes: ${r.deletedNotes})`)}`,
  );
  printNextSteps(nextSteps);
}
