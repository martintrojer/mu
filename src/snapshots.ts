// mu — snapshots SDK.
//
// Pre-mutation backups of the whole DB so destructive verbs become
// recoverable. Implements §1-§4 of snap_design (note #293 on
// snap_design):
//
//   - captureSnapshot: VACUUM INTO a flat <state-dir>/snapshots/<id>.db
//     file, append a row to the `snapshots` table, run opportunistic GC.
//   - listSnapshots: read the table.
//   - restoreSnapshot: version-check the file, then file-swap onto the
//     live DB path. The caller is expected to be a short-lived `mu undo`
//     process; restore closes the live handle internally.
//
// Why VACUUM INTO and not the async db.backup() the design proposed:
// VACUUM INTO is synchronous, which lets the destructive task verbs
// (closeTask / rejectTask / deferTask / releaseTask / deleteTask) hook
// it without an async refactor. Both produce identical standalone .db
// files; both run page-level on the live DB; both honour FK integrity
// across the snapshot. VACUUM INTO additionally drops free-list pages,
// so snapshots are smaller than db.backup() output. See snap_schema's
// task note for the deviation.
//
// What this module does NOT do (deliberately, per snap_design §3):
//   - `mu undo` / `mu snapshot list` CLI verbs (snap_undo_verb's job).
//   - `mu redo` (rejected in design — verbs have side effects we
//     can't replay).
//   - cross-version snapshot migration (rejected in design — refuse
//     instead).
//   - tmux-state rollback (snap_design §EDGE CASES — DB-only, by
//     design; reconcile after restore is the caller's job).

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, type Db, defaultStateDir } from "./db.js";
import type { HasNextSteps, NextStep } from "./output.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface SnapshotRow {
  id: number;
  /** NULL for whole-DB snapshots (e.g. workstream destroy). */
  workstream: string | null;
  /** Human-readable operation label, e.g. "task close design". */
  label: string;
  /** Absolute path to the .db file on disk. */
  dbPath: string;
  /** schema_version at the moment of capture. */
  schemaVersion: number;
  /** ISO-8601 capture timestamp. */
  createdAt: string;
}

interface RawSnapshotRow {
  id: number;
  workstream: string | null;
  label: string;
  db_path: string;
  schema_version: number;
  created_at: string;
}

function rowFromDb(r: RawSnapshotRow): SnapshotRow {
  return {
    id: r.id,
    workstream: r.workstream,
    label: r.label,
    dbPath: r.db_path,
    schemaVersion: r.schema_version,
    createdAt: r.created_at,
  };
}

export interface ListSnapshotsOptions {
  /** Filter to one workstream. NULL-workstream rows are also returned
   *  when this is set, since they (workstream-destroy snapshots) span
   *  every workstream including this one. */
  workstream?: string;
  /** Cap the number of rows returned. Default: no cap. */
  limit?: number;
}

export interface CaptureSnapshotResult {
  id: number;
  dbPath: string;
}

export interface RestoreSnapshotResult {
  id: number;
  /** The path the snapshot was copied to (the live DB path). */
  restoredTo: string;
  /** schema_version of the restored snapshot (== CURRENT_SCHEMA_VERSION
   *  by virtue of having passed the version check). */
  schemaVersion: number;
}

// ─── Errors (typed; mapped to exit codes via cli.ts handle()) ─────────

