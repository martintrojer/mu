// mu — archives: cross-workstream preservation of task graphs.
//
// An archive is an operator-named bucket that snapshots a workstream's
// task graph (tasks + edges + notes + kind='event' agent_logs rows)
// before `mu workstream destroy` blows it away. Unlike snapshots
// (whole-DB binary backups for one-shot recovery via `mu undo`), an
// archive is queryable structured state that survives indefinitely
// and can accumulate snapshots from MULTIPLE workstreams under the
// same label.
//
// Design pillars (see docs/VOCABULARY.md § archive):
//   - archives outlive workstreams: archives.label is GLOBALLY unique
//     (not per-workstream), and archived_tasks columns referencing
//     the source workstream are TEXT (not FKs).
//   - additive accumulation: addToArchive(label, ws) is idempotent
//     at (archive, source_workstream) granularity. Re-running on the
//     same workstream is a no-op; a new task added to the workstream
//     post-archive shows up on the next add. Two different workstreams
//     under the same label both contribute their snapshots without
//     overwriting each other.
//   - Phase 1 (this file): SDK + schema only. The CLI (`mu archive
//     add/list/show/free/free-all`) lands in Phase 2; the destroy
//     auto-archive hook lands in Phase 3; the export renderer lands
//     in Phase 4.

import { type Db, resolveWorkstreamId } from "./db.js";
import { emitEvent } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";

// ─── Label validation ────────────────────────────────────────────────

/**
 * Allowed archive-label shape: lowercase alpha first, then alnum,
 * underscore, or hyphen, up to 64 chars total. Wider than the
 * workstream-name window (32 chars) because archive labels often
 * encode the workstream name PLUS a date / purpose ("auth-2026-q1",
 * "rewrite-postmortem").
 */
const ARCHIVE_LABEL_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** True iff `label` matches the archive-label rule. Pure predicate. */
export function isValidArchiveLabel(label: string): boolean {
  return ARCHIVE_LABEL_RE.test(label);
}

function assertValidArchiveLabel(label: string): void {
  if (!isValidArchiveLabel(label)) throw new ArchiveLabelInvalidError(label);
}

// ─── Typed errors ────────────────────────────────────────────────────

export class ArchiveNotFoundError extends Error implements HasNextSteps {
  override readonly name = "ArchiveNotFoundError";
  constructor(public readonly label: string) {
    super(`no such archive: ${label}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List existing archives", command: "mu archive list" },
      {
        intent: "Create this archive",
        command: `mu archive add ${this.label} -w <workstream>`,
      },
    ];
  }
}

export class ArchiveAlreadyExistsError extends Error implements HasNextSteps {
  override readonly name = "ArchiveAlreadyExistsError";
  constructor(public readonly label: string) {
    super(`archive already exists: ${label}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Add a workstream to the existing archive (additive)",
        command: `mu archive add ${this.label} -w <workstream>`,
      },
      {
        intent: "Inspect the existing archive",
        command: `mu archive show ${this.label}`,
      },
    ];
  }
}

export class ArchiveLabelInvalidError extends Error implements HasNextSteps {
  override readonly name = "ArchiveLabelInvalidError";
  constructor(public readonly attempted: string) {
    super(
      `invalid archive label ${JSON.stringify(attempted)}: must match /^[a-z][a-z0-9_-]{0,63}$/. Use letters, digits, '_', and '-' only; start with a letter; up to 64 chars.`,
    );
  }
  errorNextSteps(): NextStep[] {
    const sanitized =
      this.attempted
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_")
        .replace(/^[^a-z]+/, "")
        .slice(0, 64) || "archive";
    return [
      {
        intent: "Try a sanitized label (best guess)",
        command: `mu archive add ${sanitized} -w <workstream>`,
      },
      { intent: "List existing archives", command: "mu archive list" },
    ];
  }
}

// ─── Domain types ─────────────────────────────────────────────────────

