// mu — task-DAG read + ASCII forest rendering helpers.
//
// Shared by the static `mu task tree` command and the read-only TUI DAG
// popup. Pure rendering lives here so the box-drawing characters and
// diamond-collapse semantics have one implementation.

import pc from "picocolors";
import type { Db } from "./db.js";
import type { TaskStatus } from "./tasks/status.js";
import { listTasks, type TaskRow } from "./tasks.js";

// One-line marker appended to a tree node when its subtree was already
// rendered earlier in the forest (DAG diamond collapse). Symbol-only
// + dimmed: the ↻ glyph carries the recurrence semantics, the dim
// keeps it from competing with the task title for the eye.
const RECURRENCE_MARKER = `  ${pc.dim("(↻)")}`;

export interface FullDag {
  /** Root tasks: no incoming `blocks` edge (no blockers). */
  roots: TaskRow[];
  /** Edges map parent task name → child task names (what parent blocks). */
  edges: Map<string, string[]>;
  /** All tasks in the workstream, keyed by operator-facing name. */
  tasks: Map<string, TaskRow>;
}

export type TaskStatusLabelFn = (task: TaskRow) => string;

export interface RenderTreeOptions {
  /** Include the task title after the name + status label. Default: true. */
  includeTitle?: boolean;
}

export interface LoadFullDagOptions {
  /** Optional visible-status filter. Omitted = every task status. */
  statuses?: ReadonlySet<TaskStatus>;
}

export function loadFullDag(db: Db, workstream: string, opts: LoadFullDagOptions = {}): FullDag {
  const tasks = listTasks(db, workstream).filter(
    (t) => opts.statuses === undefined || opts.statuses.has(t.status),
  );
  const byName = new Map(tasks.map((t) => [t.name, t]));
  const incoming = new Set<string>();
  const edges = new Map<string, string[]>();

  for (const task of tasks) {
    edges.set(task.name, []);
  }

  // Start from task_edges deliberately. With ordinary JOINs plus the
  // same-workstream guard below, SQLite chose tasks(src) × tasks(dst)
  // before probing the edge PK — quadratic in workstream size. CROSS JOIN
  // fixes the loop order at edges → two INTEGER-PK lookups while retaining
  // the guard against malformed cross-workstream rows.
  const rows = db
    .prepare(
      `SELECT src.local_id AS parent, dst.local_id AS child
         FROM task_edges e
   CROSS JOIN tasks src
   CROSS JOIN tasks dst
        WHERE src.id = e.from_task_id
          AND dst.id = e.to_task_id
          AND src.workstream_id = (SELECT id FROM workstreams WHERE name = ?)
          AND dst.workstream_id = src.workstream_id
        ORDER BY src.local_id, dst.local_id`,
    )
    .all(workstream) as { parent: string; child: string }[];

  for (const row of rows) {
    if (!byName.has(row.parent) || !byName.has(row.child)) continue;
    incoming.add(row.child);
    const children = edges.get(row.parent) ?? [];
    children.push(row.child);
    edges.set(row.parent, children);
  }

  const roots = tasks.filter((t) => !incoming.has(t.name));
  return { roots, edges, tasks: byName };
}

/**
 * Render a DAG forest in the same ASCII shape as `mu task tree --down`:
 * each root is printed as a header node, dependents are below it, and
 * DAG diamonds collapse after the first full subtree render with a
 * one-line recurrence marker.
 */
export function renderForest(
  roots: readonly TaskRow[],
  edges: ReadonlyMap<string, readonly string[]>,
  statusFn: TaskStatusLabelFn,
  tasksByName?: ReadonlyMap<string, TaskRow>,
  opts: RenderTreeOptions = {},
): string {
  const byName = new Map(tasksByName ?? roots.map((t) => [t.name, t]));
  const seen = new Set<string>();
  const sections: string[] = [];

  for (const root of roots) {
    if (!byName.has(root.name)) byName.set(root.name, root);
    const lines = [formatTreeNodeLabel(root, statusFn, opts)];
    if (seen.has(root.name)) {
      lines[0] = `${lines[0]}${RECURRENCE_MARKER}`;
    } else {
      seen.add(root.name);
      renderForestChildren(root.name, "", edges, byName, statusFn, seen, lines, opts);
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

export function renderTaskTree(
  db: Db,
  workstream: string,
  root: TaskRow,
  direction: "blockers" | "dependents",
  statusFn: TaskStatusLabelFn,
  opts: RenderTreeOptions = {},
): string {
  const dag = loadFullDag(db, workstream);
  if (direction === "dependents") {
    return renderForest([root], dag.edges, statusFn, dag.tasks, opts);
  }

  const blockers = new Map<string, string[]>([...dag.tasks.keys()].map((name) => [name, []]));
  for (const [blocker, dependents] of dag.edges) {
    for (const dependent of dependents) blockers.get(dependent)?.push(blocker);
  }
  for (const names of blockers.values()) names.sort();
  return renderForest([root], blockers, statusFn, dag.tasks, opts);
}

function renderForestChildren(
  taskName: string,
  prefix: string,
  edges: ReadonlyMap<string, readonly string[]>,
  byName: Map<string, TaskRow>,
  statusFn: TaskStatusLabelFn,
  seen: Set<string>,
  lines: string[],
  opts: RenderTreeOptions,
): void {
  const children = edges.get(taskName) ?? [];
  for (let i = 0; i < children.length; i++) {
    const childName = children[i];
    if (childName === undefined) continue;
    const isLast = i === children.length - 1;
    const branch = isLast ? "└── " : "├── ";
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    const child = byName.get(childName);

    if (!child) {
      lines.push(`${prefix}${branch}${childName}  (missing!)`);
      continue;
    }

    if (seen.has(childName)) {
      lines.push(
        `${prefix}${branch}${formatTreeNodeLabel(child, statusFn, opts)}${RECURRENCE_MARKER}`,
      );
      continue;
    }

    lines.push(`${prefix}${branch}${formatTreeNodeLabel(child, statusFn, opts)}`);
    seen.add(childName);
    renderForestChildren(childName, childPrefix, edges, byName, statusFn, seen, lines, opts);
  }
}

export function formatTreeNodeLabel(
  t: TaskRow,
  statusFn: TaskStatusLabelFn,
  opts: RenderTreeOptions = {},
): string {
  const base = `${t.name}  ${statusFn(t)}`;
  if (opts.includeTitle === false) return base;
  return `${base}  ${t.title}`;
}
