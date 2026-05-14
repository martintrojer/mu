// mu — manual replay of divergence sidecars parked by `mu db import --force-source`.

import { createHash } from "node:crypto";
import { type Db, openDb } from "./db.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { captureSnapshot } from "./snapshots.js";

export class DbReplayWorkstreamMissingError extends Error implements HasNextSteps {
  override readonly name = "DbReplayWorkstreamMissingError";
  constructor(public readonly workstream: string) {
    super(
      `replay sidecar is for workstream "${workstream}", which does not exist locally; restore it first via mu db import or mu archive restore`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Restore this workstream from a DB export",
        command: "mu db import <file> --apply",
      },
      {
        intent: "Or restore it from an archive",
        command: `mu archive restore <label> --as ${this.workstream}`,
      },
    ];
  }
}

export interface DbReplayTaskConflict {
  localId: string;
  local: { title: string; status: string };
  sidecar: { title: string; status: string };
}

export class DbReplayLocalIdConflictError extends Error implements HasNextSteps {
  override readonly name = "DbReplayLocalIdConflictError";
  constructor(
    public readonly workstream: string,
    public readonly conflicts: readonly DbReplayTaskConflict[],
  ) {
    super(
      `sidecar task id collides with different local content in ${workstream}: ${conflicts
        .map(
          (c) =>
            `${c.localId} (local: ${c.local.status} ${JSON.stringify(c.local.title)}; sidecar: ${c.sidecar.status} ${JSON.stringify(c.sidecar.title)})`,
        )
        .join(", ")}`,
    );
  }
  errorNextSteps(): NextStep[] {
    const first = this.conflicts[0];
    return [
      {
        intent: "Create a renamed local task manually, then replay notes if desired",
        command: first
          ? `mu task add ${first.localId}-replay -w ${this.workstream} -t ${shellQuote(first.sidecar.title)} -i <impact> -e <effort>`
          : `mu task add <renamed-id> -w ${this.workstream} -t <title> -i <impact> -e <effort>`,
      },
      {
        intent: "Skip the colliding id and replay another task",
        command: "mu db replay <sidecar> --task <other-id> --apply",
      },
    ];
  }
}

export interface ReplayDbOptions {
  apply?: boolean;
  tasks?: readonly string[];
  notes?: readonly string[];
  all?: boolean;
}

export interface DbReplayTaskItem {
  localId: string;
  title: string;
  status: string;
  impact: number;
  effortDays: number;
  createdAt: string;
  updatedAt: string;
}

export interface DbReplayNoteItem {
  taskLocalId: string;
  author: string | null;
  content: string;
  createdAt: string;
  hash: string;
}

export interface DbReplayEdgeItem {
  fromLocalId: string;
  toLocalId: string;
  createdAt: string;
}

export interface DbReplayPlan {
  sourceFile: string;
  workstream: string;
  tasks: DbReplayTaskItem[];
  notes: DbReplayNoteItem[];
  edges: DbReplayEdgeItem[];
  conflicts: DbReplayTaskConflict[];
}

export interface DbReplayResult extends DbReplayPlan {
  dryRun: boolean;
  applied: boolean;
  snapshotId?: number;
  added: { tasks: number; notes: number; edges: number };
  warnings: string[];
}

interface WorkstreamIdRow {
  id: number;
  name: string;
}

interface ReplayTaskRow {
  local_id: string;
  title: string;
  status: string;
  impact: number;
  effort_days: number;
  created_at: string;
  updated_at: string;
}

