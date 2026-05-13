// mu — task edge reads and mutations.

import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { lookupTaskAnyWorkstream, taskIdFor, touchTask } from "./core.js";
import { CrossWorkstreamEdgeError, CycleError, TaskNotFoundError } from "./errors.js";
import { getTask } from "./queries.js";
import type { TaskStatus } from "./status.js";

export interface TaskEdges {
  /** Tasks that must close before this one can start (blockers). */
  blockers: string[];
  /** Tasks that this one blocks (dependents). */
  dependents: string[];
}

/** One end of an edge with the neighbour's current status attached.
 *  Used by `mu task show` to group blockers/dependents into
 *  "still gating" vs "satisfied" buckets without making the renderer
 *  do a second round-trip to the DB per neighbour. */
export interface TaskEdgeWithStatus {
  name: string;
  status: TaskStatus;
}

export interface TaskEdgesWithStatus {
  /** Tasks that must close before this one can start (blockers),
   *  carrying each blocker's current status. */
  blockers: TaskEdgeWithStatus[];
  /** Tasks that this one blocks (dependents), carrying each
   *  dependent's current status. */
  dependents: TaskEdgeWithStatus[];
}

/**
 * Direct (one-hop) edges for a task. For transitive prerequisites, use
 * `getPrerequisites()`; this helper is the immediate-neighbour view used
 * by `mu task show`.
 */
export function getTaskEdges(db: Db, taskLocalId: string, workstream: string): TaskEdges {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return { blockers: [], dependents: [] };
  const blockers = (
    db
      .prepare(
        `SELECT t.local_id AS id FROM task_edges e
           JOIN tasks t ON t.id = e.from_task_id
          WHERE e.to_task_id = ? ORDER BY t.local_id`,
      )
      .all(taskId) as { id: string }[]
  ).map((r) => r.id);
  const dependents = (
    db
      .prepare(
        `SELECT t.local_id AS id FROM task_edges e
           JOIN tasks t ON t.id = e.to_task_id
          WHERE e.from_task_id = ? ORDER BY t.local_id`,
      )
      .all(taskId) as { id: string }[]
  ).map((r) => r.id);
  return { blockers, dependents };
}

/**
 * Same one-hop edge view as `getTaskEdges`, but each neighbour is
 * returned as `{ name, status }` so callers can group / colour by
 * status without an N+1 round-trip. Used by `mu task show` to split
 * "blocked by" (still-gating) from "satisfied" (already-CLOSED)
 * blockers, and the symmetric split on the dependents side
 * (task_show_blocked_by_renders_closed). The status is the neighbour's
 * full TaskStatus, not just OPEN/CLOSED — REJECTED/DEFERRED still
 * gate downstream work, so the renderer keeps them in the
 * still-gating bucket.
 */
export function getTaskEdgesWithStatus(
  db: Db,
  taskLocalId: string,
  workstream: string,
): TaskEdgesWithStatus {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return { blockers: [], dependents: [] };
  const blockers = db
    .prepare(
      `SELECT t.local_id AS name, t.status AS status FROM task_edges e
         JOIN tasks t ON t.id = e.from_task_id
        WHERE e.to_task_id = ? ORDER BY t.local_id`,
    )
    .all(taskId) as TaskEdgeWithStatus[];
  const dependents = db
    .prepare(
      `SELECT t.local_id AS name, t.status AS status FROM task_edges e
         JOIN tasks t ON t.id = e.to_task_id
        WHERE e.from_task_id = ? ORDER BY t.local_id`,
    )
    .all(taskId) as TaskEdgeWithStatus[];
  return { blockers, dependents };
}

/**
 * All tasks transitively reachable from `taskId` via reverse-edge
 * traversal (i.e. the set of tasks that block this one), including the
 * task itself.
 */
export function getPrerequisites(db: Db, taskLocalId: string, workstream: string): Set<string> {
  const taskId = taskIdFor(db, taskLocalId, workstream);
  if (taskId === null) return new Set([taskLocalId]);
  // Walk reverse edges in surrogate-id space, then translate back to
  // local_id strings. The seed must be the surrogate id; the result
  // includes the seed task itself (callers like the tracks union-find
  // rely on the inclusive set).
  const rows = db
    .prepare(
      `WITH RECURSIVE reach(node) AS (
         SELECT ?
         UNION
         SELECT from_task_id FROM task_edges, reach WHERE to_task_id = reach.node
       )
       SELECT t.local_id AS local_id FROM reach r JOIN tasks t ON t.id = r.node`,
    )
    .all(taskId) as { local_id: string }[];
  return new Set(rows.map((r) => r.local_id));
}

