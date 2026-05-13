// mu — archive create/list/show/search/read helpers.

import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import {
  type Archive,
  ArchiveAlreadyExistsError,
  ArchiveNotFoundError,
  type ArchiveSummary,
  type ArchivedTaskRow,
  type RawArchiveRow,
  type RawArchivedTaskRow,
  archiveByLabel,
  assertValidArchiveLabel,
  resolveArchiveId,
  rowFromArchive,
  rowFromArchivedTask,
  summarizeArchive,
  tryResolveArchiveId,
} from "./core.js";

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

export interface ListArchivedTasksOptions {
  /** Filter by source workstream. Omit to return every source's
   *  contribution, sorted by (source_workstream, original_local_id). */
  sourceWorkstream?: string;
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
  /** LIKE-style needle. Wrapped in `%…%` automatically. */
  pattern: string;
  /** Restrict to one archive label; undefined = search every
   *  archive. Throws ArchiveNotFoundError on miss. */
  label?: string;
  /** Cap on hits returned. Default 50; values below 1 fall back to
   *  the default. */
  limit?: number;
}

const SEARCH_DEFAULT_LIMIT = 50;
const SNIPPET_WIDTH = 120;

function snippetAround(haystack: string, needle: string): string {
  const literal = needle.replace(/[%_]/g, "");
  if (literal.length === 0) {
    return haystack.length <= SNIPPET_WIDTH ? haystack : `${haystack.slice(0, SNIPPET_WIDTH - 1)}…`;
  }
  const idx = haystack.toLowerCase().indexOf(literal.toLowerCase());
  if (idx < 0) {
    return haystack.length <= SNIPPET_WIDTH ? haystack : `${haystack.slice(0, SNIPPET_WIDTH - 1)}…`;
  }
  const half = Math.floor((SNIPPET_WIDTH - literal.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(haystack.length, start + SNIPPET_WIDTH);
  const head = start > 0 ? "…" : "";
  const tail = end < haystack.length ? "…" : "";
  return `${head}${haystack.slice(start, end)}${tail}`;
}

/** LIKE-search archived task titles AND archived note content. */
export function searchArchives(db: Db, opts: SearchArchivesOptions): ArchiveSearchHit[] {
  const trimmed = opts.pattern.trim();
  if (trimmed.length === 0) {
    throw new Error("searchArchives: pattern must be non-empty");
  }
  const like = `%${trimmed}%`;
  const limit =
    opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : SEARCH_DEFAULT_LIMIT;

  let archiveFilterSql = "";
  const archiveFilterParams: unknown[] = [];
  if (opts.label !== undefined) {
    const archive = getArchive(db, opts.label);
    archiveFilterSql = " AND a.id = ?";
    archiveFilterParams.push(archive.id);
  }

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
