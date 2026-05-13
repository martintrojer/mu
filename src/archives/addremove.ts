// mu — add/remove workstream snapshots to/from archives.

import { type Db, resolveWorkstreamId } from "../db.js";
import { emitEvent } from "../logs.js";
import type { AddToArchiveResult, RemoveFromArchiveResult } from "./core.js";
import { resolveArchiveId } from "./core.js";

/**
 * Add every task in `workstream` to the archive identified by `label`.
 *
 * Idempotency invariant: re-running with the same (label, workstream)
 * pair is a no-op for tasks already present. The
 * (archive_id, source_workstream, original_local_id) UNIQUE on
 * archived_tasks is the lever; we INSERT OR IGNORE and skip notes /
 * events for the (archive, source_workstream) pair entirely when the
 * task copy added zero new rows.
 */
export function addToArchive(db: Db, label: string, workstream: string): AddToArchiveResult {
  const archiveId = resolveArchiveId(db, label);
  const wsId = resolveWorkstreamId(db, workstream);

  return db.transaction(() => {
    const now = new Date().toISOString();

    const sourceTasks = db
      .prepare(
        `SELECT t.id           AS source_task_id,
                t.local_id     AS original_local_id,
                t.title        AS title,
                t.status       AS status,
                t.impact       AS impact,
                t.effort_days  AS effort_days,
                ag.name        AS owner_name,
                t.created_at   AS original_created_at,
                t.updated_at   AS original_updated_at
           FROM tasks t
           LEFT JOIN agents ag ON ag.id = t.owner_id
          WHERE t.workstream_id = ?
          ORDER BY t.id`,
      )
      .all(wsId) as {
      source_task_id: number;
      original_local_id: string;
      title: string;
      status: string;
      impact: number;
      effort_days: number;
      owner_name: string | null;
      original_created_at: string;
      original_updated_at: string;
    }[];

    const insertTask = db.prepare(
      `INSERT OR IGNORE INTO archived_tasks (
         archive_id, source_workstream, original_local_id, title, status,
         impact, effort_days, owner_name, archived_at_status, archived_at,
         original_created_at, original_updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const lookupArchivedId = db.prepare(
      `SELECT id FROM archived_tasks
        WHERE archive_id = ? AND source_workstream = ? AND original_local_id = ?`,
    );

    let addedTasks = 0;
    let skippedTasks = 0;
    const newArchivedIds: number[] = [];
    const archivedIdBySourceId = new Map<number, number>();

    for (const t of sourceTasks) {
      const r = insertTask.run(
        archiveId,
        workstream,
        t.original_local_id,
        t.title,
        t.status,
        t.impact,
        t.effort_days,
        t.owner_name,
        t.status,
        now,
        t.original_created_at,
        t.original_updated_at,
      );
      const isNew = r.changes > 0;
      const lookup = lookupArchivedId.get(archiveId, workstream, t.original_local_id) as
        | { id: number }
        | undefined;
      if (!lookup) {
        throw new Error(
          `addToArchive: archived_tasks lookup missed after upsert: ${workstream}/${t.original_local_id}`,
        );
      }
      archivedIdBySourceId.set(t.source_task_id, lookup.id);
      if (isNew) {
        addedTasks += 1;
        newArchivedIds.push(lookup.id);
      } else {
        skippedTasks += 1;
      }
    }

    const sourceEdges = db
      .prepare(
        `SELECT e.from_task_id AS from_id, e.to_task_id AS to_id
           FROM task_edges e
           JOIN tasks tf ON tf.id = e.from_task_id
           JOIN tasks tt ON tt.id = e.to_task_id
          WHERE tf.workstream_id = ? AND tt.workstream_id = ?`,
      )
      .all(wsId, wsId) as { from_id: number; to_id: number }[];
    const insertEdge = db.prepare(
      `INSERT OR IGNORE INTO archived_edges (archive_id, from_archived_id, to_archived_id)
       VALUES (?, ?, ?)`,
    );
    let addedEdges = 0;
    for (const e of sourceEdges) {
      const fromArchivedId = archivedIdBySourceId.get(e.from_id);
      const toArchivedId = archivedIdBySourceId.get(e.to_id);
      if (fromArchivedId === undefined || toArchivedId === undefined) continue;
      const r = insertEdge.run(archiveId, fromArchivedId, toArchivedId);
      if (r.changes > 0) addedEdges += 1;
    }

    let addedNotes = 0;
    let addedEvents = 0;
    if (newArchivedIds.length > 0) {
      const insertNote = db.prepare(
        `INSERT INTO archived_notes (archive_id, archived_task_id, author, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const noteCopySql = db.prepare(
        `SELECT n.author AS author, n.content AS content, n.created_at AS created_at
           FROM task_notes n
          WHERE n.task_id = ?
          ORDER BY n.id`,
      );
      const sourceIdByArchivedId = new Map<number, number>();
      for (const [sId, aId] of archivedIdBySourceId) sourceIdByArchivedId.set(aId, sId);
      for (const archivedId of newArchivedIds) {
        const sourceId = sourceIdByArchivedId.get(archivedId);
        if (sourceId === undefined) continue;
        const notes = noteCopySql.all(sourceId) as {
          author: string | null;
          content: string;
          created_at: string;
        }[];
        for (const note of notes) {
          insertNote.run(archiveId, archivedId, note.author, note.content, note.created_at);
          addedNotes += 1;
        }
      }

      const events = db
        .prepare(
          `SELECT seq, source, payload, created_at
             FROM agent_logs
            WHERE workstream_id = ? AND kind = 'event'
            ORDER BY seq`,
        )
        .all(wsId) as {
        seq: number;
        source: string;
        payload: string;
        created_at: string;
      }[];
      const insertEvent = db.prepare(
        `INSERT INTO archived_events (
           archive_id, source_workstream, seq, source, payload, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const ev of events) {
        insertEvent.run(archiveId, workstream, ev.seq, ev.source, ev.payload, ev.created_at);
        addedEvents += 1;
      }
    }

    db.prepare("UPDATE archives SET last_added_at = ? WHERE id = ?").run(now, archiveId);
    const eventSummary =
      newArchivedIds.length === 0
        ? `tasks=${addedTasks}, edges=${addedEdges}, notes=${addedNotes}, events=0 (snapshot-only; re-add is task-incremental, not event-incremental), skipped_existing=${skippedTasks}`
        : `tasks=${addedTasks}, edges=${addedEdges}, notes=${addedNotes}, events=${addedEvents}, skipped_existing=${skippedTasks}`;
    emitEvent(db, null, `archive add ${label} -w ${workstream} (${eventSummary})`);

    return { addedTasks, skippedTasks, addedEdges, addedNotes, addedEvents };
  })();
}

/**
 * Remove every row contributed by `sourceWorkstream` from the named
 * archive. Other source workstreams' contributions are untouched
 * (additive accumulation invariant).
 */
export function removeFromArchive(
  db: Db,
  label: string,
  sourceWorkstream: string,
): RemoveFromArchiveResult {
  const archiveId = resolveArchiveId(db, label);
  return db.transaction(() => {
    const countBefore = (sql: string, params: unknown[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n;
    const removedTasks = countBefore(
      "SELECT COUNT(*) AS n FROM archived_tasks WHERE archive_id = ? AND source_workstream = ?",
      [archiveId, sourceWorkstream],
    );
    const removedNotes = countBefore(
      `SELECT COUNT(*) AS n
         FROM archived_notes an
         JOIN archived_tasks t ON t.id = an.archived_task_id
        WHERE t.archive_id = ? AND t.source_workstream = ?`,
      [archiveId, sourceWorkstream],
    );
    const removedEdges = countBefore(
      `SELECT COUNT(*) AS n
         FROM archived_edges e
         JOIN archived_tasks t ON t.id = e.from_archived_id
        WHERE e.archive_id = ? AND t.source_workstream = ?`,
      [archiveId, sourceWorkstream],
    );
    const removedEvents = countBefore(
      "SELECT COUNT(*) AS n FROM archived_events WHERE archive_id = ? AND source_workstream = ?",
      [archiveId, sourceWorkstream],
    );

    db.prepare("DELETE FROM archived_tasks WHERE archive_id = ? AND source_workstream = ?").run(
      archiveId,
      sourceWorkstream,
    );
    db.prepare("DELETE FROM archived_events WHERE archive_id = ? AND source_workstream = ?").run(
      archiveId,
      sourceWorkstream,
    );

    if (removedTasks > 0 || removedEvents > 0) {
      emitEvent(
        db,
        null,
        `archive remove ${label} -w ${sourceWorkstream} (tasks=${removedTasks}, edges=${removedEdges}, notes=${removedNotes}, events=${removedEvents})`,
      );
    }
    return { removedTasks, removedEdges, removedNotes, removedEvents };
  })();
}
