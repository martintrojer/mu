// mu — parallel-track detection via union-find with diamond merge.
//
// Port of a parallel-tracks union-find algorithm cribbed from a
// prior internal multi-agent runtime. The killer feature: when two goals share a prerequisite, their subgraphs
// overlap and they collapse into ONE track, so two agents are never
// assigned tasks that share a dependency.
//
//     goal_a    goal_b           goal_a   goal_b
//        \      /                  \     /
//        shared          →          shared          (1 track)
//          |                          |
//        leaf                       leaf
//
// Algorithm:
//   1. Get all open goals (tasks with no outgoing edges, not CLOSED).
//   2. For each goal, compute its prerequisite subgraph
//      (everything transitively reachable via reverse edges).
//   3. Build union-find: merge any two goals whose subgraphs intersect.
//   4. Each connected component is one Track.

import type { Db } from "./db.js";
import {
  STATUSES_TERMINAL_OR_PARKED,
  type TaskRow,
  getPrerequisites,
  listGoals,
  listReady,
} from "./tasks.js";

export interface Track {
  /** Goal tasks (no outgoing edges) belonging to this track. */
  roots: TaskRow[];
  /** Every task id reachable as a prerequisite of any root in this track. */
  taskIds: ReadonlySet<string>;
  /** Number of READY tasks (per the SQL view) within this track's subgraph. */
  readyCount: number;
}

/**
 * Identify independent task subtrees suitable for parallel assignment
 * within a workstream. Open goals only; CLOSED goals are excluded as
 * they no longer represent work to schedule.
 *
 * Scoping: only goals belonging to `workstream` are considered.
 * Cross-workstream edges are forbidden by addTask, so a goal's
 * prerequisite subgraph is naturally workstream-internal.
 */
export function getParallelTracks(db: Db, workstream: string): Track[] {
  // listGoals already filters via the SQL view (NOT IN CLOSED/REJECTED/
  // DEFERRED), but defence-in-depth: a stale db snapshot or future view
  // tweak shouldn't let parked/terminal goals leak into track count.
  const goals = listGoals(db, workstream).filter(
    (g) => !STATUSES_TERMINAL_OR_PARKED.includes(g.status),
  );
  if (goals.length === 0) return [];

  // 2. Compute prerequisite subgraph for each goal.
  const subgraphs = new Map<string, Set<string>>();
  for (const goal of goals) {
    subgraphs.set(goal.name, getPrerequisites(db, goal.name, workstream));
  }

  // 3. Union-find: merge goals whose subgraphs overlap.
  const uf = new UnionFind(goals.map((g) => g.name));
  for (let i = 0; i < goals.length; i++) {
    const a = goals[i];
    if (!a) continue;
    for (let j = i + 1; j < goals.length; j++) {
      const b = goals[j];
      if (!b) continue;
      const subA = subgraphs.get(a.name);
      const subB = subgraphs.get(b.name);
      if (subA && subB && overlaps(subA, subB)) {
        uf.union(a.name, b.name);
      }
    }
  }

  // 4. Group goals + subgraph task ids by union-find root.
  const componentTaskIds = new Map<string, Set<string>>();
  const componentRoots = new Map<string, TaskRow[]>();
  for (const goal of goals) {
    const root = uf.find(goal.name);
    let bucket = componentTaskIds.get(root);
    if (!bucket) {
      bucket = new Set<string>();
      componentTaskIds.set(root, bucket);
      componentRoots.set(root, []);
    }
    componentRoots.get(root)?.push(goal);
    const sub = subgraphs.get(goal.name);
    if (sub) {
      for (const id of sub) bucket.add(id);
    }
  }

  // 5. Compute ready counts per track.
  const readyIds = new Set(listReady(db, workstream).map((t) => t.name));
  const tracks: Track[] = [];
  for (const [root, taskIds] of componentTaskIds) {
    const trackRoots = componentRoots.get(root) ?? [];
    let readyCount = 0;
    for (const id of taskIds) if (readyIds.has(id)) readyCount++;
    tracks.push({ roots: trackRoots, taskIds, readyCount });
  }

  // Stable order: by primary root's localId so output is deterministic.
  tracks.sort((a, b) => {
    const an = a.roots[0]?.name ?? "";
    const bn = b.roots[0]?.name ?? "";
    return an.localeCompare(bn);
  });
  return tracks;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
  // Iterate the smaller set for O(min(|a|, |b|)) lookups.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) return true;
  return false;
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly rank = new Map<string, number>();

  constructor(items: readonly string[]) {
    for (const item of items) {
      this.parent.set(item, item);
      this.rank.set(item, 0);
    }
  }

  find(x: string): string {
    let root = x;
    while (true) {
      const next = this.parent.get(root);
      if (next === undefined || next === root) break;
      root = next;
    }
    // Path compression.
    let curr = x;
    while (curr !== root) {
      const next = this.parent.get(curr);
      if (next === undefined) break;
      this.parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const rankA = this.rank.get(rootA) ?? 0;
    const rankB = this.rank.get(rootB) ?? 0;
    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }
}
