// mu — `mu task` query verbs (read-only; no DB writes).
//
// list, next, ready, blocked, goals, owned-by, search.
//
// Extracted from src/cli/tasks.ts as part of refactor_split_large_src_files.

import pc from "picocolors";
import {
  byRoiDesc,
  emitJson,
  formatTaskListTable,
  parseStatusOption,
  resolveWorkstream,
  withRoiAll,
} from "../../cli.js";
import type { Db } from "../../db.js";
import {
  type SearchTasksOptions,
  listBlocked,
  listGoals,
  listReady,
  listTasks,
  listTasksByOwner,
  searchTasks,
} from "../../tasks.js";

export async function cmdTaskList(
  db: Db,
  opts: { workstream?: string; json?: boolean; status?: string },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const listOpts: Parameters<typeof listTasks>[2] = {};
  if (opts.status !== undefined) {
    listOpts.status = parseStatusOption(opts.status);
  }
  const tasks = listTasks(db, workstream, listOpts);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  console.log(pc.bold(`mu-${workstream}`));
  console.log(formatTaskListTable(tasks));
}

// ROI = impact / effort_days. Higher first. Tasks with effortDays=0
// (would divide by zero) sort to the top by treating their ROI as Infinity.
export async function cmdTaskNext(
  db: Db,
  opts: { workstream?: string; lines?: number; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const k = opts.lines ?? 1;
  const tasks = listReady(db, workstream).sort(byRoiDesc).slice(0, k);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no ready tasks)"));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

export async function cmdTaskReady(
  db: Db,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const tasks = listReady(db, workstream).sort(byRoiDesc);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no ready tasks)"));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

export async function cmdTaskBlocked(
  db: Db,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const tasks = listBlocked(db, workstream);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no blocked tasks)"));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

export async function cmdTaskGoals(
  db: Db,
  opts: { workstream?: string; json?: boolean },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const tasks = listGoals(db, workstream);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no goals — every task has a dependent)"));
    return;
  }
  console.log(formatTaskListTable(tasks));
}

export async function cmdTaskOwnedBy(
  db: Db,
  agent: string,
  opts: { json?: boolean; includeClosed?: boolean } = {},
): Promise<void> {
  const tasks = listTasksByOwner(db, agent, {
    includeClosed: opts.includeClosed ?? false,
  });
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim(`(no tasks owned by ${agent})`));
    return;
  }
  // owned-by is cross-workstream by design (agent names are global)
  // so always show the workstream column.
  console.log(formatTaskListTable(tasks, { withWorkstream: true }));
}

export async function cmdTaskSearch(
  db: Db,
  pattern: string,
  opts: { workstream?: string; all?: boolean; inNotes?: boolean; json?: boolean },
): Promise<void> {
  const searchOpts: SearchTasksOptions = {};
  if (opts.inNotes) searchOpts.includeNotes = true;
  if (!opts.all) searchOpts.workstream = await resolveWorkstream(opts.workstream);

  const tasks = searchTasks(db, pattern, searchOpts);
  if (opts.json) {
    emitJson(tasks);
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim(`(no matches for "${pattern}")`));
    return;
  }
  console.log(formatTaskListTable(tasks, { withWorkstream: opts.all === true }));
}
