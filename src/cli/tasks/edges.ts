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
  opts: { workstream?: string; json?: boolean; yes?: boolean } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  // Two-phase: bare = dry-run preview; --yes commits. Mirrors
  // `mu workstream destroy` / `mu archive delete` / `mu snapshot
  // prune`. Surfaced by feedback ws task fb_task_delete_no_yes
  // (impact=30): the dogfood report typed `mu task delete X --yes`
  // (mirroring workstream destroy) and got 'unknown option --yes'
  // because the verb took no confirmation flag at all; two failed
  // deletes left long-named tasks lingering until noticed.
  const dryRun = opts.yes !== true;
  const r = deleteTask(db, localId, ws, { dryRun });
  const commitNextSteps: NextStep[] = [
    {
      intent: "Undo (a snapshot was taken before the delete)",
      command: "mu undo --yes",
    },
    {
      intent: "List remaining tasks",
      command: `mu task list -w ${ws}`,
    },
  ];
  const dryRunNextSteps: NextStep[] = [
    {
      intent: "Confirm and actually delete (cascades to edges + notes)",
      command: `mu task delete ${localId} -w ${ws} --yes`,
    },
    {
      intent: "After deleting, undo if you regret it (DB only)",
      command: "mu undo --yes",
    },
    {
      intent: "Inspect the task + edges before deciding",
      command: `mu task show ${localId} -w ${ws}`,
    },
  ];

  // Missing row — idempotent no-op (same outcome whether dry-run or
  // --yes). The `present: false` discriminator keeps this distinct
  // from a dry-run that found an existing task with no edges/notes.
  if (!r.present) {
    if (opts.json) {
      emitJson({ taskName: localId, ...r, nextSteps: commitNextSteps });
      return;
    }
    console.log(pc.dim(`no task named ${localId} (already deleted?)`));
    return;
  }

  // Dry-run: print the cascade preview. The task DOES exist (present
  // checked above); zero edges + zero notes is a real cascade-of-one.
  if (r.dryRun) {
    if (opts.json) {
      emitJson({ taskName: localId, ...r, nextSteps: dryRunNextSteps });
      return;
    }
    console.log(
      r.deletedEdges === 0 && r.deletedNotes === 0
        ? `Would delete ${pc.bold(localId)} ${pc.dim("(no edges, no notes)")}`
        : `Would delete ${pc.bold(localId)} ${pc.dim(`(edges: ${r.deletedEdges}, notes: ${r.deletedNotes})`)}`,
    );
    console.log("");
    console.log(pc.dim("(dry-run; rerun with --yes to actually delete)"));
    console.log(
      pc.dim("A snapshot will be taken before the delete; `mu undo --yes` reverts it (DB only)."),
    );
    printNextSteps(dryRunNextSteps);
    return;
  }

  // Commit path.
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps: commitNextSteps });
    return;
  }
  console.log(
    `Deleted ${pc.bold(localId)} ${pc.dim(`(edges: ${r.deletedEdges}, notes: ${r.deletedNotes})`)}`,
  );
  printNextSteps(commitNextSteps);
}
