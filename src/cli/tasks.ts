// mu — every `mu task ...` verb + the `mu my-tasks` / `mu my-next`
// agent-self aliases.
//
// Coverage:
//   mu my-tasks                       owned-by-self
//   mu my-next                        top-K ready in self.workstream
//   mu task add / list / next / ready / blocked / goals / owned-by /
//                search / show / tree / notes / note
//   mu task claim / release / close / open / reject / defer / block /
//                unblock / update / reparent / delete / wait
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import { cmdTaskClose, cmdTaskDefer, cmdTaskOpen, cmdTaskReject } from "./tasks/lifecycle.js";
// Import the cluster's verb modules locally (so wireTaskCommands can
// reference them) AND re-export so external callers continue to
// `import { cmdTaskList } from "./cli/tasks.js"`.
import {
  cmdTaskBlocked,
  cmdTaskGoals,
  cmdTaskList,
  cmdTaskNext,
  cmdTaskOwnedBy,
  cmdTaskReady,
  cmdTaskSearch,
} from "./tasks/queries.js";
export {
  cmdTaskBlocked,
  cmdTaskGoals,
  cmdTaskList,
  cmdTaskNext,
  cmdTaskOwnedBy,
  cmdTaskReady,
  cmdTaskSearch,
} from "./tasks/queries.js";
export {
  cmdTaskClose,
  cmdTaskDefer,
  cmdTaskOpen,
  cmdTaskReject,
} from "./tasks/lifecycle.js";
import { refreshAgentTitle } from "../agents.js";
import {
  TASK_SORT_KEYS,
  UsageError,
  assertTaskInWorkstream,
  byRoiDesc,
  colorStatus,
  emitJson,
  formatTaskListTable,
  parseStatusOption,
  resolveSelf,
  resolveWorkstream,
  withRoiAll,
} from "../cli.js";
import type { Db } from "../db.js";
import { listLogs } from "../logs.js";
import { type NextStep, pc, printNextSteps } from "../output.js";
import {
  TASK_STATUS_LIST,
  TaskNotFoundError,
  type TaskNoteRow,
  type TaskRow,
  type TaskWaitResult,
  type UpdateTaskOptions,
  addBlockEdge,
  addNote,
  addTask,
  claimTask,
  deleteTask,
  getTask,
  getTaskEdges,
  idFromTitle,
  listNotes,
  listReady,
  listTasksByOwner,
  releaseTask,
  removeBlockEdge,
  reparentTask,
  resolveActorIdentity,
  updateTask,
  waitForTasks,
} from "../tasks.js";

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
function unescapeNoteText(s: string): string {
  // Two-pass: first protect literal backslashes by swapping every `\\`
  // for an unlikely placeholder, then translate the remaining shell
  // escapes, then restore the placeholder as a single backslash.
  // Without the placeholder, `\\n` would yield a newline (wrong) instead
  // of a literal `\n`.
  const PLACEHOLDER = "\u{1F511}backslash\u{1F511}";
  return s
    .split("\\\\")
    .join(PLACEHOLDER)
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .split(PLACEHOLDER)
    .join("\\");
}

// assertTaskInWorkstream lives in src/cli.ts now (shared root export
// since cli/tasks/lifecycle.ts and cli/tasks/* all need it).

export async function cmdMyTasks(
  db: Db,
  opts: { json?: boolean; includeClosed?: boolean } = {},
): Promise<void> {
  const self = resolveSelf(db);
  const tasks = listTasksByOwner(db, self.name, {
    includeClosed: opts.includeClosed ?? false,
  });
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim(`(${self.name} owns no tasks)`));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

export async function cmdMyNext(db: Db, opts: { lines?: number; json?: boolean }): Promise<void> {
  const self = resolveSelf(db);
  const k = opts.lines ?? 1;
  const tasks = listReady(db, self.workstream).sort(byRoiDesc).slice(0, k);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim(`(no ready tasks in ${self.workstream})`));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