export interface Archive {
  /** Surrogate INTEGER id. Internal — operators identify by label. */
  id: number;
  /** Globally-unique operator-facing TEXT label. */
  label: string;
  /** Optional one-liner description set at create time. */
  description: string | null;
  /** ISO 8601, set when the archive was first created. */
  createdAt: string;
  /** ISO 8601, bumped on every successful add. */
  lastAddedAt: string;
}

export interface ArchiveSourceSummary {
  /** TEXT name of the source workstream this snapshot came from. */
  name: string;
  /** Number of archived_tasks rows from this workstream in this archive. */
  taskCount: number;
  /** Earliest archived_at among this workstream's rows in this archive. */
  addedAt: string;
}

export interface ArchiveSummary extends Archive {
  /** One row per source workstream that contributed to this archive,
   *  sorted by source workstream name. */
  sourceWorkstreams: ArchiveSourceSummary[];
  /** Total archived_tasks rows across every source workstream. */
  totalTasks: number;
}

export interface ArchivedTaskRow {
  /** Surrogate id of the archived_tasks row. */
  id: number;
  /** Operator-facing label of the parent archive. */
  archiveLabel: string;
  /** TEXT name of the source workstream (intentionally not an FK). */
  sourceWorkstream: string;
  /** The local_id the task had in its source workstream. */
  originalLocalId: string;
  title: string;
  /** Status as stored at archive time. */
  status: string;
  impact: number;
  effortDays: number;
  /** Owner agent name as snapshotted at archive time. */
  ownerName: string | null;
  /** Status at the moment of archive (pinned for re-add semantics). */
  archivedAtStatus: string;
  /** ISO 8601, when this row was added to the archive. */
  archivedAt: string;
  /** Original tasks.created_at preserved for retrospect ordering. */
  originalCreatedAt: string;
  /** Original tasks.updated_at preserved for retrospect ordering. */
  originalUpdatedAt: string;
}

export interface AddToArchiveResult {
  /** Number of new archived_tasks rows actually inserted. Zero on a
   *  re-run against the same workstream (idempotency). */
  addedTasks: number;
  /** Tasks present in the source workstream that were already in the
   *  archive (skipped by the OR IGNORE). */
  skippedTasks: number;
  /** Number of new archived_edges rows actually inserted. */
  addedEdges: number;
  /** Number of new archived_notes rows inserted. (Notes have no
   *  natural unique key, so this matches the count of notes attached
   *  to NEW archived_tasks rows; existing rows' notes are not
   *  duplicated because note copy is gated on at-least-one new task
   *  for the (archive, source_workstream) pair.) */
  addedNotes: number;
  /** Number of new archived_events rows inserted (one per kind='event'
   *  agent_logs row in the source workstream). */
  addedEvents: number;
}

export interface RemoveFromArchiveResult {
  /** Number of archived_tasks rows deleted (cascade cleans the rest). */
  removedTasks: number;
  /** Number of archived_edges rows removed by the cascade. */
  removedEdges: number;
  /** Number of archived_notes rows removed by the cascade. */
  removedNotes: number;
  /** Number of archived_events rows directly deleted. */
  removedEvents: number;
}

// ─── Internal row shapes ──────────────────────────────────────────────

interface RawArchiveRow {
  id: number;
  label: string;
  description: string | null;
  created_at: string;
  last_added_at: string;
}

function rowFromArchive(r: RawArchiveRow): Archive {
  return {
    id: r.id,
    label: r.label,
    description: r.description,
    createdAt: r.created_at,
    lastAddedAt: r.last_added_at,
  };
}

interface RawArchivedTaskRow {
  id: number;
  archive_label: string;
  source_workstream: string;
  original_local_id: string;
  title: string;
  status: string;
  impact: number;
  effort_days: number;
  owner_name: string | null;
  archived_at_status: string;
  archived_at: string;
  original_created_at: string;
  original_updated_at: string;
}

