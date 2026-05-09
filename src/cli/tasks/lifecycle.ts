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
import { UsageError, assertTaskInWorkstream, emitJson, resolveWorkstream } from "../../cli.js";
import type { Db } from "../../db.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import { closeTask, deferTask, getTask, openTask, rejectTask } from "../../tasks.js";

export async function cmdTaskClose(
  db: Db,
  localId: string,
  opts: { evidence?: string; workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts = opts.evidence !== undefined ? { evidence: opts.evidence } : {};
  // Capture the owner BEFORE closeTask so we can refresh their title
  // even though closeTask doesn't return owner info. owner won't
  // change as a result of close (FK SET NULL only fires on delete).
  const taskRow = getTask(db, localId);
  const r = closeTask(db, localId, sdkOpts);
  if (r.changed && taskRow?.owner) await refreshAgentTitle(db, taskRow.owner);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Reopen if needed", command: `mu task open ${localId} -w ${ws}` },
    { intent: "Pick the next ready task", command: `mu task next -w ${ws}` },
    { intent: "See full state", command: `mu state -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
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

export async function cmdTaskOpen(
  db: Db,
  localId: string,
  opts: { evidence?: string; workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts = opts.evidence !== undefined ? { evidence: opts.evidence } : {};
  const r = openTask(db, localId, sdkOpts);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    {
      intent: "Claim it",
      command: `mu task claim ${localId} -w ${ws}  (--self / --for <worker>)`,
    },
    { intent: "Close again", command: `mu task close ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
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
  localId: string,
  verb: "reject" | "defer",
  opts: RejectDeferOpts,
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  if (opts.yes && !opts.cascade) {
    throw new UsageError(
      `--yes requires --cascade (--yes only meaningful when committing a cascade preview; for single-task ${verb}, --yes is a no-op)`,
    );
  }
  const sdkOpts: { evidence?: string; cascade?: boolean; yes?: boolean } = {};
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
      const t = getTask(db, id);
      if (t?.owner) owners.add(t.owner);
    }
    for (const owner of owners) await refreshAgentTitle(db, owner);
  }
  const ws = await resolveWorkstream(opts.workstream);
  const past = verb === "reject" ? "Rejected" : "Deferred";
  const status = verb === "reject" ? "REJECTED" : "DEFERRED";

  // Cascade dry-run: render the affected list with each task's
  // current status + title so the operator can spot 'wait, that
  // dependent has independent merit, I want to keep it'. Surfaced
  // in mufeedback bug_cascade_reject_too_aggressive.
  if (r.dryRun) {
    if (opts.json) {
      emitJson({
        task: localId,
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
      const t = getTask(db, id);
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
    emitJson({ task: localId, ...r, nextSteps });
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
