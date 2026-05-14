// mu — whole-DB export/import sync SDK.
//
// v0.4 starts with export: a SQLite VACUUM INTO copy plus a tiny
// manifest that lets the later import path detect cross-machine drift.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION, type Db } from "./db.js";
import { latestSeq } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";

export interface DbExportManifestWorkstream {
  name: string;
  tasks: number;
  edges: number;
  notes: number;
  latestSeq: number;
}

export interface DbExportManifest {
  muVersion: string;
  schemaVersion: number;
  machineId: string;
  hostname: string | null;
  exportedAt: string;
  workstreams: DbExportManifestWorkstream[];
}

export interface ExportDbOptions {
  force?: boolean;
}

export interface ExportDbResult {
  file: string;
  manifestPath: string;
  manifest: DbExportManifest;
  overwritten: boolean;
}

export class DbExportTargetExistsError extends Error implements HasNextSteps {
  override readonly name = "DbExportTargetExistsError";
  constructor(public readonly file: string) {
    super(`DB export target already exists: ${file}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Choose a different target", command: "mu db export <new-file>" },
      { intent: "Overwrite this target", command: `mu db export ${shellQuote(this.file)} --force` },
    ];
  }
}

interface MachineIdentityRow {
  machine_id: string;
  hostname: string | null;
}

interface WorkstreamIdRow {
  id: number;
  name: string;
}

export function exportDb(db: Db, file: string, opts: ExportDbOptions = {}): ExportDbResult {
  const target = file;
  const manifestPath = `${target}.manifest.json`;
  const targetExists = existsSync(target);
  if (targetExists && opts.force !== true) throw new DbExportTargetExistsError(target);

  const manifest = buildExportManifest(db);
  mkdirSync(dirname(target), { recursive: true });
  try {
    if (targetExists) unlinkSync(target);
    db.exec(`VACUUM INTO ${quoteSqlString(target)}`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch (err) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {
      // Ignore — preserve the original export failure.
    }
    throw err;
  }

  return { file: target, manifestPath, manifest, overwritten: targetExists };
}

function buildExportManifest(db: Db): DbExportManifest {
  const identity = db
    .prepare("SELECT machine_id, hostname FROM machine_identity WHERE id = 1")
    .get() as MachineIdentityRow | undefined;
  const schemaRow = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
    | { version: number }
    | undefined;
  const workstreams = db
    .prepare("SELECT id, name FROM workstreams ORDER BY name")
    .all() as WorkstreamIdRow[];

  return {
    muVersion: readPackageVersion(),
    schemaVersion: schemaRow?.version ?? CURRENT_SCHEMA_VERSION,
    machineId: identity?.machine_id ?? "",
    hostname: identity?.hostname ?? hostname(),
    exportedAt: new Date().toISOString(),
    workstreams: workstreams.map((ws) => ({
      name: ws.name,
      tasks: count(db, "SELECT COUNT(*) AS n FROM tasks WHERE workstream_id = ?", ws.id),
      edges: count(
        db,
        `SELECT COUNT(*) AS n
           FROM task_edges e
           JOIN tasks f ON f.id = e.from_task_id
           JOIN tasks t ON t.id = e.to_task_id
          WHERE f.workstream_id = ? AND t.workstream_id = ?`,
        ws.id,
        ws.id,
      ),
      notes: count(
        db,
        `SELECT COUNT(*) AS n
           FROM task_notes n
           JOIN tasks t ON t.id = n.task_id
          WHERE t.workstream_id = ?`,
        ws.id,
      ),
      latestSeq: latestSeq(db, ws.id),
    })),
  };
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

function quoteSqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