/**
 * Adding edge `from -> to` creates a cycle iff there's already a path
 * `to -> ... -> from`. SQL recursive CTE expresses this exactly.
 */
export function wouldCreateCycle(db: Db, fromId: number, toId: number): boolean {
  if (fromId === toId) return true;
  const result = db
    .prepare(
      `WITH RECURSIVE forward(node) AS (
         SELECT ?
         UNION
         SELECT to_task_id FROM task_edges, forward WHERE from_task_id = forward.node
       )
       SELECT 1 AS hit FROM forward WHERE node = ? LIMIT 1`,
    )
    .get(toId, fromId) as { hit: number } | undefined;
  return result !== undefined;
}

export interface BlockEdgeResult {
  /** True iff a row was actually inserted (vs. already present). */
  added: boolean;
}

/**
 * Add the edge `blocker → blocked` ('blocker blocks blocked').
 * Idempotent (existing edge → `added: false`). Validates:
 *
 *   - both tasks exist
 *   - same workstream (cross-workstream edges forbidden)
 *   - no cycle (the new edge wouldn't form a path blocked → ... → blocker)
 *   - blocker ≠ blocked (no self-reference)
 */
export function addBlockEdge(
  db: Db,
  workstream: string,
  blocked: string,
  blocker: string,
): BlockEdgeResult {
  if (blocked === blocker) {
    // Surface as a typed CycleError so the CLI maps it to exit 4 (conflict)
    // rather than letting the schema CHECK fire as a generic SQL error.
    throw new CycleError(blocker, blocked);
  }
  const blockedRow = getTask(db, blocked, workstream);
  if (!blockedRow) throw new TaskNotFoundError(blocked);
  // Resolve the blocker globally so a cross-workstream blocker surfaces
  // CrossWorkstreamEdgeError (clearer than TaskNotFoundError). Cycle
  // check + same-workstream guard run after.
  const blockerRow = lookupTaskAnyWorkstream(db, blocker);
  if (!blockerRow) throw new TaskNotFoundError(blocker);
  if (blockedRow.workstreamName !== blockerRow.workstreamName) {
    throw new CrossWorkstreamEdgeError(
      blocker,
      blockerRow.workstreamName,
      blocked,
      blockedRow.workstreamName,
    );
  }
  const blockedId = taskIdFor(db, blocked, blockedRow.workstreamName);
  const blockerId = taskIdFor(db, blocker, blockerRow.workstreamName);
  if (blockedId === null || blockerId === null) throw new TaskNotFoundError(blocked);
  if (wouldCreateCycle(db, blockerId, blockedId)) {
    throw new CycleError(blocker, blocked);
  }
  const now = new Date().toISOString();
  const added = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT OR IGNORE INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
      )
      .run(blockerId, blockedId, now);
    if (result.changes > 0) {
      // Bump the BLOCKED task — its blocker set changed. The blocker
      // itself is unaffected. Aligned with reparentTask, which also
      // bumps the FROM_TASK side (the task whose blockers shifted).
      touchTask(db, blockedId, now);
      return true;
    }
    return false;
  })();
  if (added) emitEvent(db, blockedRow.workstreamName, `task block ${blocked} by ${blocker}`);
  return { added };
}

export interface RemoveBlockEdgeResult {
  /** True iff a row was actually deleted (vs. no such edge). */
  removed: boolean;
}

/**
 * Remove the edge `blocker → blocked`. Idempotent (no edge →
 * `removed: false`). Does NOT validate task existence — if the
 * edge is gone there's nothing to do, regardless of whether the
 * tasks are gone too.
 */
