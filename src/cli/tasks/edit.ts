// mu — `mu task` create/read/edit verbs (add / show / notes / note / update).
//
// add → addTask, with auto-id derivation when localId omitted.
// show → row + edges + notes (+ lastClaimActor when owner=NULL).
// notes / note → list + append on task_notes.
// update → scalar edits (title/impact/effortDays).
//
// Plus the helpers:
//   unescapeNoteText  — \n / \t / \r / \\ inside a quoted string body
//   printNote         — shared note formatter for show + notes
//
// `who claimed this task?` for the owner=NULL --self path comes from
// the SDK's lastClaimActor (src/logs.ts) directly — the prior CLI-side
// thin-wrapper was a vestigial re-export from the cluster split, gone
// in schema_v5_cleanups.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import {
  UsageError,
  assertTaskInWorkstream,
  emitJson,
  parseCsvFlag,
  resolveEntityRef,
  resolveWorkstream,
  withRoiAll,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { lastClaimActor } from "../../logs.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import {
  TaskNotFoundError,
  type TaskNoteRow,
  type UpdateTaskOptions,
  addNote,
  addTask,
  getTask,
  getTaskEdges,
  idFromTitle,
  listNotes,
  resolveActorIdentity,
  updateTask,
} from "../../tasks.js";

/**
 * Translate the small set of shell-style escapes (\n, \t, \r, \\)
 * inside a note body so a heredoc-free shell call can write a
 * multi-line note in one quoted string:
 *
 *   mu task note auth "FILES: a.rs:45\nDECISION: chose JWT"
 *
 * Backslashes are protected via a NUL placeholder so `\\n` stays as
 * a literal `\n` in the output rather than being processed twice.
 */
export function unescapeNoteText(s: string): string {
  // Single-pass regex: match a backslash followed by one of the four
  // recognised escape characters and decide per-match what to emit.
  // This avoids the in-band-sentinel pattern (where a placeholder string
  // could in principle collide with legitimate note content) and means
  // `\\n` correctly yields a literal `\n` rather than a newline, because
  // the leading `\\` consumes the backslash before `\n` can match.
  return s.replace(/\\([\\ntr])/g, (_, ch: string) => {
    switch (ch) {
      case "\\":
        return "\\";
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      default:
        return _;
    }
  });
}

export function printNote(n: TaskNoteRow): void {
  const author = n.author ?? "<orchestrator>";
  console.log(`  ${pc.dim(n.createdAt)}  ${pc.bold(author)}`);
  for (const line of n.content.split("\n")) {
    console.log(`    ${line}`);
  }
}

export async function cmdTaskAdd(
  db: Db,
  localId: string | undefined,
  opts: {
    title: string;
    impact: number;
    effortDays: number;
    blockedBy?: string[];
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  // Derive the id from the title if the user didn't provide one. The
  // CLI's `<id>` positional is now optional; idFromTitle handles
  // collisions with `_2`, `_3`, … suffixes.
  const id = localId ?? idFromTitle(db, workstream, opts.title);
  const blockedBy = parseCsvFlag(opts.blockedBy);
  const task = addTask(db, {
    localId: id,
    workstream,
    title: opts.title,
    impact: opts.impact,
    effortDays: opts.effortDays,
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
  });
  const nextSteps: NextStep[] = [
    { intent: "Show this task", command: `mu task show ${task.name} -w ${workstream}` },
    {
      // Single-quoted example: shell metachars (`...`, $VAR, $(...))
      // inside a double-quoted string expand in YOUR shell before mu
      // sees the note (mufeedback note #257). Single quotes defer
      // expansion to the agent.
      intent: "Drop a note (single-quote to defer shell expansion)",
      command: `mu task note ${task.name} '...' -w ${workstream}`,
    },
    {
      intent: "Add a blocker",
      command: `mu task block ${task.name} --by <other-id> -w ${workstream}`,
    },
    {
      intent: "Claim and start",
      command: `mu task claim ${task.name} -w ${workstream} --self  (or --for <worker>)`,
    },
  ];
  if (opts.json) {
    emitJson({ task: withRoiAll([task])[0], blockers: blockedBy ?? [], nextSteps });
    return;
  }
  const idHint = localId === undefined ? pc.dim(" (id derived from title)") : "";
  console.log(
    `Added task ${pc.bold(task.name)}${idHint} ${pc.dim(
      `(workstream=${workstream}, impact=${task.impact}, effort=${task.effortDays})`,
    )}`,
  );
  if (blockedBy) console.log(pc.dim(`  blocked by: ${blockedBy.join(", ")}`));
  printNextSteps(nextSteps);
}

export async function cmdTaskNote(
  db: Db,
  rawId: string,
  content: string,
  opts: { workstream?: string; json?: boolean; author?: string } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  // Author resolution: explicit --author wins; otherwise consult
  // MU_AGENT_NAME (env var injected at spawn) > pane title > $USER >
  // 'orchestrator'. Surfaced from mufeedback note #176: notes from
  // spawned agents were appearing as <orchestrator> because the CLI
  // wasn't propagating identity. After this fix, mu-spawned workers'
  // notes are correctly attributed to the agent name.
  const author = opts.author ?? (await resolveActorIdentity());
  const note = addNote(db, localId, unescapeNoteText(content), { author, workstream: ws });
  const nextSteps: NextStep[] = [
    { intent: "Show all notes on this task", command: `mu task notes ${localId} -w ${ws}` },
    { intent: "Show full task state", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, note, nextSteps });
    return;
  }
  console.log(pc.dim(`note appended to ${localId}`));
  printNextSteps(nextSteps);
}