export class SnapshotNotFoundError extends Error implements HasNextSteps {
  override readonly name = "SnapshotNotFoundError";
  constructor(public readonly snapshotId: number) {
    super(`no such snapshot: ${snapshotId}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List available snapshots", command: "mu snapshot list" },
      {
        intent: "Look one up directly",
        command: `mu sql "SELECT id, label, created_at FROM snapshots ORDER BY id DESC"`,
      },
    ];
  }
}

/**
 * Thrown by restoreSnapshot when the snapshot's schema_version doesn't
 * match the live DB's CURRENT_SCHEMA_VERSION. Maps to exit code 4
 * (conflict). Auto-migration of snapshot files was deliberately rejected
 * in snap_design note #293 (mutates forensic data; migrations are
 * forward-only).
 */
export class SnapshotVersionMismatchError extends Error implements HasNextSteps {
  override readonly name = "SnapshotVersionMismatchError";
  constructor(
    public readonly snapshotId: number,
    public readonly snapshotVersion: number,
    public readonly currentVersion: number,
  ) {
    const direction =
      snapshotVersion < currentVersion
        ? "older — your DB has migrated past it"
        : "newer — written by a newer mu binary";
    super(
      `snapshot ${snapshotId} is at schema v${snapshotVersion}; current DB is at v${currentVersion} (${direction}). mu does not auto-migrate snapshots; refusing restore.`,
    );
  }
  errorNextSteps(): NextStep[] {
    const olderSnapshot = this.snapshotVersion < this.currentVersion;
    return olderSnapshot
      ? [
          {
            intent: "Pick a newer snapshot at the current schema",
            command: `mu sql "SELECT id, label, created_at FROM snapshots WHERE schema_version = ${this.currentVersion} ORDER BY id DESC"`,
          },
          {
            intent: "Inspect the stale snapshot read-only",
            command: `mu sql --db <snapshot-path> "SELECT * FROM tasks"`,
          },
        ]
      : [
          {
            intent: "Run mu with a newer binary that knows this schema",
            command: "npm install -g mu-agent@latest",
          },
        ];
  }
}

/**
 * Thrown when the snapshot's .db file has been removed from disk (manual
 * cleanup, fs corruption) but the row still exists. Maps to exit code 3
 * (not found).
 */
export class SnapshotFileMissingError extends Error implements HasNextSteps {
  override readonly name = "SnapshotFileMissingError";
  constructor(
    public readonly snapshotId: number,
    public readonly dbPath: string,
  ) {
    super(`snapshot ${snapshotId} row exists but file is missing: ${dbPath}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Drop the orphan row",
        command: `mu sql "DELETE FROM snapshots WHERE id = ${this.snapshotId}"`,
      },
      { intent: "List remaining snapshots", command: "mu snapshot list" },
    ];
  }
}

// ─── GC caps (snap_design §CAPTURE STRATEGY > GC) ─────────────────────

/** Snapshots older than this many days are eligible for GC. */
const GC_MAX_AGE_DAYS = 14;
/** Maximum number of rows to keep regardless of age. */
const GC_MAX_COUNT = 100;

// ─── snapshotsDir ─────────────────────────────────────────────────────

/**
 * Resolve the snapshots directory.
 *
 * If a live `Db` handle is supplied, snapshots land under
 * `<dirname(db-path)>/snapshots/` — colocated with the DB they back.
 * This keeps snapshots discoverable for non-default DB paths
 * (`MU_DB_PATH=/some/place/foo.db` users) AND keeps tests that use
 * temp-dir DBs from polluting the user's `~/.local/state/mu/`.
 *
 * Without a Db handle, falls back to `<state-dir>/snapshots/` (the
 * canonical default per snap_design §WHERE).
 *
 * Flat (not per-workstream) by design: workstream-destroy snapshots
 * span every workstream so subdirs would lie about scope.
 */
export function snapshotsDir(db?: Db): string {
  if (db) {
    const livePath = (db as Db & { name: string }).name;
    if (livePath && livePath !== ":memory:") {
      return join(dirname(livePath), "snapshots");
    }
  }
  return join(defaultStateDir(), "snapshots");
}

// ─── captureSnapshot ──────────────────────────────────────────────────