export function replayDb(db: Db, file: string, opts: ReplayDbOptions = {}): DbReplayResult {
  const sidecarDb = openDb({ path: file, readonly: true });
  try {
    const plan = buildReplayPlan(db, sidecarDb, file);
    const taskFilter = new Set(opts.tasks ?? []);
    const noteFilter = new Set(opts.notes ?? []);
    const selectedTaskIds =
      opts.all === true ? new Set(plan.tasks.map((t) => t.localId)) : taskFilter;
    const selectedNoteIds =
      opts.all === true ? new Set(plan.notes.map((n) => n.taskLocalId)) : noteFilter;
    const hasSelectors = opts.all === true || selectedTaskIds.size > 0 || selectedNoteIds.size > 0;
    const noteTaskIds = new Set([...selectedNoteIds, ...selectedTaskIds]);
    const hasWrites =
      plan.tasks.some((t) => selectedTaskIds.has(t.localId)) ||
      plan.notes.some((n) => noteTaskIds.has(n.taskLocalId)) ||
      plan.edges.some(
        (e) =>
          opts.all === true ||
          selectedTaskIds.has(e.fromLocalId) ||
          selectedTaskIds.has(e.toLocalId),
      );
    const relevantConflicts =
      opts.all === true
        ? plan.conflicts
        : plan.conflicts.filter((c) => selectedTaskIds.has(c.localId));
    if (relevantConflicts.length > 0) {
      throw new DbReplayLocalIdConflictError(plan.workstream, relevantConflicts);
    }
    if (opts.apply !== true || !hasSelectors) return replayResult(plan, true, false);
    if (!hasWrites) return replayResult(plan, false, true);

    const snapshot = captureSnapshot(db, `db replay ${file}`, null);
    const applied = applyReplayPlan(db, plan, selectedTaskIds, selectedNoteIds, opts.all === true);
    return { ...replayResult(plan, false, true), snapshotId: snapshot.id, ...applied };
  } finally {
    sidecarDb.close();
  }
}

export function buildReplayPlan(localDb: Db, sidecarDb: Db, sourceFile: string): DbReplayPlan {
  const sidecarWorkstreams = listLocalWorkstreams(sidecarDb);
  const sidecarWs = sidecarWorkstreams[0];
  if (sidecarWorkstreams.length !== 1 || !sidecarWs) {
    throw new Error(
      `replay sidecar must contain exactly one workstream; found ${sidecarWorkstreams.length}`,
    );
  }
  const localWs = listLocalWorkstreams(localDb).find((w) => w.name === sidecarWs.name);
  if (!localWs) throw new DbReplayWorkstreamMissingError(sidecarWs.name);

  const localTasks = new Map(
    (
      localDb
        .prepare("SELECT local_id, title, status FROM tasks WHERE workstream_id = ?")
        .all(localWs.id) as {
        local_id: string;
        title: string;
        status: string;
      }[]
    ).map((t) => [t.local_id, t]),
  );
  const tasks: DbReplayTaskItem[] = [];
  const conflicts: DbReplayTaskConflict[] = [];
  for (const task of listReplayTasks(sidecarDb, sidecarWs.id)) {
    const local = localTasks.get(task.localId);
    if (!local) tasks.push(task);
    else if (local.title !== task.title || local.status !== task.status) {
      conflicts.push({
        localId: task.localId,
        local: { title: local.title, status: local.status },
        sidecar: { title: task.title, status: task.status },
      });
    }
  }

  const localNoteHashes = new Set(listReplayNotes(localDb, localWs.id).map((n) => n.hash));
  const localEdges = new Set(listReplayEdges(localDb, localWs.id).map(edgeKey));
  return {
    sourceFile,
    workstream: sidecarWs.name,
    tasks,
    notes: listReplayNotes(sidecarDb, sidecarWs.id).filter((n) => !localNoteHashes.has(n.hash)),
    edges: listReplayEdges(sidecarDb, sidecarWs.id).filter((e) => !localEdges.has(edgeKey(e))),
    conflicts,
  };
}

