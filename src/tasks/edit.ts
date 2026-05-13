// mu — task edit/write verbs: add task, add note, update, delete.

import { type Db, resolveWorkstreamId } from "../db.js";
import { emitEvent } from "../logs.js";
import { captureSnapshot } from "../snapshots.js";
import { ensureWorkstream } from "../workstream.js";
import { taskIdFor, touchTask } from "./core.js";
import { wouldCreateCycle } from "./edges.js";
import {
  CrossWorkstreamEdgeError,
  CycleError,
  TaskExistsError,
  TaskIdInvalidError,
  TaskNotFoundError,
} from "./errors.js";
import { isValidTaskId } from "./id.js";
import { getTask } from "./queries.js";

export interface AddTaskOptions {
  localId: string;
  workstream: string;
  title: string;
  /** 1..100; enforced by schema CHECK. */
  impact: number;
  /** > 0; enforced by schema CHECK. */
  effortDays: number;
  /**
   * Tasks that block this one. Edges inserted as `blocker -> newTask`.
   * Each blocker must already exist AND share this task's workstream
   * (cross-workstream edges are forbidden); cycle check guards each
   * edge. The CLI surfaces this as `--blocked-by`; the SDK key matches.
   */
  blockedBy?: string[];
}

/**
 * Atomically create a task and (optionally) its incoming blocked-by
 * edges.
 *
 * The task insert + every edge insert + cycle check happen inside one
 * SQLite transaction. If any blocker is missing or any edge would
 * create a cycle, the entire add rolls back.
 *
 * Cycle check for `addTask` is structurally trivial (a fresh task has
 * no outgoing edges, so `to -> ... -> from` is impossible). It's still
 * called here so the same primitive is exercised by tests.
 */
