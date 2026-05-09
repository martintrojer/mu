// mu — `mu task` query verbs (read-only; no DB writes).
//
// list, next, ready, blocked, goals, owned-by, search.
// Plus the `mu my-tasks` / `mu my-next` agent-self aliases (also
// read-only; they query against `resolveSelf(db)` instead of -w).
//
// Extracted from src/cli/tasks.ts as part of refactor_split_large_src_files.

import {
  type TaskSortKey,
  byRoiDesc,
  emitJson,
  formatTaskListTable,
  parseSortOption,
  parseStatusOption,
  relTimeBasisForSort,
  resolveSelf,
  resolveWorkstream,
  sortTasks,
  withRoiAll,
} from "../../cli.js";
import type { Db } from "../../db.js";
import { pc } from "../../output.js";
import {
  type SearchTasksOptions,
  listBlocked,
  listGoals,
  listReady,
  listTasks,
  listTasksByOwner,
  searchTasks,
} from "../../tasks.js";

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

export async function cmdTaskList(
  db: Db,
  opts: { workstream?: string; json?: boolean; status?: string; sort?: string },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const listOpts: Parameters<typeof listTasks>[2] = {};
  if (opts.status !== undefined) {
    listOpts.status = parseStatusOption(opts.status);
  }
  // Default sort for `mu task list` is `id` (preserves prior
  // behaviour: SQL ORDER BY local_id). The other read verbs default
  // to `roi` because their primary use is "what should I do next".
  const sortKey: TaskSortKey = opts.sort === undefined ? "id" : parseSortOption(opts.sort);
  const tasks = sortTasks(listTasks(db, workstream, listOpts), sortKey);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  console.log(pc.bold(`mu-${workstream}`));
  const tableOpts: Parameters<typeof formatTaskListTable>[1] = {};
  const basis = relTimeBasisForSort(sortKey);
  if (basis !== null) tableOpts.relTimeBasis = basis;
  console.log(formatTaskListTable(tasks, tableOpts));
}

// ROI = impact / effort_days. Higher first. Tasks with effortDays=0
// (would divide by zero) sort to the top by treating their ROI as Infinity.
export async function cmdTaskNext(
  db: Db,
  opts: { workstream?: string; lines?: number; json?: boolean; sort?: string },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const k = opts.lines ?? 1;
  const sortKey: TaskSortKey = opts.sort === undefined ? "roi" : parseSortOption(opts.sort);
  const tasks = sortTasks(listReady(db, workstream), sortKey).slice(0, k);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no ready tasks)"));
    return;
  }
  const tableOpts: Parameters<typeof formatTaskListTable>[1] = {};
  const basis = relTimeBasisForSort(sortKey);
  if (basis !== null) tableOpts.relTimeBasis = basis;
  console.log(formatTaskListTable(tasks, tableOpts));
}

export async function cmdTaskReady(
  db: Db,
  opts: { workstream?: string; json?: boolean; sort?: string },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const sortKey: TaskSortKey = opts.sort === undefined ? "roi" : parseSortOption(opts.sort);
  const tasks = sortTasks(listReady(db, workstream), sortKey);
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim("(no ready tasks)"));
    return;
  }
  const tableOpts: Parameters<typeof formatTaskListTable>[1] = {};
  const basis = relTimeBasisForSort(sortKey);
  if (basis !== null) tableOpts.relTimeBasis = basis;
  console.log(formatTaskListTable(tasks, tableOpts));
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
