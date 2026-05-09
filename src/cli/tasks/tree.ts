// mu — `mu task tree` verb (ASCII / JSON dependency rendering).
//
// Renders the blocker subtree (default) or dependent subtree (--down)
// of a task. Diamonds — a node reachable by two parent paths — collapse
// to one full subtree render plus a one-line "↻ already shown" marker
// at every later occurrence. Schema forbids cycles, so the seen-set
// only fires on diamonds in practice; double-edged as defence against
// future bugs.
//
// Extracted from src/cli/tasks.ts as part of the wire-out follow-up
// to refactor_split_large_src_files.

import { assertTaskInWorkstream, colorStatus, emitJson } from "../../cli.js";
import type { Db } from "../../db.js";
import { pc } from "../../output.js";
import { TaskNotFoundError, type TaskRow, getTask, getTaskEdges } from "../../tasks.js";

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
