// Shared task sort keys and comparators.
//
// Used by the CLI task list/next verbs and by the TUI all-tasks popup.
// Keep this below the CLI layer so TUI files never import from src/cli.ts
// (that bundle cycle previously made `node dist/cli.js --help` exit
// silently).

import type { TaskRow } from "../tasks.js";

export const TASK_SORT_KEYS = ["roi", "recency", "age", "id"] as const;
export type TaskSortKey = (typeof TASK_SORT_KEYS)[number];

export function isTaskSortKey(s: string): s is TaskSortKey {
  return (TASK_SORT_KEYS as readonly string[]).includes(s);
}

function roiOf(t: TaskRow): number {
  return t.effortDays > 0 ? t.impact / t.effortDays : Number.POSITIVE_INFINITY;
}

export function byRoiDesc(a: TaskRow, b: TaskRow): number {
  const ra = roiOf(a);
  const rb = roiOf(b);
  if (rb !== ra) return rb - ra;
  if (a.effortDays !== b.effortDays) return a.effortDays - b.effortDays;
  return a.name.localeCompare(b.name);
}

/** Sort a copy of `tasks` by `key`. Pure (does not mutate input). */
export function sortTasks(tasks: readonly TaskRow[], key: TaskSortKey): TaskRow[] {
  const out = tasks.slice();
  switch (key) {
    case "roi":
      return out.sort(byRoiDesc);
    case "recency":
      // updated_at DESC: most-recently-touched first.
      return out.sort((a, b) => {
        const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
        return byUpdated !== 0 ? byUpdated : a.name.localeCompare(b.name);
      });
    case "age":
      // created_at ASC: oldest first ("what's gone stale").
      return out.sort((a, b) => {
        const byCreated = a.createdAt.localeCompare(b.createdAt);
        return byCreated !== 0 ? byCreated : a.name.localeCompare(b.name);
      });
    case "id":
      return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Which timestamp basis the table's relative-time column should use
 *  for the active sort, or `null` if no time column should be shown. */
export function relTimeBasisForSort(key: TaskSortKey): "updatedAt" | "createdAt" | null {
  if (key === "recency") return "updatedAt";
  if (key === "age") return "createdAt";
  return null;
}
