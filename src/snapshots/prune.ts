// mu — manual snapshot cleanup verbs.

import { existsSync, statSync, unlinkSync } from "node:fs";
import type { Db } from "../db.js";
import type { HasNextSteps, NextStep } from "../output.js";
import { captureSnapshot } from "./capture.js";
import { listSnapshots } from "./capture.js";
import {
  type RawSnapshotRow,
  SnapshotNotFoundError,
  type SnapshotRow,
  gcMaxAgeDays,
  gcMaxCount,
  isStaleVersion,
  rowFromDb,
  snapshotFileSize,
} from "./core.js";

export type PruneMode = "gc" | "keep-last" | "older-than" | "stale-version" | "all";

export interface PruneOptions {
  mode: PruneMode;
  keepLast?: number;
  olderThanDays?: number;
  dryRun?: boolean;
}

export interface PruneResult {
  victims: SnapshotRow[];
  freedBytes: number;
  deletedRows: number;
  deletedFiles: number;
  safetyNetSnapshotId?: number;
}

export class PruneOptionsInvalidError extends Error implements HasNextSteps {
  override readonly name = "PruneOptionsInvalidError";
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Show prune options", command: "mu snapshot prune --help" },
      { intent: "List snapshots", command: "mu snapshot list" },
    ];
  }
}

export function pruneSnapshots(db: Db, opts: PruneOptions): PruneResult {
  const mode = opts.mode;
  let victims: SnapshotRow[];
  let safetyNetSnapshotId: number | undefined;
  switch (mode) {
    case "gc": {
      victims = computeGcVictims(db);
      break;
    }
    case "keep-last": {
      if (opts.keepLast === undefined || !Number.isInteger(opts.keepLast) || opts.keepLast < 0) {
        throw new PruneOptionsInvalidError(
          `--keep-last requires a non-negative integer; got ${JSON.stringify(opts.keepLast)}`,
        );
      }
      victims = computeKeepLastVictims(db, opts.keepLast);
      break;
    }
    case "older-than": {
      if (
        opts.olderThanDays === undefined ||
        !Number.isFinite(opts.olderThanDays) ||
        opts.olderThanDays < 0
      ) {
        throw new PruneOptionsInvalidError(
          `--older-than requires a non-negative number of days; got ${JSON.stringify(opts.olderThanDays)}`,
        );
      }
      victims = computeOlderThanVictims(db, opts.olderThanDays);
      break;
    }
    case "stale-version": {
      victims = listSnapshots(db).filter(isStaleVersion);
      break;
    }
    case "all": {
      victims = listSnapshots(db);
      break;
    }
    default: {
      throw new PruneOptionsInvalidError(`unknown prune mode: ${JSON.stringify(mode)}`);
    }
  }

  let freedBytes = 0;
  for (const v of victims) {
    const sz = snapshotFileSize(v);
    if (sz !== null) freedBytes += sz;
  }

  if (opts.dryRun === true) {
    return { victims, freedBytes, deletedRows: 0, deletedFiles: 0 };
  }

  if (mode === "all") {
    const cap = captureSnapshot(db, "snapshot prune --all (safety-net)", null);
    safetyNetSnapshotId = cap.id;
  }

  if (victims.length === 0) {
    return {
      victims,
      freedBytes,
      deletedRows: 0,
      deletedFiles: 0,
      ...(safetyNetSnapshotId !== undefined ? { safetyNetSnapshotId } : {}),
    };
  }

  let deletedFiles = 0;
  for (const v of victims) {
    try {
      if (existsSync(v.dbPath)) {
        unlinkSync(v.dbPath);
        deletedFiles += 1;
      }
    } catch {
      // ignore — orphan file is preferable to a half-completed prune
    }
  }

  const ids = victims.map((v) => v.id);
  const inList = ids.map(() => "?").join(",");
  const result = db.prepare(`DELETE FROM snapshots WHERE id IN (${inList})`).run(...ids);
  return {
    victims,
    freedBytes,
    deletedRows: result.changes,
    deletedFiles,
    ...(safetyNetSnapshotId !== undefined ? { safetyNetSnapshotId } : {}),
  };
}

function computeGcVictims(db: Db): SnapshotRow[] {
  const keepLast = gcMaxCount();
  const cutoffDate = new Date(Date.now() - gcMaxAgeDays() * 24 * 60 * 60 * 1000).toISOString();
  const protectedIds = (
    db.prepare(`SELECT id FROM snapshots ORDER BY id DESC LIMIT ${keepLast}`).all() as Array<{
      id: number;
    }>
  ).map((r) => r.id);
  const placeholders = protectedIds.length > 0 ? protectedIds.map(() => "?").join(",") : "NULL";
  const rows = db
    .prepare(
      `SELECT * FROM snapshots WHERE id NOT IN (${placeholders}) OR created_at < ? ORDER BY id DESC`,
    )
    .all(...protectedIds, cutoffDate) as RawSnapshotRow[];
  return rows.map(rowFromDb);
}

function computeKeepLastVictims(db: Db, n: number): SnapshotRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM snapshots
         WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)
         ORDER BY id DESC`,
    )
    .all(n) as RawSnapshotRow[];
  return rows.map(rowFromDb);
}

function computeOlderThanVictims(db: Db, days: number): SnapshotRow[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare("SELECT * FROM snapshots WHERE created_at < ? ORDER BY id DESC")
    .all(cutoff) as RawSnapshotRow[];
  return rows.map(rowFromDb);
}

export interface DeleteSnapshotResult {
  deleted: true;
  deletedFiles: 0 | 1;
  freedBytes: number;
}

export function deleteSnapshot(db: Db, snapshotId: number): DeleteSnapshotResult {
  const row = db.prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId) as
    | RawSnapshotRow
    | undefined;
  if (!row) throw new SnapshotNotFoundError(snapshotId);
  let freedBytes = 0;
  let deletedFiles: 0 | 1 = 0;
  try {
    if (existsSync(row.db_path)) {
      freedBytes = statSync(row.db_path).size;
      unlinkSync(row.db_path);
      deletedFiles = 1;
    }
  } catch {
    // best-effort; the row goes either way
  }
  db.prepare("DELETE FROM snapshots WHERE id = ?").run(snapshotId);
  return { deleted: true, deletedFiles, freedBytes };
}