function applyReplayPlan(
  db: Db,
  plan: DbReplayPlan,
  selectedTaskIds: ReadonlySet<string>,
  selectedNoteIds: ReadonlySet<string>,
  replayAllEdges: boolean,
): { added: { tasks: number; notes: number; edges: number }; warnings: string[] } {
  const warnings: string[] = [];
  const added = db.transaction(() => {
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name = ?").get(plan.workstream) as
        | WorkstreamIdRow
        | undefined
    )?.id;
    if (wsId === undefined) throw new DbReplayWorkstreamMissingError(plan.workstream);
    const taskIds = new Set(selectedTaskIds);
    const noteTaskIds = new Set([...selectedNoteIds, ...taskIds]);
    let tasks = 0;
    let notes = 0;
    let edges = 0;

    const insertTask = db.prepare(
      `INSERT OR IGNORE INTO tasks (workstream_id, local_id, title, status, impact, effort_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const task of plan.tasks) {
      if (!taskIds.has(task.localId)) continue;
      const result = insertTask.run(
        wsId,
        task.localId,
        task.title,
        task.status,
        task.impact,
        task.effortDays,
        task.createdAt,
        task.updatedAt,
      );
      if (result.changes > 0) tasks += 1;
    }

    const existingNoteHashes = new Set(listReplayNotes(db, wsId).map((n) => n.hash));
    const insertNote = db.prepare(
      `INSERT INTO task_notes (task_id, author, content, created_at)
       SELECT id, ?, ?, ? FROM tasks WHERE workstream_id = ? AND local_id = ?`,
    );
    for (const note of plan.notes) {
      if (!noteTaskIds.has(note.taskLocalId) || existingNoteHashes.has(note.hash)) continue;
      const result = insertNote.run(
        note.author,
        note.content,
        note.createdAt,
        wsId,
        note.taskLocalId,
      );
      if (result.changes > 0) {
        notes += 1;
        existingNoteHashes.add(note.hash);
      }
    }

    const insertEdge = db.prepare(
      `INSERT OR IGNORE INTO task_edges (from_task_id, to_task_id, created_at)
       SELECT f.id, t.id, ?
         FROM tasks f, tasks t
        WHERE f.workstream_id = ? AND f.local_id = ?
          AND t.workstream_id = ? AND t.local_id = ?`,
    );
    for (const edge of plan.edges) {
      if (!replayAllEdges && !taskIds.has(edge.fromLocalId) && !taskIds.has(edge.toLocalId)) {
        continue;
      }
      if (!hasTask(db, wsId, edge.fromLocalId) || !hasTask(db, wsId, edge.toLocalId)) {
        warnings.push(
          `skipped edge ${edge.fromLocalId} -> ${edge.toLocalId}: one endpoint is missing locally`,
        );
        continue;
      }
      const result = insertEdge.run(edge.createdAt, wsId, edge.fromLocalId, wsId, edge.toLocalId);
      if (result.changes > 0) edges += 1;
    }
    return { tasks, notes, edges };
  })();
  return { added, warnings };
}

function replayResult(plan: DbReplayPlan, dryRun: boolean, applied: boolean): DbReplayResult {
  return { ...plan, dryRun, applied, added: { tasks: 0, notes: 0, edges: 0 }, warnings: [] };
}

function listLocalWorkstreams(db: Db): WorkstreamIdRow[] {
  return db.prepare("SELECT id, name FROM workstreams ORDER BY name").all() as WorkstreamIdRow[];
}

function listReplayTasks(db: Db, wsId: number): DbReplayTaskItem[] {
  return (
    db
      .prepare(
        `SELECT local_id, title, status, impact, effort_days, created_at, updated_at
           FROM tasks
          WHERE workstream_id = ?
          ORDER BY local_id`,
      )
      .all(wsId) as ReplayTaskRow[]
  ).map((row) => ({
    localId: row.local_id,
    title: row.title,
    status: row.status,
    impact: row.impact,
    effortDays: row.effort_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function listReplayNotes(db: Db, wsId: number): DbReplayNoteItem[] {
  const rows = db
    .prepare(
      `SELECT t.local_id AS taskLocalId, n.author, n.content, n.created_at AS createdAt
         FROM task_notes n
         JOIN tasks t ON t.id = n.task_id
        WHERE t.workstream_id = ?
        ORDER BY n.created_at, n.id`,
    )
    .all(wsId) as Omit<DbReplayNoteItem, "hash">[];
  return rows.map((row) => ({ ...row, hash: noteHash(row) }));
}

function listReplayEdges(db: Db, wsId: number): DbReplayEdgeItem[] {
  return db
    .prepare(
      `SELECT f.local_id AS fromLocalId, t.local_id AS toLocalId, e.created_at AS createdAt
         FROM task_edges e
         JOIN tasks f ON f.id = e.from_task_id
         JOIN tasks t ON t.id = e.to_task_id
        WHERE f.workstream_id = ? AND t.workstream_id = ?
        ORDER BY f.local_id, t.local_id`,
    )
    .all(wsId, wsId) as DbReplayEdgeItem[];
}

function noteHash(note: Omit<DbReplayNoteItem, "hash">): string {
  return createHash("sha256")
    .update(`${note.taskLocalId}\0${note.content}\0${note.createdAt}`)
    .digest("hex");
}

function edgeKey(edge: DbReplayEdgeItem): string {
  return `${edge.fromLocalId}\0${edge.toLocalId}`;
}

function hasTask(db: Db, wsId: number, localId: string): boolean {
  return (
    (db
      .prepare("SELECT 1 FROM tasks WHERE workstream_id = ? AND local_id = ?")
      .get(wsId, localId) as { "1": number } | undefined) !== undefined
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