function rowFromArchivedTask(r: RawArchivedTaskRow): ArchivedTaskRow {
  return {
    id: r.id,
    archiveLabel: r.archive_label,
    sourceWorkstream: r.source_workstream,
    originalLocalId: r.original_local_id,
    title: r.title,
    status: r.status,
    impact: r.impact,
    effortDays: r.effort_days,
    ownerName: r.owner_name,
    archivedAtStatus: r.archived_at_status,
    archivedAt: r.archived_at,
    originalCreatedAt: r.original_created_at,
    originalUpdatedAt: r.original_updated_at,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Resolve an archive label to its surrogate id. Returns null on miss
 *  so callers can pick between throwing (createArchive) and returning
 *  empty (listArchivedTasks). archives.label is globally unique
 *  (NOT per-workstream) by design — see schema doc in src/db.ts. */
function tryResolveArchiveId(db: Db, label: string): number | null {
  // archives is the one entity table whose TEXT name is intentionally
  // global (archives outlive workstreams) — no per-workstream scope.
  const row = db.prepare("SELECT id FROM archives WHERE label = ?").get(label) as
    | { id: number }
    | undefined;
  return row ? row.id : null;
}

/** Resolve an archive label to its surrogate id, throwing
 *  ArchiveNotFoundError on miss. */
function resolveArchiveId(db: Db, label: string): number {
  const id = tryResolveArchiveId(db, label);
  if (id === null) throw new ArchiveNotFoundError(label);
  return id;
}

function archiveByLabel(db: Db, label: string): Archive | null {
  // archive labels are globally unique (no workstream scope).
  const row = db
    .prepare(
      "SELECT id, label, description, created_at, last_added_at FROM archives WHERE label = ?",
    )
    .get(label) as RawArchiveRow | undefined;
  return row ? rowFromArchive(row) : null;
}

function summarizeArchive(db: Db, archive: Archive): ArchiveSummary {
  const sources = db
    .prepare(
      `SELECT source_workstream AS name,
              COUNT(*)         AS task_count,
              MIN(archived_at) AS added_at
         FROM archived_tasks
        WHERE archive_id = ?
        GROUP BY source_workstream
        ORDER BY source_workstream`,
    )
    .all(archive.id) as { name: string; task_count: number; added_at: string }[];
  const sourceWorkstreams: ArchiveSourceSummary[] = sources.map((s) => ({
    name: s.name,
    taskCount: s.task_count,
    addedAt: s.added_at,
  }));
  const totalTasks = sourceWorkstreams.reduce((acc, s) => acc + s.taskCount, 0);
  return { ...archive, sourceWorkstreams, totalTasks };
}

// ─── Public SDK ───────────────────────────────────────────────────────

/**
 * Create a new archive bucket. Throws `ArchiveAlreadyExistsError` if
 * the label is already in use; throws `ArchiveLabelInvalidError` for
 * malformed labels.
 *
 * The archive starts EMPTY: created_at and last_added_at both equal
 * now(). Use `addToArchive(label, workstream)` to populate it.
 */
export function createArchive(db: Db, label: string, description?: string): Archive {
  assertValidArchiveLabel(label);
  if (tryResolveArchiveId(db, label) !== null) {
    throw new ArchiveAlreadyExistsError(label);
  }
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO archives (label, description, created_at, last_added_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(label, description ?? null, now, now);
  const id = Number(result.lastInsertRowid);
  emitEvent(db, null, `archive create ${label}`);
  return {
    id,
    label,
    description: description ?? null,
    createdAt: now,
    lastAddedAt: now,
  };
}

/**
 * List every archive on this machine, summarised with per-source-
 * workstream counts. Sorted by label ascending. Pure read; safe to
 * call against an empty DB (returns []).
 */
export function listArchives(db: Db): ArchiveSummary[] {
  const rows = db
    .prepare(
      "SELECT id, label, description, created_at, last_added_at FROM archives ORDER BY label",
    )
    .all() as RawArchiveRow[];
  return rows.map((r) => summarizeArchive(db, rowFromArchive(r)));
}

/**
 * Look up a single archive by label. Throws `ArchiveNotFoundError`
 * on miss.
 */
export function getArchive(db: Db, label: string): ArchiveSummary {
  const archive = archiveByLabel(db, label);
  if (archive === null) throw new ArchiveNotFoundError(label);
  return summarizeArchive(db, archive);
}

/**
 * Delete an archive and every row that references it. The FK
 * CASCADE chain (archives → archived_tasks → archived_edges /
 * archived_notes; archives → archived_events) cleans every row in
 * one statement.
 *
 * Idempotent: throws `ArchiveNotFoundError` rather than silently
 * succeeding on a missing label (operator confusion safeguard).
 *
 * Mirror of `destroyWorkstream`'s safety story but cheaper: archives
 * have no on-disk artifacts (no tmux session, no workspaces). The
 * pre-delete snapshot is the operator's recovery path if they run
 * this verb by mistake (handled in the CLI wrapper, Phase 2).
 */
export function deleteArchive(db: Db, label: string): void {
  const id = resolveArchiveId(db, label);
  db.prepare("DELETE FROM archives WHERE id = ?").run(id);
  emitEvent(db, null, `archive delete ${label}`);
}

/**
 * Add every task in `workstream` to the archive identified by `label`.
 *
 * Idempotency invariant: re-running with the same (label, workstream)
 * pair is a no-op for tasks already present. The
 * (archive_id, source_workstream, original_local_id) UNIQUE on
 * archived_tasks is the lever; we INSERT OR IGNORE and skip notes /
 * events for the (archive, source_workstream) pair entirely when the
 * task copy added zero new rows. This makes addToArchive
 * coarse-grained idempotent for end-of-milestone snapshots: re-adds
 * are task-incremental only. Notes and events for already-archived
 * tasks are not refreshed on re-add.
 *
 * Throws:
 *   - `ArchiveNotFoundError` if the label doesn't exist (call
 *     `createArchive` first).
 *   - `WorkstreamNotFoundError` if the source workstream is gone
 *     (you must archive BEFORE destroy).
 *
 * The whole operation runs in a transaction so a partial failure
 * leaves the archive untouched.
 */
export function addToArchive(db: Db, label: string, workstream: string): AddToArchiveResult {
  const archiveId = resolveArchiveId(db, label);
  // Throws WorkstreamNotFoundError if the source is already gone.
  const wsId = resolveWorkstreamId(db, workstream);

  return db.transaction(() => {
    const now = new Date().toISOString();

    // Pull every task in the source workstream. We snapshot owner_name
    // by joining agents (operator-facing string), not the surrogate
    // owner_id (which means nothing post-destroy).
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

    // archived_id lookup keyed on (archive_id, source_workstream,
    // original_local_id) — the natural composite key for any prior or
    // new row.
    const lookupArchivedId = db.prepare(
      `SELECT id FROM archived_tasks
        WHERE archive_id = ? AND source_workstream = ? AND original_local_id = ?`,
    );

    let addedTasks = 0;
    let skippedTasks = 0;
    // Surrogate ids of the archived_tasks rows we just inserted (NEW
    // rows only — the gate for note/event copy below).
    const newArchivedIds: number[] = [];
    // Map source-side tasks.id -> archived_tasks.id for every source
    // task (NEW or already-present). Edge insertion needs both
    // endpoints regardless of newness.
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
        // Unreachable in practice: we either just inserted or the row
        // pre-existed. Defend the type narrowing.
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

    // Edges: copy every task_edge whose endpoints are both in the
    // source workstream's task set. INSERT OR IGNORE so a re-run
    // is a no-op. Cross-workstream edges don't exist by design (the
    // addTask path rejects them via CrossWorkstreamEdgeError), but
    // the WHERE-clause filter keeps the implementation honest.
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
      // Both endpoints are guaranteed in the map: tf and tt are both
      // in workstream_id = wsId, so they were enumerated above.
      if (fromArchivedId === undefined || toArchivedId === undefined) continue;
      const r = insertEdge.run(archiveId, fromArchivedId, toArchivedId);
      if (r.changes > 0) addedEdges += 1;
    }

    // Notes + events: gated on at-least-one new task for the
    // (archive, source_workstream) pair. Without the gate, re-running
    // addToArchive on the same workstream would duplicate every note
    // and event (notes have no natural unique key; events keyed on
    // (seq, archive) are also a duplicate of the same source row).
    // Archives are end-of-milestone snapshots, not incremental event
    // mirrors: re-adds refresh the task set only, while notes/events
    // for already-archived tasks stay pinned to the original snapshot.
    let addedNotes = 0;
    let addedEvents = 0;
    if (newArchivedIds.length > 0) {
      // Notes: copy every task_notes row whose task is in the NEW
      // archived_tasks set. An already-archived task's notes are
      // untouched (the operator can't selectively re-snapshot a
      // single task; they re-archive the whole workstream).
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
      // Build reverse map archived_id -> source_id for the new set
      // so we can iterate source ids (the JOIN side that has notes).
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

      // Events: snapshot every kind='event' agent_logs row for the
      // source workstream. Only events (not the full message log;
      // recoverable via snapshot+undo). Same idempotency gate as
      // notes: only fires when at least one new task was added.
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
 * (additive accumulation invariant). Throws `ArchiveNotFoundError`
 * if the label doesn't exist; returns all-zero counts (no error)
 * when the source workstream never contributed to this archive.
 */
export function removeFromArchive(
  db: Db,
  label: string,
  sourceWorkstream: string,
): RemoveFromArchiveResult {
  const archiveId = resolveArchiveId(db, label);
  return db.transaction(() => {
    // Pre-count cascade victims (changes() only reports rows directly
    // affected by the last statement, not cascade victims).
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

    // archived_tasks DELETE cascades to edges + notes via the FK
    // chain; archived_events is a sibling of archived_tasks (the
    // cascade is from archives, not from tasks) so we delete it
    // explicitly here.
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

export interface ListArchivedTasksOptions {
  /** Filter by source workstream. Omit to return every source's
   *  contribution, sorted by (source_workstream, original_local_id). */
  sourceWorkstream?: string;
}

/**
 * List archived task rows in a single archive. Throws
 * `ArchiveNotFoundError` on missing label.
 *
 * Default order: source_workstream ASC, then original_local_id ASC,
 * so the output is deterministic and groups each workstream's
 * contribution together.
 */
// ─── searchArchives ──────────────────────────────────────────────────

export interface ArchiveSearchHit {
  /** Operator-facing label of the parent archive. */
  archiveLabel: string;
  /** TEXT name of the source workstream this row came from. */
  sourceWorkstream: string;
  /** local_id the task had in its source workstream. */
  originalLocalId: string;
  /** Snapshotted title (always present, even on a note match). */
  title: string;
  /** Where the match was found: the title column, or one of this
   *  task's archived_notes.content rows. Title matches win when
   *  both apply (the dedup pass below picks one row per task). */
  matchKind: "title" | "note";
  /** Up to ~120 chars of context centered on the FIRST occurrence
   *  of the pattern in the matching field. Case-insensitive index;
   *  the snippet itself preserves original casing. */
  matchSnippet: string;
}

export interface SearchArchivesOptions {
  /** LIKE-style needle. Wrapped in `%…%` automatically; `_` and `%`
   *  inside the pattern are still SQL LIKE wildcards (matches the
   *  `searchTasks` convention in src/tasks.ts). Empty / whitespace-
   *  only patterns throw — the CLI is the canonical caller and
   *  enforces it via UsageError before we get here, but the SDK
   *  guards it too so direct programmatic callers don't accidentally
   *  match every row. */
  pattern: string;
  /** Restrict to one archive label; undefined = search every
   *  archive. Throws ArchiveNotFoundError on miss. */
  label?: string;
  /** Cap on hits returned. Default 50; values below 1 fall back to
   *  the default. There is no `--all` escape hatch — for unbounded
   *  exports use `mu sql`. */
  limit?: number;
}

/** Default + cap for searchArchives. Mirrors the `--limit 50` shape
 *  used elsewhere; deliberately small so an interactive search
 *  doesn't dump thousands of rows by default. */
const SEARCH_DEFAULT_LIMIT = 50;
/** Width of the snippet window (chars before+after the match). 120 is
 *  the contract from the design note: enough context to disambiguate
 *  matches in a table without wrapping a typical 80-col terminal. */
const SNIPPET_WIDTH = 120;

/** Build a ~SNIPPET_WIDTH-char snippet centered on the first
 *  case-insensitive occurrence of `needle` in `haystack`. Adds an
 *  ellipsis prefix/suffix when we trimmed; preserves original casing
 *  in the returned slice. SQL LIKE wildcards (`%`, `_`) in `needle`
 *  are stripped before the match-locating step (we don't try to
 *  reproduce LIKE-pattern semantics here — a glob like `foo%bar`
 *  centers on "foo"). Pure helper; no DB access. */
function snippetAround(haystack: string, needle: string): string {
  const literal = needle.replace(/[%_]/g, "");
  if (literal.length === 0) {
    // Pattern is just wildcards — return a head slice so the row
    // isn't blank in the table.
    return haystack.length <= SNIPPET_WIDTH ? haystack : `${haystack.slice(0, SNIPPET_WIDTH - 1)}…`;
  }
  const idx = haystack.toLowerCase().indexOf(literal.toLowerCase());
  if (idx < 0) {
    // Match was via SQL LIKE (e.g. `_` wildcard) but the literal
    // isn't present. Fall back to a head slice rather than throw.
    return haystack.length <= SNIPPET_WIDTH ? haystack : `${haystack.slice(0, SNIPPET_WIDTH - 1)}…`;
  }
  const half = Math.floor((SNIPPET_WIDTH - literal.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(haystack.length, start + SNIPPET_WIDTH);
  const head = start > 0 ? "…" : "";
  const tail = end < haystack.length ? "…" : "";
  return `${head}${haystack.slice(start, end)}${tail}`;
}

/**
 * LIKE-search archived task titles AND archived note content. The
 * pattern is bound as a SQL parameter (never concatenated): an
 * archive label like `'); DROP TABLE archives; --` round-trips
 * through `?` without touching the DDL surface.
 *
 * Behaviour:
 *   - One row per (archive, source_workstream, original_local_id)
 *     pair. When a task matches via BOTH title and note, the title
 *     row wins (matchKind='title'); only note matches stand on
 *     their own as matchKind='note'.
 *   - With `opts.label`, restricts to that archive. Resolves the
 *     label up-front via the helper; throws ArchiveNotFoundError
 *     on miss.
 *   - Results sorted by (archive label, source workstream,
 *     original_local_id) — the same order `mu archive show` uses,
 *     so a search hit lines up with the show output.
 *   - `limit` defaults to 50 and caps the result set. There is no
 *     unbounded mode (use `mu sql` for raw extracts).
 */
export function searchArchives(db: Db, opts: SearchArchivesOptions): ArchiveSearchHit[] {
  const trimmed = opts.pattern.trim();
  if (trimmed.length === 0) {
    // Defensive guard for direct SDK callers; the CLI throws
    // UsageError("search pattern is required") before we get here.
    throw new Error("searchArchives: pattern must be non-empty");
  }
  const like = `%${trimmed}%`;
  const limit =
    opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : SEARCH_DEFAULT_LIMIT;

  // archiveId resolves up-front so a missing label fails loudly
  // before we run a (potentially expensive) full-table scan.
  let archiveFilterSql = "";
  const archiveFilterParams: unknown[] = [];
  if (opts.label !== undefined) {
    // getArchive throws ArchiveNotFoundError on miss — the contract.
    const archive = getArchive(db, opts.label);
    archiveFilterSql = " AND a.id = ?";
    archiveFilterParams.push(archive.id);
  }

  // Title hits: one row per archived_tasks row whose title matches.
  // The pattern is a parameter, never a string concat.
  const titleRows = db
    .prepare(
      `SELECT a.label             AS archive_label,
              t.source_workstream AS source_workstream,
              t.original_local_id AS original_local_id,
              t.title             AS title
         FROM archived_tasks t
         JOIN archives a ON a.id = t.archive_id
        WHERE LOWER(t.title) LIKE LOWER(?)${archiveFilterSql}`,
    )
    .all(like, ...archiveFilterParams) as {
    archive_label: string;
    source_workstream: string;
    original_local_id: string;
    title: string;
  }[];

  // Note hits: one row per archived_notes row that matches. We need
  // both the note content (for the snippet) AND the parent task's
  // title (for the table). DISTINCT-on-task is enforced in the JS
  // dedup step below — SQL DISTINCT here would only help if we
  // collapsed before reading n.content, losing the snippet source.
  const noteRows = db
    .prepare(
      `SELECT a.label             AS archive_label,
              t.source_workstream AS source_workstream,
              t.original_local_id AS original_local_id,
              t.title             AS title,
              n.content           AS content
         FROM archived_notes n
         JOIN archived_tasks t ON t.id = n.archived_task_id
         JOIN archives a ON a.id = t.archive_id
        WHERE LOWER(n.content) LIKE LOWER(?)${archiveFilterSql}
        ORDER BY n.id`,
    )
    .all(like, ...archiveFilterParams) as {
    archive_label: string;
    source_workstream: string;
    original_local_id: string;
    title: string;
    content: string;
  }[];

  // Merge: title matches win over note matches for the same task.
  // Key on (archive label, source ws, original_local_id) — the
  // archive-side composite identity.
  const seen = new Set<string>();
  const hits: ArchiveSearchHit[] = [];
  for (const r of titleRows) {
    const key = `${r.archive_label}\u0000${r.source_workstream}\u0000${r.original_local_id}`;
    seen.add(key);
    hits.push({
      archiveLabel: r.archive_label,
      sourceWorkstream: r.source_workstream,
      originalLocalId: r.original_local_id,
      title: r.title,
      matchKind: "title",
      matchSnippet: snippetAround(r.title, trimmed),
    });
  }
  for (const r of noteRows) {
    const key = `${r.archive_label}\u0000${r.source_workstream}\u0000${r.original_local_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      archiveLabel: r.archive_label,
      sourceWorkstream: r.source_workstream,
      originalLocalId: r.original_local_id,
      title: r.title,
      matchKind: "note",
      matchSnippet: snippetAround(r.content, trimmed),
    });
  }

  hits.sort((a, b) => {
    if (a.archiveLabel !== b.archiveLabel) return a.archiveLabel < b.archiveLabel ? -1 : 1;
    if (a.sourceWorkstream !== b.sourceWorkstream)
      return a.sourceWorkstream < b.sourceWorkstream ? -1 : 1;
    if (a.originalLocalId !== b.originalLocalId)
      return a.originalLocalId < b.originalLocalId ? -1 : 1;
    return 0;
  });
  return hits.slice(0, limit);
}

export function listArchivedTasks(
  db: Db,
  label: string,
  opts: ListArchivedTasksOptions = {},
): ArchivedTaskRow[] {
  const archiveId = resolveArchiveId(db, label);
  const conditions: string[] = ["t.archive_id = ?"];
  const params: unknown[] = [archiveId];
  if (opts.sourceWorkstream !== undefined) {
    conditions.push("t.source_workstream = ?");
    params.push(opts.sourceWorkstream);
  }
  const where = conditions.join(" AND ");
  const rows = db
    .prepare(
      `SELECT t.id                  AS id,
              a.label               AS archive_label,
              t.source_workstream   AS source_workstream,
              t.original_local_id   AS original_local_id,
              t.title               AS title,
              t.status              AS status,
              t.impact              AS impact,
              t.effort_days         AS effort_days,
              t.owner_name          AS owner_name,
              t.archived_at_status  AS archived_at_status,
              t.archived_at         AS archived_at,
              t.original_created_at AS original_created_at,
              t.original_updated_at AS original_updated_at
         FROM archived_tasks t
         JOIN archives a ON a.id = t.archive_id
        WHERE ${where}
        ORDER BY t.source_workstream ASC, t.original_local_id ASC`,
    )
    .all(...params) as RawArchivedTaskRow[];
  return rows.map(rowFromArchivedTask);
}