export async function cmdTaskAdd(
  db: Db,
  localId: string | undefined,
  opts: {
    title: string;
    impact: number;
    effortDays: number;
    blockedBy?: string;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  // Derive the id from the title if the user didn't provide one. The
  // CLI's `<id>` positional is now optional; idFromTitle handles
  // collisions with `_2`, `_3`, … suffixes.
  const id = localId ?? idFromTitle(db, workstream, opts.title);
  const blockedBy = opts.blockedBy
    ? opts.blockedBy
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const task = addTask(db, {
    localId: id,
    workstream,
    title: opts.title,
    impact: opts.impact,
    effortDays: opts.effortDays,
    ...(blockedBy ? { blockedBy } : {}),
  });
  const nextSteps: NextStep[] = [
    { intent: "Show this task", command: `mu task show ${task.localId} -w ${workstream}` },
    {
      // Single-quoted example: shell metachars (`...`, $VAR, $(...))
      // inside a double-quoted string expand in YOUR shell before mu
      // sees the note (mufeedback note #257). Single quotes defer
      // expansion to the agent.
      intent: "Drop a note (single-quote to defer shell expansion)",
      command: `mu task note ${task.localId} '...' -w ${workstream}`,
    },
    {
      intent: "Add a blocker",
      command: `mu task block ${task.localId} --by <other-id> -w ${workstream}`,
    },
    {
      intent: "Claim and start",
      command: `mu task claim ${task.localId} -w ${workstream} --self  (or --for <worker>)`,
    },
  ];
  if (opts.json) {
    emitJson({ task: withRoiAll([task])[0], blockers: blockedBy ?? [], nextSteps });
    return;
  }
  const idHint = localId === undefined ? pc.dim(" (id derived from title)") : "";
  console.log(
    `Added task ${pc.bold(task.localId)}${idHint} ${pc.dim(
      `(workstream=${workstream}, impact=${task.impact}, effort=${task.effortDays})`,
    )}`,
  );
  if (blockedBy) console.log(pc.dim(`  blocked by: ${blockedBy.join(", ")}`));
  printNextSteps(nextSteps);
}

export async function cmdTaskNote(
  db: Db,
  localId: string,
  content: string,
  opts: { workstream?: string; json?: boolean; author?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  // Author resolution: explicit --author wins; otherwise consult
  // MU_AGENT_NAME (env var injected at spawn) > pane title > $USER >
  // 'orchestrator'. Surfaced from mufeedback note #176: notes from
  // spawned agents were appearing as <orchestrator> because the CLI
  // wasn't propagating identity. After this fix, mu-spawned workers'
  // notes are correctly attributed to the agent name.
  const author = opts.author ?? (await resolveActorIdentity());
  const note = addNote(db, localId, unescapeNoteText(content), { author });
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show all notes on this task", command: `mu task notes ${localId} -w ${ws}` },
    { intent: "Show full task state", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, note, nextSteps });
    return;
  }
  console.log(pc.dim(`note #${note.id} appended to ${localId}`));
  printNextSteps(nextSteps);
}

interface TreeOpts {
  /** Show dependents (what this task blocks) instead of blockers. */
  down?: boolean;
  json?: boolean;
  workstream?: string;
}

/** JSON shape: each node carries its full TaskRow plus a recursive
 *  `children` array (whose contents depend on direction — blockers if
 *  --no-down, dependents if --down). Diamond-recurrent nodes carry
 *  `recurrence: true` and an empty `children` (instead of expanding). */
interface TreeJsonNode {
  task: TaskRow;
  recurrence?: true;
  children: TreeJsonNode[];
}

export async function cmdTaskTree(db: Db, rootId: string, opts: TreeOpts): Promise<void> {
  assertTaskInWorkstream(db, rootId, opts.workstream);
  const root = getTask(db, rootId);
  if (!root) throw new TaskNotFoundError(rootId);
  const down = opts.down ?? false;
  const seen = new Set<string>([rootId]);

  if (opts.json) {
    const node: TreeJsonNode = { task: root, children: buildJsonTree(db, rootId, down, seen) };
    emitJson({ direction: down ? "dependents" : "blockers", root: node });
    return;
  }

  const direction = down ? "dependents" : "blockers";
  const swapHint = down ? "swap to --no-down for blockers" : "--down for dependents";
  console.log(pc.bold(`Tree of ${rootId}  ${pc.dim(`(${direction} below; ${swapHint})`)}`));
  console.log(formatTreeNodeLabel(root));
  // Global "already rendered" set: a node visited once gets its full
  // subtree drawn; subsequent visits (in a DAG diamond) print a one-line
  // recurrence marker and don't recurse. Schema forbids cycles, so this
  // only fires on diamonds in practice; double-edged as defence against
  // future bugs.
  renderTree(db, rootId, "", down, seen);
}