export function removeBlockEdge(
  db: Db,
  workstream: string,
  blocked: string,
  blocker: string,
): RemoveBlockEdgeResult {
  const blockedRow = getTask(db, blocked, workstream);
  if (!blockedRow) return { removed: false };
  const blockerRow = getTask(db, blocker, workstream);
  if (!blockerRow) return { removed: false };
  const blockedId = taskIdFor(db, blocked, blockedRow.workstreamName);
  const blockerId = taskIdFor(db, blocker, blockerRow.workstreamName);
  if (blockedId === null || blockerId === null) return { removed: false };
  const removed = db.transaction(() => {
    const result = db
      .prepare("DELETE FROM task_edges WHERE from_task_id = ? AND to_task_id = ?")
      .run(blockerId, blockedId);
    if (result.changes > 0) {
      // Bump the BLOCKED task — its blocker set just shrank.
      touchTask(db, blockedId);
      return true;
    }
    return false;
  })();
  if (removed) {
    emitEvent(db, blockedRow.workstreamName, `task unblock ${blocked} by ${blocker}`);
  }
  return { removed };
}

export interface ReparentTaskResult {
  /** Edges removed (i.e. all incoming `to_task = taskId` edges). */
  removedEdges: number;
  /** Edges added (== blockers.length on success). */
  addedEdges: number;
}

/**
 * Atomically replace every incoming edge of `taskId` with new ones
 * `blocker[i] → taskId`. Pass an empty `blockers` array to clear all
 * incoming edges (the task becomes ready iff its status allows).
 *
 * Validates ALL new blockers up-front (existence + same workstream +
 * cycle check); if any fails, no DELETE happens — the call is fully
 * atomic via a single transaction.
 *
 * Cycle reasoning: removing the existing incoming edges to `taskId`
 * doesn't change `taskId`'s OUTGOING reachability, so
 * `wouldCreateCycle(db, blocker, taskId)` evaluated against the
 * pre-state gives the right answer for each new edge.
 */
export function reparentTask(
  db: Db,
  taskLocalId: string,
  blockers: readonly string[],
  scope: { workstream: string },
): ReparentTaskResult {
  const task = getTask(db, taskLocalId, scope.workstream);
  if (!task) throw new TaskNotFoundError(taskLocalId);
  const taskSurrogateId = taskIdFor(db, task.name, task.workstreamName);
  if (taskSurrogateId === null) throw new TaskNotFoundError(taskLocalId);

  // Resolve every blocker up-front to its surrogate id; do all
  // existence + same-workstream + cycle checks before any DELETE.
  // Look up blockers across all workstreams so a blocker that exists in
  // a DIFFERENT workstream surfaces CrossWorkstreamEdgeError (clearer
  // than TaskNotFoundError).
  const blockerIds: number[] = [];
  for (const blockerLocalId of blockers) {
    if (blockerLocalId === taskLocalId) {
      throw new CycleError(blockerLocalId, taskLocalId);
    }
    const blocker = lookupTaskAnyWorkstream(db, blockerLocalId);
    if (!blocker) throw new TaskNotFoundError(blockerLocalId);
    if (blocker.workstreamName !== task.workstreamName) {
      throw new CrossWorkstreamEdgeError(
        blockerLocalId,
        blocker.workstreamName,
        taskLocalId,
        task.workstreamName,
      );
    }
    const blockerId = taskIdFor(db, blocker.name, blocker.workstreamName);
    if (blockerId === null) throw new TaskNotFoundError(blockerLocalId);
    if (wouldCreateCycle(db, blockerId, taskSurrogateId)) {
      throw new CycleError(blockerLocalId, taskLocalId);
    }
    blockerIds.push(blockerId);
  }

  return db.transaction(() => {
    const removed = db.prepare("DELETE FROM task_edges WHERE to_task_id = ?").run(taskSurrogateId);
    const insertEdge = db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    );
    const now = new Date().toISOString();
    for (const blockerId of blockerIds) {
      insertEdge.run(blockerId, taskSurrogateId, now);
    }
    // Bump the reparented task itself — its blocker set just changed.
    // No-op when both removed and added were 0 (effectively a no-op
    // call); skip in that case so an idempotent `reparent --blocked-by
    // <same-set>` stays a true no-op for `--sort recency`.
    if (removed.changes > 0 || blockerIds.length > 0) {
      touchTask(db, taskSurrogateId, now);
    }
    const blockersBit = blockers.length > 0 ? `, new=${[...blockers].join(",")}` : "";
    emitEvent(
      db,
      task.workstreamName,
      `task reparent ${taskLocalId} (removed ${removed.changes} edges, added ${blockers.length}${blockersBit})`,
    );
    return { removedEdges: removed.changes, addedEdges: blockers.length };
  })();
}
