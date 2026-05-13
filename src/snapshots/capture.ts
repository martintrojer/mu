// mu — capture and list snapshots.

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, type Db } from "../db.js";
import {
  type CaptureSnapshotResult,
  type ListSnapshotsOptions,
  type RawSnapshotRow,
  type SnapshotRow,
  gcMaxAgeDays,
  gcMaxCount,
  rowFromDb,
  snapshotsDir,
} from "./core.js";

export function captureSnapshot(
  db: Db,
  label: string,
  workstream: string | null = null,
): CaptureSnapshotResult {
  const dir = snapshotsDir(db);
  mkdirSync(dir, { recursive: true });

  const insert = db
    .prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(workstream, label, "", CURRENT_SCHEMA_VERSION, new Date().toISOString());
  const id = Number(insert.lastInsertRowid);
  const dbPath = join(dir, `${id}.db`);

  try {
    db.prepare("UPDATE snapshots SET db_path = ? WHERE id = ?").run(dbPath, id);
    if (existsSync(dbPath)) unlinkSync(dbPath);
    db.exec(`VACUUM INTO ${quoteSqlString(dbPath)}`);
  } catch (err) {
    db.prepare("DELETE FROM snapshots WHERE id = ?").run(id);
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      // Ignore — we're already on the failure path.
    }
    throw err;
  }

  try {
    gcSnapshots(db);
  } catch {
    // Insurance, not version history: GC failure must not break the destructive verb.
  }

  return { id, dbPath };
}

function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

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

export function gcSnapshots(db: Db): { deletedRows: number; deletedFiles: number } {
  const keepLast = gcMaxCount();
  const cutoffDate = new Date(Date.now() - gcMaxAgeDays() * 24 * 60 * 60 * 1000).toISOString();
  const protectedIds = (
    db.prepare(`SELECT id FROM snapshots ORDER BY id DESC LIMIT ${keepLast}`).all() as Array<{
      id: number;
    }>
  ).map((r) => r.id);
  const placeholders = protectedIds.length > 0 ? protectedIds.map(() => "?").join(",") : "NULL";
  const victims = db
    .prepare(
      `SELECT id, db_path FROM snapshots WHERE id NOT IN (${placeholders}) OR created_at < ?`,
    )
    .all(...protectedIds, cutoffDate) as Array<{ id: number; db_path: string }>;

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