function buildJsonTree(db: Db, taskId: string, down: boolean, seen: Set<string>): TreeJsonNode[] {
  const edges = getTaskEdges(db, taskId);
  const childIds = down ? edges.dependents : edges.blockers;
  const out: TreeJsonNode[] = [];
  for (const childId of childIds) {
    const child = getTask(db, childId);
    if (!child) continue;
    if (seen.has(childId)) {
      out.push({ task: child, recurrence: true, children: [] });
      continue;
    }
    seen.add(childId);
    out.push({ task: child, children: buildJsonTree(db, childId, down, seen) });
  }
  return out;
}

function renderTree(
  db: Db,
  taskId: string,
  prefix: string,
  down: boolean,
  seen: Set<string>,
): void {
  const edges = getTaskEdges(db, taskId);
  const children = down ? edges.dependents : edges.blockers;
  if (children.length === 0) return;

  for (let i = 0; i < children.length; i++) {
    const childId = children[i];
    if (childId === undefined) continue;
    const isLast = i === children.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const childPrefix = prefix + (isLast ? "    " : "│   ");

    const child = getTask(db, childId);
    if (!child) {
      // Defensive: schema FKs prevent this, but the cascade-on-delete
      // could in theory race a sibling read. Render a clear marker.
      console.log(`${prefix}${branch}${pc.red(`${childId}  (missing!)`)}`);
      continue;
    }

    if (seen.has(childId)) {
      console.log(
        `${prefix}${branch}${formatTreeNodeLabel(child)}  ${pc.dim("(↻ already shown above)")}`,
      );
      continue;
    }

    console.log(`${prefix}${branch}${formatTreeNodeLabel(child)}`);
    seen.add(childId);
    renderTree(db, childId, childPrefix, down, seen);
  }
}

function formatTreeNodeLabel(t: TaskRow): string {
  return `${pc.bold(t.localId)}  ${colorStatus(t.status)}  ${pc.dim(t.title)}`;
}

/**
 * Find the actor of the most recent `task claim <id>` event for a task.
 * Used to surface 'who's working on this' when `tasks.owner IS NULL`
 * (the --self / anonymous-claim case). Returns null when there's been
 * no claim event for this task.
 *
 * Implementation: scan the latest few claim events for this workstream
 * (small bounded N), pattern-match for `task claim <id>` in the payload.
 * Cheap; called only when owner is NULL.
 */
function lastClaimActor(db: Db, workstream: string, localId: string): string | null {
  const recent = listLogs(db, {
    workstream,
    kind: "event",
    limit: 100,
  });
  for (let i = recent.length - 1; i >= 0; i--) {
    const ev = recent[i];
    if (!ev) continue;
    if (ev.payload.startsWith(`task claim ${localId} `)) return ev.source;
  }
  return null;
}