export async function cmdTaskShow(
  db: Db,
  rawId: string,
  opts: { json?: boolean; workstream?: string } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  // v5: tasks.local_id is per-workstream unique. Resolve the
  // operator's workstream up front so the lookup scopes correctly.
  const ws = await resolveWorkstream(opts.workstream);
  const task = getTask(db, localId, ws);
  if (!task) throw new TaskNotFoundError(localId);
  const edges = getTaskEdges(db, localId, task.workstreamName);
  const notes = listNotes(db, localId, task.workstreamName);

  // When owner IS NULL but the task is IN_PROGRESS (or recently was),
  // the actor is in agent_logs. Surface it so 'who's working on this'
  // is answerable from `mu task show` alone.
  const lastActor =
    task.ownerName === null && task.status !== "OPEN"
      ? lastClaimActor(db, task.workstreamName, task.name)
      : null;

  if (opts.json) {
    emitJson({
      task: withRoiAll([task])[0],
      blockers: edges.blockers,
      dependents: edges.dependents,
      notes,
      lastClaimActor: lastActor,
    });
    return;
  }

  const roi = task.effortDays > 0 ? (task.impact / task.effortDays).toFixed(1) : "∞";
  console.log(pc.bold(`${task.name}  —  ${task.title}`));
  console.log(`  workstream : ${task.workstreamName}`);
  console.log(`  status     : ${task.status}`);
  // owner: registered worker name, or '(self: <actor>)' for an anonymous
  // claim, or '(unowned)' for OPEN tasks.
  const ownerLine =
    task.ownerName !== null
      ? task.ownerName
      : lastActor !== null
        ? pc.dim(`(self: ${lastActor})`)
        : pc.dim("(unowned)");
  console.log(`  owner      : ${ownerLine}`);
  console.log(`  impact     : ${task.impact}`);
  console.log(`  effort     : ${task.effortDays}  ${pc.dim(`(ROI ${roi})`)}`);
  console.log(`  created    : ${pc.dim(task.createdAt)}`);
  console.log(`  updated    : ${pc.dim(task.updatedAt)}`);

  console.log("");
  console.log(pc.bold("Edges"));
  console.log(
    `  blocked by : ${edges.blockers.length === 0 ? pc.dim("—") : edges.blockers.join(", ")}`,
  );
  console.log(
    `  blocks     : ${edges.dependents.length === 0 ? pc.dim("—") : edges.dependents.join(", ")}`,
  );

  console.log("");
  console.log(pc.bold(`Notes (${notes.length})`));
  if (notes.length === 0) {
    console.log(pc.dim("  (no notes)"));
  } else {
    for (const n of notes) printNote(n);
  }
}

export async function cmdTaskNotes(
  db: Db,
  rawId: string,
  opts: { json?: boolean; workstream?: string } = {},
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const task = getTask(db, localId, ws);
  if (!task) throw new TaskNotFoundError(localId);
  const notes = listNotes(db, localId, task.workstreamName);
  if (opts.json) {
    emitJson(notes);
    return;
  }
  if (notes.length === 0) {
    console.log(pc.dim(`(no notes on ${localId})`));
    return;
  }
  for (const n of notes) printNote(n);
}

export async function cmdTaskUpdate(
  db: Db,
  rawId: string,
  opts: {
    title?: string;
    impact?: number;
    effortDays?: number;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  const { name: localId } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, localId, opts.workstream);
  const ws = await resolveWorkstream(opts.workstream);
  const updateOpts: UpdateTaskOptions = {};
  if (opts.title !== undefined) updateOpts.title = opts.title;
  if (opts.impact !== undefined) updateOpts.impact = opts.impact;
  if (opts.effortDays !== undefined) updateOpts.effortDays = opts.effortDays;
  if (Object.keys(updateOpts).length === 0) {
    throw new UsageError(
      "nothing to update; pass at least one of --title, --impact, --effort-days",
    );
  }
  const r = updateTask(db, localId, updateOpts, { workstream: ws });
  const nextSteps: NextStep[] = [
    { intent: "Show updated task", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ taskName: localId, ...r, nextSteps });
    return;
  }
  if (!r.updated) {
    console.log(pc.dim(`${localId}: no fields differ from current (no-op)`));
    return;
  }
  console.log(`Updated ${pc.bold(localId)} ${pc.dim(`(${r.changedFields.join(", ")})`)}`);
  printNextSteps(nextSteps);
}
