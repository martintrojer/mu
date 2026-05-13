// mu — restore snapshots.

import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, type Db } from "../db.js";
import { captureSnapshot } from "./capture.js";
import {
  type RawSnapshotRow,
  type RestoreSnapshotResult,
  SnapshotFileMissingError,
  SnapshotNotFoundError,
  SnapshotVersionMismatchError,
} from "./core.js";

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

  const pre = captureSnapshot(db, `pre-restore of snapshot ${snapshotId}`, row.workstream);
  const preCreatedAt =
    (
      db.prepare("SELECT created_at FROM snapshots WHERE id = ?").get(pre.id) as
        | { created_at: string }
        | undefined
    )?.created_at ?? new Date().toISOString();

  const livePath = (db as Db & { name: string }).name;
  if (!livePath || livePath === ":memory:") {
    throw new Error(
      `restoreSnapshot: refusing to restore over a non-file DB handle (path=${JSON.stringify(livePath)})`,
    );
  }

  db.close();

  const tmpPath = `${livePath}.restore-${snapshotId}.tmp`;
  copyFileSync(row.db_path, tmpPath);
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

  for (const sidecar of [`${livePath}-wal`, `${livePath}-shm`]) {
    if (existsSync(sidecar)) {
      try {
        unlinkSync(sidecar);
      } catch {
        // ignore — sqlite will recreate on next open
      }
    }
  }

  const tmp = new Database(livePath);
  try {
    tmp.pragma("foreign_keys = ON");
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