export function addTask(db: Db, opts: AddTaskOptions) {
  if (!isValidTaskId(opts.localId)) {
    throw new TaskIdInvalidError(opts.localId);
  }

  return db.transaction(() => {
    // Auto-create the workstream row so tasks.workstream_id FK is
    // satisfied (preserves spawn-without-init ergonomics).
    ensureWorkstream(db, opts.workstream);
    const wsId = resolveWorkstreamId(db, opts.workstream);

    // Per-workstream uniqueness: a duplicate local_id within the same
    // workstream throws TaskExistsError. Different workstreams may
    // legitimately share local_ids in v5.
    const existing = db
      .prepare("SELECT id FROM tasks WHERE workstream_id = ? AND local_id = ?")
      .get(wsId, opts.localId) as { id: number } | undefined;
    if (existing) {
      throw new TaskExistsError(opts.localId);
    }

    const now = new Date().toISOString();
    const insertResult = db
      .prepare(
        `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days, created_at, updated_at)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      )
      .run(wsId, opts.localId, opts.title, opts.impact, opts.effortDays, now, now);
    const newTaskId = Number(insertResult.lastInsertRowid);

    if (opts.blockedBy && opts.blockedBy.length > 0) {
      // Prefer the same-workstream blocker first (v5 per-workstream
      // local_id), then fall back to a global lookup so a cross-ws
      // blocker still surfaces CrossWorkstreamEdgeError (not
      // TaskNotFoundError). Without the same-ws preference, two
      // blockers of the same local_id (one in this ws, one elsewhere)
      // could silently bind to the wrong row
      // (bug_v5_name_clash_silent_misroute).
      const blockerLookupSameWs = db.prepare(
        `SELECT t.id AS id, ws.name AS workstream FROM tasks t
           JOIN workstreams ws ON ws.id = t.workstream_id
          WHERE t.local_id = ? AND t.workstream_id = ?`,
      );
      const blockerLookupAnyWs = db.prepare(
        `SELECT t.id AS id, ws.name AS workstream FROM tasks t
           JOIN workstreams ws ON ws.id = t.workstream_id
          WHERE t.local_id = ? LIMIT 1`,
      );
      const insertEdge = db.prepare(
        "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
      );
      for (const blocker of opts.blockedBy) {
        const row = (blockerLookupSameWs.get(blocker, wsId) ?? blockerLookupAnyWs.get(blocker)) as
          | { id: number; workstream: string }
          | undefined;
        if (!row) {
          throw new TaskNotFoundError(blocker);
        }
        if (row.workstream !== opts.workstream) {
          throw new CrossWorkstreamEdgeError(
            blocker,
            row.workstream,
            opts.localId,
            opts.workstream,
          );
        }
        if (wouldCreateCycle(db, row.id, newTaskId)) {
          throw new CycleError(blocker, opts.localId);
        }
        insertEdge.run(row.id, newTaskId, now);
      }
    }

    const row = getTask(db, opts.localId, opts.workstream);
    if (!row) throw new Error(`addTask: row missing after insert: ${opts.localId}`);
    const blockedBy =
      opts.blockedBy && opts.blockedBy.length > 0 ? `, blocked-by=${opts.blockedBy.join(",")}` : "";
    emitEvent(
      db,
      opts.workstream,
      `task add ${opts.localId} (impact=${opts.impact}, effort=${opts.effortDays}${blockedBy})`,
    );
    return row;
  })();
}

export interface AddNoteOptions {
  /** Free-form author label. Convention: agent name, "user", or "orchestrator". */
  author?: string;
  /** Workstream context (operator-facing name). v5: tasks.local_id is
   *  per-workstream unique, so this is required to disambiguate. */
  workstream: string;
}

export function addNote(db: Db, taskLocalId: string, content: string, opts: AddNoteOptions) {
  const task = getTask(db, taskLocalId, opts.workstream);
  if (!task) {
    throw new TaskNotFoundError(taskLocalId);
  }
  const taskId = taskIdFor(db, task.name, task.workstreamName);
  if (taskId === null) throw new TaskNotFoundError(taskLocalId);
  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const r = db
      .prepare("INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, opts.author ?? null, content, now);
    // Bump the parent task so `mu task list --sort recency` surfaces
    // freshly-noted tasks (task_updatedat_not_bumped_by_reparent).
    touchTask(db, taskId, now);
    return r;
  })();
  const noteId = Number(result.lastInsertRowid);
  emitEvent(
    db,
    task.workstreamName,
    `task note ${taskLocalId} (note #${noteId} by ${opts.author ?? "orchestrator"})`,
    opts.author ?? "system",
  );
  return {
    author: opts.author ?? null,
    content,
    createdAt: now,
  };
}

export interface DeleteTaskResult {
  /** True iff the row existed and was deleted. False on a dry-run
   *  (preview) AND on the idempotent missing-row case. */
  deleted: boolean;
  /** Number of `task_edges` rows cascaded out (informational). On a
   *  dry-run, this is the would-be count. */
  deletedEdges: number;
  /** Number of `task_notes` rows cascaded out (informational). On a
   *  dry-run, this is the would-be count. */
  deletedNotes: number;
  /** True iff this was a dry-run (`opts.dryRun: true`). On a
   *  dry-run `deleted` is false and the counts are the would-be
   *  counts; the DB is unchanged. Always false on a commit / on a
   *  missing-row idempotent no-op. */
  dryRun: boolean;
  /** True iff a matching task row was found at the time of the
   *  call. Discriminator for the CLI: a dry-run that found nothing
   *  (`present: false`) renders differently from a dry-run that
   *  found an existing task with zero edges and zero notes
   *  (`present: true, deletedEdges: 0, deletedNotes: 0`). */
  present: boolean;
}

export interface DeleteTaskOptions {
  /** When true, return the cascade preview (would-be edge / note
   *  counts) without mutating and without snapshotting. The CLI uses
   *  this to power the bare `mu task delete <id>` two-phase pattern
   *  (mirrors `mu workstream destroy` / `mu archive delete` /
   *  `mu snapshot prune`). Surfaced by feedback ws task
   *  fb_task_delete_no_yes (impact=30): a dogfood report typed
   *  `mu task delete X --yes` (mirroring workstream destroy) and got
   *  'unknown option --yes' — the verb took no confirmation flag at
   *  all. Two failed deletes left long-named tasks lingering. */
  dryRun?: boolean;
}

/**
 * Delete a task. FK CASCADE on `task_edges` (from + to) and
 * `task_notes` cleans the joined rows automatically. Idempotent on
 * a missing task (returns `deleted: false`).
 *
 * Pre-counts the cascade victims for reporting because SQLite's
 * `changes()` only reports rows directly affected by the DELETE.
 *
 * With `opts.dryRun: true`, returns the would-be counts without
 * touching the DB and without taking a snapshot (no mutation = no
 * snapshot — same reasoning that gates the closeTask snap on the
 * idempotent no-op path). The CLI bare `mu task delete <id>` form
 * uses this; `--yes` calls through with `dryRun: false`.
 */
export function deleteTask(
  db: Db,
  localId: string,
  workstream: string,
  opts: DeleteTaskOptions = {},
): DeleteTaskResult {
  const dryRun = opts.dryRun === true;
  const before = getTask(db, localId, workstream);
  if (!before) {
    // Idempotent on a missing row regardless of dryRun.
    return { deleted: false, deletedEdges: 0, deletedNotes: 0, dryRun, present: false };
  }
  const taskId = taskIdFor(db, localId, before.workstreamName);
  if (taskId === null) {
    return { deleted: false, deletedEdges: 0, deletedNotes: 0, dryRun, present: false };
  }
  const edgesBefore = (
    db
      .prepare("SELECT COUNT(*) AS n FROM task_edges WHERE from_task_id = ? OR to_task_id = ?")
      .get(taskId, taskId) as { n: number }
  ).n;
  const notesBefore = (
    db.prepare("SELECT COUNT(*) AS n FROM task_notes WHERE task_id = ?").get(taskId) as {
      n: number;
    }
  ).n;
  if (dryRun) {
    return {
      deleted: false,
      deletedEdges: edgesBefore,
      deletedNotes: notesBefore,
      dryRun: true,
      present: true,
    };
  }
  // Pre-mutation snapshot. delete cascades into task_edges and
  // task_notes; no per-row history can reconstruct it. Taken AFTER
  // the dry-run early-return so a preview never touches snapshots.
  captureSnapshot(db, `task delete ${localId}`, before.workstreamName);
  const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
  const deleted = result.changes > 0;
  if (deleted) {
    emitEvent(
      db,
      before.workstreamName,
      `task delete ${localId} (cascade: ${edgesBefore} edges, ${notesBefore} notes)`,
    );
  }
  return {
    deleted,
    deletedEdges: edgesBefore,
    deletedNotes: notesBefore,
    dryRun: false,
    present: true,
  };
}

export interface UpdateTaskOptions {
  title?: string;
  /** 1..100; enforced by schema CHECK. */
  impact?: number;
  /** > 0; enforced by schema CHECK. */
  effortDays?: number;
}

export interface UpdateTaskResult {
  /** True iff at least one field actually changed. */
  updated: boolean;
  /** The fields whose values differ post-update (in `UpdateTaskOptions`'s
   *  camelCase shape). Empty when `updated: false`. */
  changedFields: string[];
}

/**
 * Update scalar fields on a task. Each option is independently optional;
 * passing none is a typed no-op (returns `updated: false, changedFields: []`).
 * Fields whose new value equals the current value are skipped (no row change).
 *
 * NOT for status (use `closeTask` / `openTask` / `setTaskStatus`), owner
 * (use `claimTask` / `releaseTask`), local_id (rename is deferred), or
 * workstream (cross-workstream moves are deferred).
 */
export interface UpdateTaskScopeOption {
  workstream: string;
}

export function updateTask(
  db: Db,
  localId: string,
  opts: UpdateTaskOptions,
  scope: UpdateTaskScopeOption,
): UpdateTaskResult {
  const before = getTask(db, localId, scope.workstream);
  if (!before) throw new TaskNotFoundError(localId);
  const taskId = taskIdFor(db, before.name, before.workstreamName);
  if (taskId === null) throw new TaskNotFoundError(localId);

  const setters: string[] = [];
  const params: unknown[] = [];
  const changedFields: string[] = [];

  if (opts.title !== undefined && opts.title !== before.title) {
    setters.push("title = ?");
    params.push(opts.title);
    changedFields.push("title");
  }
  if (opts.impact !== undefined && opts.impact !== before.impact) {
    setters.push("impact = ?");
    params.push(opts.impact);
    changedFields.push("impact");
  }
  if (opts.effortDays !== undefined && opts.effortDays !== before.effortDays) {
    setters.push("effort_days = ?");
    params.push(opts.effortDays);
    changedFields.push("effortDays");
  }

  if (setters.length === 0) {
    return { updated: false, changedFields: [] };
  }

  setters.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(taskId);

  db.prepare(`UPDATE tasks SET ${setters.join(", ")} WHERE id = ?`).run(...params);
  emitEvent(
    db,
    before.workstreamName,
    `task update ${localId} (changed: ${changedFields.join(", ")})`,
  );
  return { updated: true, changedFields };
}
