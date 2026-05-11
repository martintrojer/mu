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
  colorStatus,
  emitJson,
  emitJsonCollection,
  parseCsvFlag,
  resolveEntityRef,
  resolveWorkstream,
  withRoiAll,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { lastClaimActor } from "../../logs.js";
import { type NextStep, pc, printNextSteps } from "../../output.js";
import {
  type TaskEdgeWithStatus,
  TaskNotFoundError,
  type TaskNoteRow,
  type UpdateTaskOptions,
  addNote,
  addTask,
  getTask,
  getTaskEdgesWithStatus,
  idFromTitleVerbose,
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

/** Split a list of edge neighbours into (still-gating, satisfied)
 *  buckets. CLOSED is the only status that satisfies a `blocks` edge
 *  per src/tasks/status.ts; REJECTED/DEFERRED still gate downstream
 *  work and stay in the still-gating bucket so the operator sees
 *  them. (task_show_blocked_by_renders_closed.) */
function partitionEdges(edges: readonly TaskEdgeWithStatus[]): {
  stillGating: TaskEdgeWithStatus[];
  satisfied: TaskEdgeWithStatus[];
} {
  const stillGating: TaskEdgeWithStatus[] = [];
  const satisfied: TaskEdgeWithStatus[] = [];
  for (const e of edges) {
    if (e.status === "CLOSED") satisfied.push(e);
    else stillGating.push(e);
  }
  return { stillGating, satisfied };
}

/** Render one edge bucket as a comma-separated `<name> [<STATUS>]`
 *  list. The status is colour-coded the same way the task table
 *  renders it (src/cli/format.ts colorStatus); satisfied buckets are
 *  additionally dimmed so they recede visually. An empty bucket
 *  renders as an em-dash (—) to match the prior "no edges" rendering
 *  for back-compat with operator-eyed scripts. */
function formatEdgeList(edges: readonly TaskEdgeWithStatus[], dim: boolean): string {
  if (edges.length === 0) return pc.dim("—");
  const parts = edges.map((e) => {
    const piece = `${e.name} [${colorStatus(e.status)}]`;
    return dim ? pc.dim(piece) : piece;
  });
  return parts.join(", ");
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
  // CLI's `<id>` positional is now optional; idFromTitleVerbose handles
  // collisions with `_2`, `_3`, … suffixes AND surfaces a `truncated`
  // flag so we can warn the user when the SLUG_SOFT_CAP word-boundary
  // cut dropped clauses (slugifytitle_silently_drops_clauses).
  // `autoDerived` distinguishes the explicit-<id> branch from the
  // auto-derived branch so `--json` can selectively expose the
  // truncation telemetry only when it's meaningful
  // (task_add_slugify_silently_truncates_ids).
  const autoDerived = localId === undefined;
  let derivation: { id: string; truncated: boolean; originalSlug: string };
  if (localId !== undefined) {
    derivation = { id: localId, truncated: false, originalSlug: localId };
  } else {
    derivation = idFromTitleVerbose(db, workstream, opts.title);
  }
  const id = derivation.id;
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
    // JSON callers are scripts: stay machine-readable. The human
    // stderr hint is suppressed under --json (matches every other
    // prose surface in the CLI). The truncation signal still has to
    // reach scripted callers, though — otherwise pipelines that
    // build follow-up commands from the JSON envelope can't tell the
    // id no longer carries the title's full meaning. Surface it as
    // top-level `truncated`/`originalSlug` siblings of `task` (NOT
    // inside `task`, which mirrors the persisted row).
    // Conventions, consistent with the audit_json_envelope_uniformity
    // singleton style: only emit when meaningful. Both fields are
    // omitted when the operator passed an explicit <id> (no
    // auto-derive) and when auto-derivation produced no truncation
    // (task_add_slugify_silently_truncates_ids).
    const truncationFields =
      autoDerived && derivation.truncated
        ? { truncated: true, originalSlug: derivation.originalSlug }
        : {};
    emitJson({
      task: withRoiAll([task])[0],
      blockers: blockedBy ?? [],
      nextSteps,
      ...truncationFields,
    });
    return;
  }
  // Stderr hint when auto-id derivation truncated the slug. Stderr +
  // exit 0 so scripts that already pipe stdout aren't disturbed; the
  // operator sees the heads-up that the id no longer carries the full
  // title's meaning, with a one-paste fix (pass <id> positional).
  // Suppressed when the operator passed an explicit id (truncated is
  // false in that branch) since they already chose the id by hand.
  if (derivation.truncated) {
    process.stderr.write(
      `hint: id '${task.name}' truncated from a longer slug; pass <id> positional to override (mu task add <id> --title ... ).\n`,
    );
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
  const edges = getTaskEdgesWithStatus(db, localId, task.workstreamName);
  const notes = listNotes(db, localId, task.workstreamName);

  // When owner IS NULL but the task is IN_PROGRESS (or recently was),
  // the actor is in agent_logs. Surface it so 'who's working on this'
  // is answerable from `mu task show` alone.
  const lastActor =
    task.ownerName === null && task.status !== "OPEN"
      ? lastClaimActor(db, task.workstreamName, task.name)
      : null;

  if (opts.json) {
    // JSON shape: blockers/dependents are arrays of {name, status}
    // objects so scripts can filter by status without a second query.
    // (task_show_blocked_by_renders_closed: prior shape was bare
    // string[], which discarded the gating-vs-satisfied distinction.)
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
  // Group each side of the edge set by status so the operator can
  // tell at a glance which prerequisites still gate the task vs which
  // have already been satisfied. CLOSED is the only status that
  // satisfies a `blocks` edge; REJECTED/DEFERRED still gate downstream
  // work, so they stay in the still-gating bucket alongside
  // OPEN/IN_PROGRESS. (task_show_blocked_by_renders_closed.)
  const { stillGating: gatingBlockers, satisfied: satisfiedBlockers } = partitionEdges(
    edges.blockers,
  );
  const { stillGating: openDependents, satisfied: closedDependents } = partitionEdges(
    edges.dependents,
  );
  console.log(`  blocked by : ${formatEdgeList(gatingBlockers, false)}`);
  if (satisfiedBlockers.length > 0) {
    console.log(`  satisfied  : ${formatEdgeList(satisfiedBlockers, true)}`);
  }
  console.log(`  blocks     : ${formatEdgeList(openDependents, false)}`);
  if (closedDependents.length > 0) {
    console.log(`  no longer  : ${formatEdgeList(closedDependents, true)}`);
  }

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
    emitJsonCollection(notes);
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