/**
 * Take a whole-DB snapshot before a destructive verb mutates state.
 *
 * Steps:
 *   1. INSERT a row to claim an id.
 *   2. VACUUM INTO <state-dir>/snapshots/<id>.db. Synchronous; runs
 *      page-level on the live DB without extra locks beyond SQLite's
 *      existing busy_timeout.
 *   3. UPDATE the row with the canonical db_path (we couldn't know it
 *      before step 1 because id is AUTOINCREMENT).
 *   4. Run opportunistic GC.
 *
 * If VACUUM INTO fails (disk full, perms, race), the row is rolled back
 * so the DB never points at a non-existent file. The original verb's
 * exception path still surfaces the underlying error.
 *
 * Idempotent on a same-instant double-call (each call gets its own id).
 */
export function captureSnapshot(
  db: Db,
  label: string,
  workstream: string | null = null,
): CaptureSnapshotResult {
  const dir = snapshotsDir(db);
  mkdirSync(dir, { recursive: true });

  // Step 1: claim an id with a placeholder path. We need the id to
  // build the path; without it we'd race on filename selection.
  const insert = db
    .prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(workstream, label, "", CURRENT_SCHEMA_VERSION, new Date().toISOString());
  const id = Number(insert.lastInsertRowid);
  const dbPath = join(dir, `${id}.db`);

  try {
    // Step 2: patch the row with the now-known db_path BEFORE running
    // VACUUM INTO. Order matters: VACUUM INTO snapshots the COMMITTED
    // DB state, so the snapshot file must already contain the correct
    // db_path on its own row. If we did VACUUM first then UPDATE, the
    // restored snapshot would yield a DB whose own snapshot row has
    // db_path='' — caught on the first round-trip smoke test of
    // snap_undo_verb.
    db.prepare("UPDATE snapshots SET db_path = ? WHERE id = ?").run(dbPath, id);
    // Pre-unlink any stale file at this path. VACUUM INTO refuses to
    // overwrite ("output file already exists"), so we clear the slot
    // first. The slot is normally vacant — AUTOINCREMENT never reuses
    // ids within a DB — but two cases can leave a file behind:
    //   1. After restoreSnapshot, the DB's max-id rolls back to the
    //      snapshot's value; next captures use ids that may match
    //      files created in the abandoned forward timeline.
    //   2. Test isolation: each test opens its own DB (id counter
    //      restarts at 1), but the snapshots dir is shared via
    //      MU_STATE_DIR / default. Pre-unlink keeps tests independent.
    if (existsSync(dbPath)) unlinkSync(dbPath);
    // Step 3: VACUUM INTO is the SQLite-blessed way to produce a clean
    // standalone .db file. Synchronous; copies pages, drops free-list
    // entries, doesn't block writers beyond ordinary page locking.
    // Path is interpolated as a SQL string literal — safe because dir
    // and id are mu-controlled (state-dir + AUTOINCREMENT integer).
    db.exec(`VACUUM INTO ${quoteSqlString(dbPath)}`);
  } catch (err) {
    // Roll back the row so we never have a snapshot pointing at a
    // file that doesn't exist. Best-effort unlink in case VACUUM
    // INTO created a partial file before throwing.
    db.prepare("DELETE FROM snapshots WHERE id = ?").run(id);
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      // Ignore — we're already on the failure path.
    }
    throw err;
  }

  // Step 4: opportunistic GC. Best-effort — a GC failure must not
  // break the destructive verb that triggered this snapshot.
  try {
    gcSnapshots(db);
  } catch {
    // Same rationale: insurance, not version history.
  }

  return { id, dbPath };
}

/** Quote a string for safe inclusion in a SQL literal. SQLite's TEXT
 *  literal escaping is doubled single-quotes. */
function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// ─── listSnapshots ────────────────────────────────────────────────────

/**
 * List snapshots, newest first. When `workstream` is set, returns rows
 * for that workstream PLUS rows with workstream = NULL (workstream-
 * destroy snapshots span every workstream so excluding them would hide
 * the most-recent restorable point during recovery).
 */
