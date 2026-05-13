// mu — archive shared types, label validation, errors, and row helpers.

import type { Db } from "../db.js";
import type { HasNextSteps, NextStep } from "../output.js";

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

export function assertValidArchiveLabel(label: string): void {
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
  /** Number of new archived_notes rows inserted. */
  addedNotes: number;
  /** Number of new archived_events rows inserted. */
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

export interface RawArchiveRow {
  id: number;
  label: string;
  description: string | null;
  created_at: string;
  last_added_at: string;
}

export function rowFromArchive(r: RawArchiveRow): Archive {
  return {
    id: r.id,
    label: r.label,
    description: r.description,
    createdAt: r.created_at,
    lastAddedAt: r.last_added_at,
  };
}

export interface RawArchivedTaskRow {
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

export function rowFromArchivedTask(r: RawArchivedTaskRow): ArchivedTaskRow {
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
export function tryResolveArchiveId(db: Db, label: string): number | null {
  const row = db.prepare("SELECT id FROM archives WHERE label = ?").get(label) as
    | { id: number }
    | undefined;
  return row ? row.id : null;
}

/** Resolve an archive label to its surrogate id, throwing
 *  ArchiveNotFoundError on miss. */
export function resolveArchiveId(db: Db, label: string): number {
  const id = tryResolveArchiveId(db, label);
  if (id === null) throw new ArchiveNotFoundError(label);
  return id;
}

export function archiveByLabel(db: Db, label: string): Archive | null {
  const row = db
    .prepare(
      "SELECT id, label, description, created_at, last_added_at FROM archives WHERE label = ?",
    )
    .get(label) as RawArchiveRow | undefined;
  return row ? rowFromArchive(row) : null;
}

export function summarizeArchive(db: Db, archive: Archive): ArchiveSummary {
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
