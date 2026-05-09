// mu — `mu task` query verbs (read-only; no DB writes).
//
// list, next, owned-by.
// Plus the `mu me tasks` / `mu me next` agent-self subcommands (also
// read-only; they query against `resolveSelf(db)` instead of -w —
// wired in src/cli/agents.ts via `wireSelfCommands`).
//
// Extracted from src/cli/tasks.ts as part of refactor_split_large_src_files.
//
// Removed in audit_cleanups_post_schema_v5_wave: `task blocked`,
// `task goals`, `task search`, `task ready` (the latter merged into
// `task next -n 0`, which now means "all ready, unlimited"). The
// underlying SDK helpers (`listBlocked`, `listGoals`, `searchTasks`)
// survive — `mu state` / `mu tracks` consume them, and `searchTasks`
// keeps its unit-test coverage as reusable surface. The audit's SQL
// recipes for the removed verbs live in docs/USAGE_GUIDE.md
// "What's NOT in 0.2.0".

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
  listReady,
  listTasks,
  listTasksByOwner,
  listTasksByOwnerCrossWorkstream,
} from "../../tasks.js";

export async function cmdMyTasks(
  db: Db,
  opts: { json?: boolean; includeClosed?: boolean } = {},
): Promise<void> {
  const self = resolveSelf(db);
  // Scope by self.workstream so a same-named worker in another
  // workstream can't pollute this list.
  const tasks = listTasksByOwner(db, self.workstream, self.name, {
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
  const sorted = listReady(db, self.workstream).sort(byRoiDesc);
  const tasks = k === 0 ? sorted : sorted.slice(0, k);
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
//
// `-n 0` means "unlimited" — the merged-in `task ready` semantics
// from audit_merge_task_ready_into_next. Default K=1 keeps the
// historical "what should I do right now?" shape.
export async function cmdTaskNext(
  db: Db,
  opts: { workstream?: string; lines?: number; json?: boolean; sort?: string },
): Promise<void> {
  const workstream = await resolveWorkstream(opts.workstream);
  const k = opts.lines ?? 1;
  const sortKey: TaskSortKey = opts.sort === undefined ? "roi" : parseSortOption(opts.sort);
  const sorted = sortTasks(listReady(db, workstream), sortKey);
  const tasks = k === 0 ? sorted : sorted.slice(0, k);
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

export async function cmdTaskOwnedBy(
  db: Db,
  agent: string,
  opts: { json?: boolean; includeClosed?: boolean; workstream?: string; all?: boolean } = {},
): Promise<void> {
  // Default behaviour: scope to the resolved workstream (so the common
  // case 'mu task owned-by worker-1' returns only this workstream's
  // worker-1, not every workstream's). --all explicitly opts into the
  // cross-workstream view via listTasksByOwnerCrossWorkstream.
  const includeClosed = opts.includeClosed ?? false;
  const tasks = opts.all
    ? listTasksByOwnerCrossWorkstream(db, agent, { includeClosed })
    : listTasksByOwner(db, await resolveWorkstream(opts.workstream), agent, { includeClosed });
  if (opts.json) {
    emitJson(withRoiAll(tasks));
    return;
  }
  if (tasks.length === 0) {
    console.log(pc.dim(`(no tasks owned by ${agent})`));
    return;
  }
  // Surface the workstream column when we're showing cross-workstream
  // results (--all); for the scoped (default) case the column would
  // be redundant.
  console.log(formatTaskListTable(tasks, { withWorkstream: opts.all === true }));
}
