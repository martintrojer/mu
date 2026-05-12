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

import { assertTaskInWorkstream, colorStatus, emitJson, resolveEntityRef } from "../../cli.js";
import { renderTaskTree } from "../../dag.js";
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

export async function cmdTaskTree(db: Db, rawId: string, opts: TreeOpts): Promise<void> {
  // resolveEntityRef parses `<workstream>/<name>` if present, else uses
  // opts.workstream. Returns the resolved (name, workstream) pair so we
  // never re-resolve downstream — the workstream is mandatory on every
  // SDK call that resolves an entity by name.
  const { name: rootId, workstream: ws } = await resolveEntityRef(db, rawId, opts, "task");
  assertTaskInWorkstream(db, rootId, ws);
  const root = getTask(db, rootId, ws);
  if (!root) throw new TaskNotFoundError(rootId);
  const down = opts.down ?? false;
  const seen = new Set<string>([rootId]);

  if (opts.json) {
    const node: TreeJsonNode = {
      task: root,
      children: buildJsonTree(db, ws, rootId, down, seen),
    };
    emitJson({ direction: down ? "dependents" : "blockers", root: node });
    return;
  }

  const direction = down ? "dependents" : "blockers";
  const swapHint = down ? "swap to --no-down for blockers" : "--down for dependents";
  console.log(pc.bold(`Tree of ${rootId}  ${pc.dim(`(${direction} below; ${swapHint})`)}`));
  console.log(
    renderTaskTree(db, ws, root, down ? "dependents" : "blockers", (task) =>
      colorStatus(task.status),
    ),
  );
}

function buildJsonTree(
  db: Db,
  workstream: string,
  taskId: string,
  down: boolean,
  seen: Set<string>,
): TreeJsonNode[] {
  const edges = getTaskEdges(db, taskId, workstream);
  const childIds = down ? edges.dependents : edges.blockers;
  const out: TreeJsonNode[] = [];
  for (const childId of childIds) {
    const child = getTask(db, childId, workstream);
    if (!child) continue;
    if (seen.has(childId)) {
      out.push({ task: child, recurrence: true, children: [] });
      continue;
    }
    seen.add(childId);
    out.push({ task: child, children: buildJsonTree(db, workstream, childId, down, seen) });
  }
  return out;
}
