// mu — snapshot shared types, errors, paths, and row helpers.

import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CURRENT_SCHEMA_VERSION, type Db, defaultStateDir } from "../db.js";
import type { HasNextSteps, NextStep } from "../output.js";

export interface SnapshotRow {
  /** Operator-facing snapshot id. EXCEPTION to the no-surrogate-ids rule:
   *  snapshots have no human-meaningful name; the id is what the
   *  operator types in `mu undo --to <id>` / `mu snapshot show <id>`. */
  id: number;
  /** NULL for whole-DB snapshots (e.g. workstream destroy). */
  workstreamName: string | null;
  /** Human-readable operation label, e.g. "task close design". */
  label: string;
  /** Absolute path to the .db file on disk. */
  dbPath: string;
  /** schema_version at the moment of capture. */
  schemaVersion: number;
  /** ISO-8601 capture timestamp. */
  createdAt: string;
}

export interface RawSnapshotRow {
  id: number;
  workstream: string | null;
  label: string;
  db_path: string;
  schema_version: number;
  created_at: string;
}

export function rowFromDb(r: RawSnapshotRow): SnapshotRow {
  return {
    id: r.id,
    workstreamName: r.workstream,
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
            intent: "Inspect the stale snapshot read-only (snapshot is forensic; bypass mu)",
            command: `sqlite3 <snapshot-path> "SELECT * FROM tasks"`,
          },
        ]
      : [
          {
            intent: "Run mu with a newer binary that knows this schema",
            command: "npm install -g @martintrojer/mu@latest",
          },
        ];
  }
}

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

const DEFAULT_GC_MAX_COUNT = 100;
const DEFAULT_GC_MAX_AGE_DAYS = 14;

export function gcMaxCount(): number {
  const env = process.env.MU_SNAPSHOT_KEEP_LAST;
  if (env === undefined || env === "") return DEFAULT_GC_MAX_COUNT;
  const n = Number.parseInt(env, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GC_MAX_COUNT;
  return n;
}

export function gcMaxAgeDays(): number {
  const env = process.env.MU_SNAPSHOT_MAX_AGE_DAYS;
  if (env === undefined || env === "") return DEFAULT_GC_MAX_AGE_DAYS;
  const n = Number.parseInt(env, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GC_MAX_AGE_DAYS;
  return n;
}

export function snapshotsDir(db?: Db): string {
  if (db) {
    const livePath = (db as Db & { name: string }).name;
    if (livePath && livePath !== ":memory:") {
      return join(dirname(livePath), "snapshots");
    }
  }
  return join(defaultStateDir(), "snapshots");
}

export function isStaleVersion(row: { schemaVersion: number }): boolean {
  return row.schemaVersion !== CURRENT_SCHEMA_VERSION;
}

export function snapshotFileSize(snapshot: SnapshotRow): number | null {
  try {
    return statSync(snapshot.dbPath).size;
  } catch {
    return null;
  }
}