export function listSnapshots(db: Db, opts: ListSnapshotsOptions = {}): SnapshotRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts.workstream !== undefined) {
    conditions.push("(workstream = ? OR workstream IS NULL)");
    params.push(opts.workstream);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(opts.limit))}` : "";
  const rows = db
    .prepare(`SELECT * FROM snapshots ${where} ORDER BY id DESC ${limit}`)
    .all(...params) as RawSnapshotRow[];
  return rows.map(rowFromDb);
}

// ─── restoreSnapshot ──────────────────────────────────────────────────

/**
 * Restore a snapshot by file-swapping its .db onto the live DB path.
 *
 * Caller contract: pass the live `Db` handle so we can read the live DB
 * path, the snapshot row, and emit a pre-restore self-snapshot for the
 * "undo of undo" case (snap_design §EDGE CASES > snapshot-of-snapshot).
 *
 * The caller is expected to be a short-lived `mu undo` process: this
 * function CLOSES `db` after taking the pre-restore snapshot, then
 * fs.copyFileSync's the snapshot file onto the live DB path and unlinks
 * any -wal / -shm sidecars. Any other live mu process holding the DB
 * will see SQLITE_BUSY / disk-image-malformed on next write and exit
 * cleanly (snap_design recommends gating the verb behind --yes for
 * exactly this reason; that's snap_undo_verb's surface, not ours).
 */
export function restoreSnapshot(db: Db, snapshotId: number): RestoreSnapshotResult {
  const row = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId) as
    | RawSnapshotRow
    | undefined;
  if (!row) throw new SnapshotNotFoundError(snapshotId);
  if (!existsSync(row.db_path)) {
    throw new SnapshotFileMissingError(snapshotId, row.db_path);
  }
  if (row.schema_version !== CURRENT_SCHEMA_VERSION) {
    throw new SnapshotVersionMismatchError(snapshotId, row.schema_version, CURRENT_SCHEMA_VERSION);
  }

  // Pre-restore snapshot so `mu undo` after `mu undo` works
  // (snap_design §EDGE CASES > snapshot-of-snapshot). Capture BEFORE
  // we close the live handle. The .db file lands on disk under
  // <state-dir>/snapshots/<preId>.db; the row goes into the live DB
  // — which we are about to overwrite. We therefore stash the row
  // metadata and re-insert it into the post-restore DB so the user
  // can `mu undo` again to roll back this restore.
  const pre = captureSnapshot(db, `pre-restore of snapshot ${snapshotId}`, row.workstream);
  const preCreatedAt =
    (
      db.prepare("SELECT created_at FROM snapshots WHERE id = ?").get(pre.id) as
        | { created_at: string }
        | undefined
    )?.created_at ?? new Date().toISOString();

  // Resolve the live DB path BEFORE close (better-sqlite3's `name` is
  // the path supplied at open time).
  const livePath = (db as Db & { name: string }).name;
  if (!livePath || livePath === ":memory:") {
    throw new Error(
      `restoreSnapshot: refusing to restore over a non-file DB handle (path=${JSON.stringify(livePath)})`,
    );
  }

  db.close();

  // Atomic-ish swap: copy snapshot to a temp sibling, fsync, rename
  // over the live path. rename(2) is atomic within the same filesystem
  // (which the temp + live both are by construction).
  const tmpPath = `${livePath}.restore-${snapshotId}.tmp`;
  copyFileSync(row.db_path, tmpPath);
  // fsync the copy so the rename can't expose a half-written file on
  // crash. Best-effort: openSync may throw on exotic filesystems.
  try {
    const fd = openSync(tmpPath, "r+");
    try {
      writeSync(fd, Buffer.alloc(0), 0, 0, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    // ignore — fsync is best-effort here
  }
  renameSync(tmpPath, livePath);

  // Nuke -wal / -shm sidecars: the snapshot file is a clean checkpoint
  // (VACUUM INTO produces a fully-merged DB); leftover sidecars from
  // the OLD live DB would confuse SQLite's recovery.
  for (const sidecar of [`${livePath}-wal`, `${livePath}-shm`]) {
    if (existsSync(sidecar)) {
      try {
        unlinkSync(sidecar);
      } catch {
        // ignore — sqlite will recreate on next open
      }
    }
  }

  // Re-stamp the pre-restore snapshot row into the post-restore DB.
  // Use a fresh short-lived connection so the caller doesn't have to
  // know we did it; the connection is closed before we return.
  // Forced-id INSERT keeps any references stable.
  const tmp = new Database(livePath);
  try {
    tmp.pragma("foreign_keys = ON");
    // The pre-restore row's id MAY collide with an id that was
    // already in the snapshot's row set. Use INSERT OR IGNORE: the
    // file on disk is what matters; if a row with that id is
    // already there (because the snapshot itself recorded the
    // history), leave it alone. The pre-restore .db file is still
    // on disk and discoverable via `ls <state-dir>/snapshots/`.
    tmp
      .prepare(
        "INSERT OR IGNORE INTO snapshots (id, workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        pre.id,
        row.workstream,
        `pre-restore of snapshot ${snapshotId}`,
        pre.dbPath,
        CURRENT_SCHEMA_VERSION,
        preCreatedAt,
      );
  } finally {
    tmp.close();
  }

  return {
    id: snapshotId,
    restoredTo: livePath,
    schemaVersion: row.schema_version,
  };
}

// ─── Garbage collection (snap_design §CAPTURE STRATEGY > GC) ──────────

/**
 * Drop snapshots that are BOTH older than GC_MAX_AGE_DAYS AND beyond
 * the GC_MAX_COUNT most-recent rows. "Whichever cap is more permissive
 * wins" (snap_design §GC) — this is the AND of both, which keeps
 * a row IF either cap would keep it.
 *
 * Concretely: keep the 100 most recent + everything <14d old. Delete
 * the rest (and their on-disk .db files).
 *
 * Best-effort on file unlink: if a file is already gone, the row goes
 * anyway (the user's intent — "this snapshot is gone" — is satisfied).
 */
export function gcSnapshots(db: Db): { deletedRows: number; deletedFiles: number } {
  // Find candidates: rows that are BOTH old AND past the count cap.
  const cutoffDate = new Date(Date.now() - GC_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Get rows ordered by id DESC; the first GC_MAX_COUNT are
  // count-cap-protected.
  const protectedIds = (
    db.prepare(`SELECT id FROM snapshots ORDER BY id DESC LIMIT ${GC_MAX_COUNT}`).all() as Array<{
      id: number;
    }>
  ).map((r) => r.id);
  const placeholders = protectedIds.length > 0 ? protectedIds.map(() => "?").join(",") : "NULL";
  const victims = db
    .prepare(
      `SELECT id, db_path FROM snapshots WHERE created_at < ? AND id NOT IN (${placeholders})`,
    )
    .all(cutoffDate, ...protectedIds) as Array<{ id: number; db_path: string }>;

  if (victims.length === 0) return { deletedRows: 0, deletedFiles: 0 };

  let deletedFiles = 0;
  for (const v of victims) {
    try {
      if (existsSync(v.db_path)) {
        unlinkSync(v.db_path);
        deletedFiles += 1;
      }
    } catch {
      // ignore — orphan file is preferable to a half-completed GC
    }
  }

  const ids = victims.map((v) => v.id);
  const inList = ids.map(() => "?").join(",");
  const result = db.prepare(`DELETE FROM snapshots WHERE id IN (${inList})`).run(...ids);
  return { deletedRows: result.changes, deletedFiles };
}

// ─── stat helper (used by tests; cheap to expose) ─────────────────────

/** Return the on-disk size of the snapshot file in bytes, or null if
 *  the file is missing. Useful for `mu snapshot list --json` output. */
export function snapshotFileSize(snapshot: SnapshotRow): number | null {
  try {
    return statSync(snapshot.dbPath).size;
  } catch {
    return null;
  }
}