export async function cmdTaskShow(
  db: Db,
  localId: string,
  opts: { json?: boolean; workstream?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const task = getTask(db, localId);
  if (!task) throw new TaskNotFoundError(localId);
  const edges = getTaskEdges(db, localId);
  const notes = listNotes(db, localId);

  // When owner IS NULL but the task is IN_PROGRESS (or recently was),
  // the actor is in agent_logs. Surface it so 'who's working on this'
  // is answerable from `mu task show` alone.
  const lastActor =
    task.owner === null && task.status !== "OPEN"
      ? lastClaimActor(db, task.workstream, task.localId)
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
  console.log(pc.bold(`${task.localId}  —  ${task.title}`));
  console.log(`  workstream : ${task.workstream}`);
  console.log(`  status     : ${task.status}`);
  // owner: registered worker name, or '(self: <actor>)' for an anonymous
  // claim, or '(unowned)' for OPEN tasks.
  const ownerLine =
    task.owner !== null
      ? task.owner
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
  localId: string,
  opts: { json?: boolean; workstream?: string } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  if (!getTask(db, localId)) throw new TaskNotFoundError(localId);
  const notes = listNotes(db, localId);
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

function printNote(n: TaskNoteRow): void {
  const author = n.author ?? "<orchestrator>";
  console.log(`  ${pc.dim(`#${n.id} ${n.createdAt}`)}  ${pc.bold(author)}`);
  for (const line of n.content.split("\n")) {
    console.log(`    ${line}`);
  }
}

export async function cmdTaskRelease(
  db: Db,
  localId: string,
  opts: { reopen?: boolean; evidence?: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const sdkOpts: { reopen: boolean; evidence?: string } = { reopen: opts.reopen ?? false };
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const r = releaseTask(db, localId, sdkOpts);
  // Title push for the agent that just lost the task. Prev-owner could
  // be null (anonymous claim release — nothing to refresh).
  if (r.previousOwner) await refreshAgentTitle(db, r.previousOwner);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    {
      intent: "Reclaim",
      command: `mu task claim ${localId} -w ${ws}  (--self / --for <worker>)`,
    },
    { intent: "Show current state", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
    return;
  }
  if (!r.changed) {
    console.log(pc.dim(`${localId} already unowned (no-op)`));
    printNextSteps(nextSteps);
    return;
  }
  const ownerBit = r.previousOwner ? `was ${pc.bold(r.previousOwner)}` : "was unowned";
  const statusBit = r.previousStatus !== r.status ? ` (${r.previousStatus} → ${r.status})` : "";
  console.log(`Released ${pc.bold(localId)} ${pc.dim(`(${ownerBit})${statusBit}`)}`);
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
  printNextSteps(nextSteps);
}

export async function cmdClaim(
  db: Db,
  localId: string,
  opts: {
    for?: string;
    self?: boolean;
    actor?: string;
    evidence?: string;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
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
  } = {};
  if (opts.for) sdkOpts.agentName = opts.for;
  if (opts.self) sdkOpts.self = true;
  if (opts.actor !== undefined) sdkOpts.actor = opts.actor;
  if (opts.evidence !== undefined) sdkOpts.evidence = opts.evidence;
  const result = await claimTask(db, localId, sdkOpts);
  // Title push for the new owner. Anonymous claims (--self) leave
  // owner=null — nothing to refresh.
  if (result.owner) await refreshAgentTitle(db, result.owner);
  const ws = await resolveWorkstream(opts.workstream);
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
  if (result.owner === null) {
    console.log(
      `Claimed ${pc.bold(localId)} ${pc.dim(`(--self by ${result.actor}; ${result.previousStatus} → ${result.status}; owner=NULL)`)}`,
    );
  } else {
    console.log(
      `Claimed ${pc.bold(localId)} for ${pc.bold(result.owner)} ${pc.dim(`(${result.previousStatus} → ${result.status})`)}`,
    );
  }
  if (opts.evidence) console.log(pc.dim(`  evidence: ${opts.evidence}`));
  printNextSteps(nextSteps);
}

export async function cmdTaskBlock(
  db: Db,
  blocked: string,
  opts: { by: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const r = addBlockEdge(db, blocked, opts.by);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show the dependency tree", command: `mu task tree ${blocked} -w ${ws}` },
    { intent: "Remove this edge", command: `mu task unblock ${blocked} --by ${opts.by} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ blocked, blocker: opts.by, ...r, nextSteps });
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
  blocked: string,
  opts: { by: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertTaskInWorkstream(db, blocked, opts.workstream);
  const r = removeBlockEdge(db, blocked, opts.by);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show what now blocks this task", command: `mu task tree ${blocked} -w ${ws}` },
    { intent: "Re-add the edge", command: `mu task block ${blocked} --by ${opts.by} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ blocked, blocker: opts.by, ...r, nextSteps });
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

export async function cmdTaskDelete(
  db: Db,
  localId: string,
  opts: { workstream?: string; json?: boolean } = {},
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const r = deleteTask(db, localId);
  const nextSteps: NextStep[] = [
    {
      // A snapshot was taken by deleteTask itself before the cascade
      // (snap_schema commit ab82a11). `mu undo` reverts the latest one.
      intent: "Undo (a snapshot was taken before the delete)",
      command: "mu undo --yes",
    },
    {
      intent: "List remaining tasks",
      command: `mu task list -w ${await resolveWorkstream(opts.workstream)}`,
    },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
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

export async function cmdTaskUpdate(
  db: Db,
  localId: string,
  opts: {
    title?: string;
    impact?: number;
    effortDays?: number;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const updateOpts: UpdateTaskOptions = {};
  if (opts.title !== undefined) updateOpts.title = opts.title;
  if (opts.impact !== undefined) updateOpts.impact = opts.impact;
  if (opts.effortDays !== undefined) updateOpts.effortDays = opts.effortDays;
  if (Object.keys(updateOpts).length === 0) {
    throw new UsageError(
      "nothing to update; pass at least one of --title, --impact, --effort-days",
    );
  }
  const r = updateTask(db, localId, updateOpts);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show updated task", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, ...r, nextSteps });
    return;
  }
  if (!r.updated) {
    console.log(pc.dim(`${localId}: no fields differ from current (no-op)`));
    return;
  }
  console.log(`Updated ${pc.bold(localId)} ${pc.dim(`(${r.changedFields.join(", ")})`)}`);
  printNextSteps(nextSteps);
}

export async function cmdTaskReparent(
  db: Db,
  localId: string,
  opts: { blockedBy: string; workstream?: string; json?: boolean },
): Promise<void> {
  assertTaskInWorkstream(db, localId, opts.workstream);
  const blockers = opts.blockedBy
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const r = reparentTask(db, localId, blockers);
  const ws = await resolveWorkstream(opts.workstream);
  const nextSteps: NextStep[] = [
    { intent: "Show the new dependency tree", command: `mu task tree ${localId} -w ${ws}` },
    { intent: "Show the task", command: `mu task show ${localId} -w ${ws}` },
  ];
  if (opts.json) {
    emitJson({ task: localId, blockers, ...r, nextSteps });
    return;
  }
  console.log(
    `Reparented ${pc.bold(localId)} ${pc.dim(`(removed ${r.removedEdges} edges, added ${r.addedEdges})`)}`,
  );
  printNextSteps(nextSteps);
}

export async function cmdTaskWait(
  db: Db,
  ids: readonly string[],
  opts: {
    status?: string;
    any?: boolean;
    timeout?: number;
    workstream?: string;
    json?: boolean;
  },
): Promise<void> {
  if (ids.length === 0) {
    throw new UsageError("mu task wait: at least one task id is required");
  }
  // Validate status (default CLOSED). Same parser as mu task list --status.
  const statusOpt = opts.status !== undefined ? parseStatusOption(opts.status) : undefined;
  // Scope: every id must be in the workstream we resolved (-w error
  // semantics matching every other task verb).
  for (const id of ids) {
    assertTaskInWorkstream(db, id, opts.workstream);
  }
  const ws = await resolveWorkstream(opts.workstream);

  // --timeout in seconds for shell ergonomics; SDK takes ms.
  // 0 in the SDK = wait forever; same convention here.
  const timeoutMs = opts.timeout !== undefined ? opts.timeout * 1000 : 600_000;

  const sdkOpts: {
    status?: TaskWaitResult["tasks"][number]["status"];
    any?: boolean;
    timeoutMs: number;
  } = { timeoutMs };
  if (statusOpt !== undefined) sdkOpts.status = statusOpt;
  if (opts.any) sdkOpts.any = true;

  const result = await waitForTasks(db, ids, sdkOpts);

  // Build nextSteps: for each task that DIDN'T reach the target, suggest
  // mu task show so the operator can investigate. Always include
  // 'pick the next ready task' for the unblocked-orchestrator pattern.
  const stuck = result.tasks.filter((t) => !t.reachedTarget);
  const nextSteps: NextStep[] = [];
  for (const t of stuck) {
    nextSteps.push({
      intent: `Investigate ${t.localId} (status=${t.status})`,
      command: `mu task show ${t.localId} -w ${ws}`,
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
        `${opts.any ? "any-of" : "all-of"} ${ids.length} reached ${targetStatus} in ${result.elapsedMs}ms`,
      );
  console.log(summary);
  for (const t of result.tasks) {
    const marker = t.reachedTarget ? pc.green("✓") : pc.dim("•");
    console.log(`  ${marker} ${pc.bold(t.localId)} ${pc.dim(`(${t.status})`)}`);
  }
  printNextSteps(nextSteps);
  if (result.timedOut) process.exit(5);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireTaskCommands is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import {
  JSON_OPT,
  WORKSTREAM_OPT,
  handle,
  parseImpact,
  parseLines,
  parsePositiveNumber,
} from "../cli.js";

export function wireTaskCommands(program: Command): void {
  const task = program.command("task").description("Task graph commands");

  task
    .command("add [id]")
    .description(
      "Add a task to the graph. The id positional is optional — if omitted, derived from --title via slugify (collisions get _2, _3, … suffixes).",
    )
    .requiredOption("-t, --title <title>", "task title")
    .requiredOption("-i, --impact <n>", "impact 1..100", parseImpact)
    .requiredOption("-e, --effort-days <days>", "effort in days (>0)", parsePositiveNumber)
    .option(
      "-b, --blocked-by <ids>",
      "comma-separated task ids that block this one (this task is blocked by them)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string | undefined) {
      const opts = (this as Command).opts() as {
        title: string;
        impact: number;
        effortDays: number;
        blockedBy?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskAdd(db, id, opts))();
    });

  // --sort key list shared across list/next/ready. `id` is the
  // historical default for `mu task list`; `roi` is the default for
  // `next`/`ready` (the "what should I do" verbs). The two time-based
  // keys (`recency` = updated_at DESC, `age` = created_at ASC) trigger
  // an extra `updated`/`created` column with relative timestamps so
  // the user sees the dimension they sorted by.
  const SORT_OPT_DESC = `sort key (${TASK_SORT_KEYS.join(" | ")})`;

  task
    .command("list")
    .description("List every task in the current workstream (id, status, ROI, owner)")
    .option(...WORKSTREAM_OPT)
    .option(
      "--status <status>",
      `filter by lifecycle status (${TASK_STATUS_LIST}; case-insensitive)`,
    )
    .option("--sort <key>", `${SORT_OPT_DESC} (default id)`)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        status?: string;
        sort?: string;
      };
      return handle((db) => cmdTaskList(db, opts))();
    });

  task
    .command("next")
    .description(
      "Show the next ready task(s) by ROI (impact / effort_days). The 'what should I do?' verb.",
    )
    .option("-n, --lines <k>", "how many top-K tasks to return (default 1)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option("--sort <key>", `${SORT_OPT_DESC} (default roi)`)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        lines?: number;
        json?: boolean;
        sort?: string;
      };
      return handle((db) => cmdTaskNext(db, opts))();
    });

  task
    .command("ready")
    .description("List ready tasks (OPEN with all blockers CLOSED), sorted by ROI")
    .option(...WORKSTREAM_OPT)
    .option("--sort <key>", `${SORT_OPT_DESC} (default roi)`)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        sort?: string;
      };
      return handle((db) => cmdTaskReady(db, opts))();
    });

  task
    .command("blocked")
    .description("List blocked tasks (OPEN with at least one non-CLOSED blocker)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdTaskBlocked(db, opts))();
    });

  task
    .command("goals")
    .description("List tasks with no dependents (graph endpoints; excludes CLOSED)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function () {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdTaskGoals(db, opts))();
    });

  task
    .command("owned-by <agent>")
    .description(
      "List tasks currently owned by an agent (cross-workstream; agent names are global). Excludes CLOSED by default — pass --include-closed for the full historical owner list.",
    )
    .option(
      "--include-closed",
      "include CLOSED tasks (closeTask preserves owner as historical record; default omits them)",
    )
    .option(...JSON_OPT)
    .action(function (agent: string) {
      const opts = (this as Command).opts() as { json?: boolean; includeClosed?: boolean };
      return handle((db) => cmdTaskOwnedBy(db, agent, opts))();
    });

  task
    .command("search <pattern>")
    .description(
      "Substring search on task title and id (case-insensitive). Use --in-notes to also search note content; --all to span all workstreams.",
    )
    .option("--in-notes", "also search task_notes.content")
    .option("--all", "search across all workstreams (default: current)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (pattern: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        all?: boolean;
        inNotes?: boolean;
        json?: boolean;
      };
      return handle((db) => cmdTaskSearch(db, pattern, opts))();
    });

  task
    .command("note <id> <text>")
    .description(
      "Append a note to a task. Author defaults to $MU_AGENT_NAME (env injected at spawn) > pane title > $USER > 'orchestrator'; pass --author to override. Single-quote the text (or use a quoted heredoc) to defer shell expansion of $VAR / $(...) / `cmd`; double quotes expand them in your shell before mu sees the note.",
    )
    .option("--author <name>", "override the auto-detected author label")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string, text: string) {
      const opts = (this as Command).opts() as {
        workstream?: string;
        json?: boolean;
        author?: string;
      };
      return handle((db) => cmdTaskNote(db, id, text, opts))();
    });

  task
    .command("show <id>")
    .description("Show a task: row + edges (blockers/dependents) + notes")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { json?: boolean; workstream?: string };
      return handle((db) => cmdTaskShow(db, id, opts))();
    });

  task
    .command("tree <id>")
    .description(
      "ASCII tree of a task's blockers (default) or dependents (--down). Diamonds collapse to one render with an arrow marker.",
    )
    .option("--down", "render dependents (what this task blocks) instead of blockers")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        down?: boolean;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskTree(db, id, opts))();
    });

  task
    .command("notes <id>")
    .description("List the notes attached to a task (oldest first)")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { json?: boolean; workstream?: string };
      return handle((db) => cmdTaskNotes(db, id, opts))();
    });

  // --evidence <text> on the four lifecycle verbs records what the
  // caller relied on (test output, command exit, observed file change)
  // in the auto-emitted event payload. The verb still trusts the
  // caller; the audit trail records what they said. First inch of
  // the "observed vs claimed state" distinction.
  const EVIDENCE_OPT = [
    "--evidence <text>",
    "record what the caller observed (e.g. 'tests pass: npm test exit 0'); appears verbatim in the event log",
  ] as const;

  task
    .command("close <id>")
    .description("Mark a task CLOSED (idempotent)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskClose(db, id, opts))();
    });

  task
    .command("open <id>")
    .description("Mark a task OPEN — e.g. to reopen something closed by mistake (idempotent)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskOpen(db, id, opts))();
    });

  task
    .command("reject <id>")
    .description(
      "Mark a task REJECTED — terminal 'won't do' (out of scope, duplicate, wontfix). Refuses if open dependents would be stranded; --cascade previews the sub-tree (dry-run by default), --cascade --yes commits.",
    )
    .option(
      "--cascade",
      "include every transitive open/in-progress dependent (dry-run; pass --yes to commit)",
    )
    .option("-y, --yes", "actually sweep the cascade preview (no-op without --cascade)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        cascade?: boolean;
        yes?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskReject(db, id, opts))();
    });

  task
    .command("defer <id>")
    .description(
      "Mark a task DEFERRED — parked, may revisit. Like reject, doesn't satisfy a blocked-by edge; refuses if open dependents would be stranded; --cascade previews the sub-tree (dry-run by default), --cascade --yes commits.",
    )
    .option(
      "--cascade",
      "include every transitive open/in-progress dependent (dry-run; pass --yes to commit)",
    )
    .option("-y, --yes", "actually sweep the cascade preview (no-op without --cascade)")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        cascade?: boolean;
        yes?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskDefer(db, id, opts))();
    });

  task
    .command("release <id>")
    .description(
      "Clear a task's owner; pass --reopen to also flip status back to OPEN (idempotent)",
    )
    .option("--reopen", "also flip status back to OPEN")
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        reopen?: boolean;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskRelease(db, id, opts))();
    });

  task
    .command("claim <id>")
    .description(
      "Claim a task. Default: derive agent from $TMUX_PANE's title (must be a registered worker). " +
        "Use --for <worker> to dispatch. Use --self for orchestrator-direct work (anonymous claim, owner=NULL, actor recorded in agent_logs).",
    )
    .option("-f, --for <agent>", "claim on behalf of a registered worker (dispatch)")
    .option(
      "--self",
      "anonymous claim (orchestrator pattern): owner stays NULL; actor recorded in agent_logs.source. Mutually exclusive with --for.",
    )
    .option(
      "--actor <name>",
      "override the actor name used for the log (only valid with --self; defaults to pane title or $USER)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...EVIDENCE_OPT)
    .option(...JSON_OPT)
    .action(function (taskId: string) {
      const opts = (this as Command).opts() as {
        for?: string;
        self?: boolean;
        actor?: string;
        evidence?: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdClaim(db, taskId, opts))();
    });

  task
    .command("block <blocked>")
    .description(
      "Add a blocking edge: <blocker> --by <id> blocks <blocked>. Validates same-workstream + cycle.",
    )
    .requiredOption("-b, --by <blocker>", "the task that should block <blocked>")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as { by: string; workstream?: string; json?: boolean };
      return handle((db) => cmdTaskBlock(db, blocked, opts))();
    });

  task
    .command("unblock <blocked>")
    .description("Remove a single blocking edge (idempotent)")
    .requiredOption("-b, --by <blocker>", "the task whose blocker edge to remove")
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (blocked: string) {
      const opts = (this as Command).opts() as { by: string; workstream?: string; json?: boolean };
      return handle((db) => cmdTaskUnblock(db, blocked, opts))();
    });

  task
    .command("delete <id>")
    .description(
      "Delete a task. Cascades to task_edges and task_notes via FK. Idempotent on missing.",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as { workstream?: string; json?: boolean };
      return handle((db) => cmdTaskDelete(db, id, opts))();
    });

  task
    .command("update <id>")
    .description(
      "Update scalar fields on a task. Pass at least one of --title, --impact, --effort-days. Use close/open/release for status/owner changes.",
    )
    .option("-t, --title <title>", "new title")
    .option("-i, --impact <n>", "new impact 1..100", parseImpact)
    .option("-e, --effort-days <days>", "new effort in days (>0)", parsePositiveNumber)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        title?: string;
        impact?: number;
        effortDays?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskUpdate(db, id, opts))();
    });

  task
    .command("reparent <id>")
    .description(
      "Atomically replace every incoming edge of <id> with the new --blocked-by list. Pass --blocked-by '' to clear all blockers.",
    )
    .requiredOption(
      "-b, --blocked-by <ids>",
      "comma-separated tasks that block <id> (empty string clears all)",
    )
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (id: string) {
      const opts = (this as Command).opts() as {
        blockedBy: string;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskReparent(db, id, opts))();
    });

  task
    .command("wait <ids...>")
    .description(
      "Block until the listed tasks reach --status (default CLOSED). Default: every task must reach the target (--all). Pass --any to exit on the first one that does. Exit 0 = condition met; 5 = timeout.",
    )
    .option(
      "--status <status>",
      `target status (${TASK_STATUS_LIST}, case-insensitive); default CLOSED`,
    )
    .option("--any", "succeed as soon as ONE listed task reaches the target (default: all must)")
    .option("--timeout <seconds>", "max seconds to wait (0 = forever, default 600)", parseLines)
    .option(...WORKSTREAM_OPT)
    .option(...JSON_OPT)
    .action(function (ids: string[]) {
      const opts = (this as Command).opts() as {
        status?: string;
        any?: boolean;
        timeout?: number;
        workstream?: string;
        json?: boolean;
      };
      return handle((db) => cmdTaskWait(db, ids, opts))();
    });
}
