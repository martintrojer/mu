// mu — task-DAG read + ASCII forest rendering helpers.
//
// Shared by the static `mu task tree` command and the read-only TUI DAG
// popup. Pure rendering lives here so the box-drawing characters and
// diamond-collapse semantics have one implementation.

import type { Db } from "./db.js";
import { type TaskRow, getTask, listTasks } from "./tasks.js";
import type { TaskStatus } from "./tasks/status.js";

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

  const rows = db
    .prepare(
      `SELECT src.local_id AS parent, dst.local_id AS child
         FROM task_edges e
         JOIN tasks src ON src.id = e.from_task_id
         JOIN tasks dst ON dst.id = e.to_task_id
         JOIN workstreams ws ON ws.id = src.workstream_id
        WHERE ws.name = ?
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
      lines[0] = `${lines[0]}  (↻ already shown above)`;
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
  const edges = new Map<string, string[]>();
  const byName = new Map<string, TaskRow>([[root.name, root]]);
  const visited = new Set<string>();
  collectTreeEdges(db, workstream, root.name, direction, edges, byName, visited);
  return renderForest([root], edges, statusFn, byName, opts);
}

function collectTreeEdges(
  db: Db,
  workstream: string,
  taskName: string,
  direction: "blockers" | "dependents",
  edges: Map<string, string[]>,
  byName: Map<string, TaskRow>,
  visited: Set<string>,
): void {
  if (visited.has(taskName)) return;
  visited.add(taskName);
  const rows = db
    .prepare(
      direction === "dependents"
        ? `SELECT child.local_id AS name
             FROM task_edges e
             JOIN tasks parent ON parent.id = e.from_task_id
             JOIN tasks child ON child.id = e.to_task_id
             JOIN workstreams ws ON ws.id = parent.workstream_id
            WHERE ws.name = ? AND parent.local_id = ?
            ORDER BY child.local_id`
        : `SELECT parent.local_id AS name
             FROM task_edges e
             JOIN tasks parent ON parent.id = e.from_task_id
             JOIN tasks child ON child.id = e.to_task_id
             JOIN workstreams ws ON ws.id = child.workstream_id
            WHERE ws.name = ? AND child.local_id = ?
            ORDER BY parent.local_id`,
    )
    .all(workstream, taskName) as { name: string }[];
  const children = rows.map((r) => r.name);
  edges.set(taskName, children);

  for (const childName of children) {
    if (!byName.has(childName)) {
      const child = getTask(db, childName, workstream);
      if (child) byName.set(childName, child);
    }
    collectTreeEdges(db, workstream, childName, direction, edges, byName, visited);
  }
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
        `${prefix}${branch}${formatTreeNodeLabel(child, statusFn, opts)}  (↻ already shown above)`,
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
