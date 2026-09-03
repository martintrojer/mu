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
  UsageError,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import { addBlockEdge, deleteTask, removeBlockEdge, reparentTask } from "../../tasks.js";

/** Canonicalise the `-b/--by` value into a non-empty blocker list.
 *
 *  dogfood-block-multi: `--by` used to be single-valued while
 *  `mu task add --blocked-by` was variadic + comma-aware, so the
 *  natural `mu task block X --by a,b,c` failed with
 *  "no such task: a,b,c". Both flags now funnel through the SAME
 *  canonical helper (parseCsvFlag), so repeat / comma / mixed forms
 *  all work and the two verbs can no longer drift apart.
 *
 *  Commander hands us `string` for the legacy `<blocker>` shape and
 *  `string[]` for the variadic one; accept both so a programmatic
 *  caller passing the old single-string shape keeps working. */
export function parseByFlag(by: string | readonly string[]): string[] {
  const blockers = parseCsvFlag(typeof by === "string" ? [by] : by, "-b/--by");
  if (blockers.length === 0) {
    throw new UsageError("-b/--by requires at least one blocker task id");
  }
  // De-dupe so `--by a,a` is a single edge attempt rather than an
  // added-then-no-op pair that would read as a confusing partial.
  return [...new Set(blockers)];
}

export async function cmdTaskBlock(
  db: Db,
  rawBlocked: string,
  opts: { by: string | readonly string[]; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: blocked } = await resolveEntityRef(db, rawBlocked, opts, "task");
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const blockers = parseByFlag(opts.by);
  const byList = blockers.join(",");
  // Sequential, fail-fast: the first bad blocker throws its typed
  // error (not-found / cycle / cross-workstream) and earlier edges
  // stay added. Same semantics as running the single-blocker form N
  // times, which is what this replaces.
  const results = blockers.map((blocker) => ({
    blockerName: blocker,
    ...addBlockEdge(db, ws, blocked, blocker),
  }));
  const added = results.filter((r) => r.added).length;
  const nextSteps: NextStep[] = [
    { intent: "Show the dependency tree", command: `mu task tree ${blocked} -w ${ws}` },
    { intent: "Remove these edges", command: `mu task unblock ${blocked} --by ${byList} -w ${ws}` },
  ];
  if (opts.json) {
    const first = results[0];
    emitJson({
      blockedName: blocked,
      // Single-blocker callers keep the pre-existing scalar shape.
      blockerName: first !== undefined && results.length === 1 ? first.blockerName : undefined,
      blockerNames: blockers,
      results,
      added: added > 0,
      addedEdges: added,
      nextSteps,
    });
    return;
  }
  for (const r of results) {
    if (!r.added) {
      console.log(pc.dim(`${r.blockerName} → ${blocked}: edge already exists (no-op)`));
      continue;
    }
    console.log(`Added edge ${pc.bold(r.blockerName)} → ${pc.bold(blocked)}`);
  }
  printNextSteps(nextSteps);
}

export async function cmdTaskUnblock(
  db: Db,
  rawBlocked: string,
  opts: { by: string | readonly string[]; workstream?: string; json?: boolean },
): Promise<void> {
  const { name: blocked } = await resolveEntityRef(db, rawBlocked, opts, "task");
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  // Symmetric with `block`: same --by parsing on both halves of the
  // same edge operation, so undoing a multi-blocker block is a single
  // invocation too.
  const blockers = parseByFlag(opts.by);
  const byList = blockers.join(",");
  const results = blockers.map((blocker) => ({
    blockerName: blocker,
    ...removeBlockEdge(db, ws, blocked, blocker),
  }));
  const removed = results.filter((r) => r.removed).length;
  const nextSteps: NextStep[] = [
    { intent: "Show what now blocks this task", command: `mu task tree ${blocked} -w ${ws}` },
    { intent: "Re-add the edges", command: `mu task block ${blocked} --by ${byList} -w ${ws}` },
  ];
  if (opts.json) {
    const first = results[0];
    emitJson({
      blockedName: blocked,
      blockerName: first !== undefined && results.length === 1 ? first.blockerName : undefined,
      blockerNames: blockers,
      results,
      removed: removed > 0,
      removedEdges: removed,
      nextSteps,
    });
    return;
  }
  for (const r of results) {
    if (!r.removed) {
      console.log(pc.dim(`${r.blockerName} → ${blocked}: no such edge (no-op)`));
      continue;
    }
    console.log(`Removed edge ${pc.bold(r.blockerName)} → ${pc.bold(blocked)}`);
  }
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
  // An all-EMPTY --blocked-by '' is the documented clear-all-blockers
  // sentinel here (unlike --by, where zero blockers is meaningless),
  // so [] stays legal. A BLANK ' ' still throws from parseCsvFlag.
  const blockers = parseCsvFlag(opts.blockedBy, "-b/--blocked-by");
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
  // `mu workstream teardown` / `mu snapshot prune`. Surfaced by feedback
  // ws task fb_task_delete_no_yes
  // (impact=30): the dogfood report typed `mu task delete X --yes`
  // (mirroring workstream teardown) and got 'unknown option --yes'
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
