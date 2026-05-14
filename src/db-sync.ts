// mu — whole-DB export/import sync SDK.
//
// Export is a SQLite VACUUM INTO copy plus a tiny manifest. Import is
// deliberately sharp: classify each workstream, refuse drift by default,
// and only clobber with --force-source after parking the local loser.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_SCHEMA_VERSION, type Db, defaultStateDir, openDb } from "./db.js";
import { latestSeq } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { captureSnapshot } from "./snapshots.js";

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

export class DbImportManifestMissingError extends Error implements HasNextSteps {
  override readonly name = "DbImportManifestMissingError";
  constructor(public readonly manifestPath: string) {
    super(`DB import manifest not found: ${manifestPath}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Export the DB with its sidecar", command: "mu db export /tmp/mu.db --force" },
      { intent: "Copy the sidecar too", command: `scp <host>:${shellQuote(this.manifestPath)} .` },
    ];
  }
}

export class DbImportSchemaTooOldError extends Error implements HasNextSteps {
  override readonly name = "DbImportSchemaTooOldError";
  constructor(public readonly sourceVersion: number) {
    super(
      `source DB schema v${sourceVersion} is older than local mu requires (v${CURRENT_SCHEMA_VERSION})`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Upgrade mu on the source machine",
        command: "npm run build && mu db export <file> --force",
      },
      { intent: "Then retry this import", command: "mu db import <file> --apply" },
    ];
  }
}

export class DbImportSchemaTooNewError extends Error implements HasNextSteps {
  override readonly name = "DbImportSchemaTooNewError";
  constructor(public readonly sourceVersion: number) {
    super(
      `source DB schema v${sourceVersion} is newer than this mu supports (v${CURRENT_SCHEMA_VERSION}); upgrade local mu`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Upgrade local mu", command: "git pull && npm install && npm run build" },
      { intent: "Then retry this import", command: "mu db import <file> --apply" },
    ];
  }
}

export class DbImportSourceStaleError extends Error implements HasNextSteps {
  override readonly name = "DbImportSourceStaleError";
  constructor(public readonly workstreams: readonly string[]) {
    super(`source DB is stale for local-ahead workstream(s): ${workstreams.join(", ")}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Re-export from this machine", command: "mu db export /tmp/mu-fresh.db --force" },
      { intent: "Dry-run the incoming file first", command: "mu db import <file>" },
    ];
  }
}

export class DbImportConflictError extends Error implements HasNextSteps {
  override readonly name = "DbImportConflictError";
  constructor(public readonly workstreams: readonly string[]) {
    super(`source and local both advanced for workstream(s): ${workstreams.join(", ")}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Preview the conflicting workstreams", command: "mu db import <file> --json" },
      {
        intent: "Clobber from source after parking local divergence",
        command: "mu db import <file> --apply --force-source",
      },
    ];
  }
}

export type DbImportDecision =
  | "IDENTICAL"
  | "FAST_FORWARD"
  | "LOCAL_AHEAD"
  | "CONFLICT"
  | "IMPORT"
  | "LEAVE_ALONE";

export interface DbImportSummaryItem {
  workstream: string;
  decision: DbImportDecision;
  delta: Record<string, unknown>;
  needs?: string;
  parkPath?: string;
}

export interface ImportDbOptions {
  apply?: boolean;
  forceSource?: boolean;
  onlyWorkstreams?: readonly string[];
}

export interface ImportDbResult {
  machineId: string;
  sourceFile: string;
  dryRun: boolean;
  applied: boolean;
  snapshotId?: number;
  summary: DbImportSummaryItem[];
}

interface MachineIdentityRow {
  machine_id: string;
  hostname: string | null;
  created_at?: string;
}

interface WorkstreamIdRow {
  id: number;
  name: string;
}

interface WorkstreamRow {
  id: number;
  name: string;
  created_at: string;
}

interface TaskCopyRow {
  local_id: string;
  title: string;
  status: string;
  impact: number;
  effort_days: number;
  owner_name: string | null;
  created_at: string;
  updated_at: string;
}

interface EdgeCopyRow {
  from_local_id: string;
  to_local_id: string;
  created_at: string;
}

interface NoteCopyRow {
  task_local_id: string;
  author: string | null;
  content: string;
  created_at: string;
}

interface LogCopyRow {
  seq: number;
  source: string;
  kind: string;
  payload: string;
  created_at: string;
}

interface AgentCopyRow {
  name: string;
  cli: string;
  pane_id: string;
  status: string;
  role: string;
  tab: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceCopyRow {
  agent_name: string;
  backend: string;
  path: string;
  parent_ref: string | null;
  created_at: string;
}

interface CopyWorkstreamOptions {
  includeMachineLocalRows: boolean;
  preserveLogSeq: boolean;
  includeSync: boolean;
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

export function importDb(db: Db, file: string, opts: ImportDbOptions = {}): ImportDbResult {
  const manifest = readImportManifest(file);
  assertImportSchemaCompatible(manifest.schemaVersion);

  const sourceDb = openDb({ path: file, readonly: true });
  try {
    const summary = buildImportPlan(db, manifest, file, opts.onlyWorkstreams);
    if (opts.apply !== true) {
      return {
        machineId: manifest.machineId,
        sourceFile: file,
        dryRun: true,
        applied: false,
        summary,
      };
    }

    const stale = summary.filter((s) => s.decision === "LOCAL_AHEAD").map((s) => s.workstream);
    if (stale.length > 0) throw new DbImportSourceStaleError(stale);
    const conflicts = summary.filter((s) => s.decision === "CONFLICT").map((s) => s.workstream);
    if (conflicts.length > 0 && opts.forceSource !== true)
      throw new DbImportConflictError(conflicts);

    const mutating = summary.some((s) => shouldReplace(s.decision, opts.forceSource === true));
    const snapshot = mutating ? captureSnapshot(db, `db import ${file}`, null) : undefined;

    for (const item of summary) {
      if (!shouldReplace(item.decision, opts.forceSource === true)) continue;
      if (item.decision === "CONFLICT") {
        item.parkPath = parkLocalWorkstream(db, item.workstream);
      }
      const sourceWs = manifest.workstreams.find((w) => w.name === item.workstream);
      const sourceSeq = sourceWs?.latestSeq ?? 0;
      replaceWorkstreamFromSource(db, sourceDb, item.workstream, manifest.machineId, sourceSeq);
    }

    return {
      machineId: manifest.machineId,
      sourceFile: file,
      dryRun: false,
      applied: true,
      ...(snapshot ? { snapshotId: snapshot.id } : {}),
      summary,
    };
  } finally {
    sourceDb.close();
  }
}

export function buildImportPlan(
  localDb: Db,
  manifest: DbExportManifest,
  sourceFile: string,
  onlyWorkstreams?: readonly string[],
): DbImportSummaryItem[] {
  const sourceByName = new Map(manifest.workstreams.map((w) => [w.name, w]));
  const localByName = new Map(listLocalWorkstreams(localDb).map((w) => [w.name, w]));
  const localMachineId = getMachineIdentity(localDb)?.machine_id ?? "";
  const only = normaliseOnlyWorkstreams(onlyWorkstreams);
  const names = Array.from(new Set([...sourceByName.keys(), ...localByName.keys()]))
    .filter((name) => only.size === 0 || only.has(name))
    .sort();

  return names.map((name) => {
    const source = sourceByName.get(name);
    const local = localByName.get(name);
    const sourceSeq = source?.latestSeq ?? 0;
    const localSeq = local ? latestSeq(localDb, local.id) : 0;
    const synced =
      source !== undefined && local !== undefined && manifest.machineId === localMachineId
        ? { sourceSeq: Math.min(sourceSeq, localSeq), localSeq: Math.min(sourceSeq, localSeq) }
        : local
          ? lastKnownPeerSync(localDb, local.id, manifest.machineId)
          : { sourceSeq: 0, localSeq: 0 };

    const decision = classifyWorkstream({
      hasSource: source !== undefined,
      hasLocal: local !== undefined,
      sourceSeq,
      localSeq,
      syncedSourceSeq: synced.sourceSeq,
      syncedLocalSeq: synced.localSeq,
    });
    return {
      workstream: name,
      decision,
      delta: {
        sourceFile,
        sourceSeq,
        localSeq,
        lastSynced: synced.sourceSeq,
        localSynced: synced.localSeq,
        source: source ? countsFromManifest(source) : null,
        local: local ? countWorkstream(localDb, local.id) : null,
      },
      ...(decision === "LOCAL_AHEAD" ? { needs: "re-export from this machine" } : {}),
      ...(decision === "CONFLICT" ? { needs: "--force-source" } : {}),
    };
  });
}

function classifyWorkstream(opts: {
  hasSource: boolean;
  hasLocal: boolean;
  sourceSeq: number;
  localSeq: number;
  syncedSourceSeq: number;
  syncedLocalSeq: number;
}): DbImportDecision {
  if (opts.hasSource && !opts.hasLocal) return "IMPORT";
  if (!opts.hasSource && opts.hasLocal)
    return opts.syncedSourceSeq > 0 || opts.syncedLocalSeq > 0 ? "LOCAL_AHEAD" : "LEAVE_ALONE";
  if (!opts.hasSource && !opts.hasLocal) return "IDENTICAL";

  const sourceAdvanced = opts.sourceSeq > opts.syncedSourceSeq;
  const localAdvanced = opts.localSeq > opts.syncedLocalSeq;
  if (!sourceAdvanced && !localAdvanced) return "IDENTICAL";
  if (sourceAdvanced && !localAdvanced) return "FAST_FORWARD";
  if (!sourceAdvanced && localAdvanced) return "LOCAL_AHEAD";
  return "CONFLICT";
}

function shouldReplace(decision: DbImportDecision, forceSource: boolean): boolean {
  return (
    decision === "FAST_FORWARD" || decision === "IMPORT" || (decision === "CONFLICT" && forceSource)
  );
}

function replaceWorkstreamFromSource(
  localDb: Db,
  sourceDb: Db,
  workstream: string,
  sourceMachineId: string,
  sourceSeq: number,
): void {
  localDb.transaction(() => {
    const existing = localDb.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as
      | { id: number }
      | undefined;
    if (existing) {
      localDb.prepare("DELETE FROM vcs_workspaces WHERE workstream_id = ?").run(existing.id);
      localDb.prepare("DELETE FROM agents WHERE workstream_id = ?").run(existing.id);
      localDb.prepare("DELETE FROM workstreams WHERE id = ?").run(existing.id);
    }
    copyWorkstreamRows(sourceDb, localDb, workstream, {
      includeMachineLocalRows: false,
      preserveLogSeq: false,
      includeSync: false,
    });
    const wsId = (
      localDb.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as
        | { id: number }
        | undefined
    )?.id;
    if (wsId === undefined) throw new Error(`importDb: failed to import workstream ${workstream}`);
    writeSyncState(localDb, wsId, sourceMachineId, sourceSeq);
  })();
}

function parkLocalWorkstream(db: Db, workstream: string): string {
  const dir = join(defaultStateDir(), "divergence");
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `${workstream}-${new Date().toISOString()}-${randomUUID().slice(0, 8)}.db`,
  );
  const parkDb = openDb({ path });
  try {
    const identity = getMachineIdentity(db);
    if (identity) {
      parkDb
        .prepare(
          `UPDATE machine_identity
              SET machine_id = ?, hostname = ?, created_at = ?
            WHERE id = 1`,
        )
        .run(
          identity.machine_id,
          identity.hostname,
          identity.created_at ?? new Date().toISOString(),
        );
    }
    copyWorkstreamRows(db, parkDb, workstream, {
      includeMachineLocalRows: true,
      preserveLogSeq: true,
      includeSync: true,
    });
  } catch (err) {
    try {
      parkDb.close();
    } catch {
      // keep original error
    }
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // keep original error
    }
    throw err;
  }
  parkDb.close();
  return path;
}

function copyWorkstreamRows(
  sourceDb: Db,
  targetDb: Db,
  workstream: string,
  opts: CopyWorkstreamOptions,
): void {
  const sourceWs = sourceDb
    .prepare("SELECT id, name, created_at FROM workstreams WHERE name = ?")
    .get(workstream) as WorkstreamRow | undefined;
  if (!sourceWs) throw new Error(`copyWorkstreamRows: no such workstream ${workstream}`);

  targetDb
    .prepare("INSERT INTO workstreams (name, created_at) VALUES (?, ?)")
    .run(sourceWs.name, sourceWs.created_at);
  const targetWsId = (
    targetDb.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as { id: number }
  ).id;

  if (opts.includeMachineLocalRows) copyAgents(sourceDb, targetDb, sourceWs.id, targetWsId);
  copyTasks(sourceDb, targetDb, sourceWs.id, targetWsId, opts.includeMachineLocalRows);
  copyEdges(sourceDb, targetDb, sourceWs.id, targetWsId);
  copyNotes(sourceDb, targetDb, sourceWs.id, targetWsId);
  copyLogs(sourceDb, targetDb, sourceWs.id, targetWsId, opts.preserveLogSeq);
  if (opts.includeMachineLocalRows) copyWorkspaces(sourceDb, targetDb, sourceWs.id, targetWsId);
  if (opts.includeSync) copySync(sourceDb, targetDb, sourceWs.id, targetWsId);
}

function copyAgents(sourceDb: Db, targetDb: Db, sourceWsId: number, targetWsId: number): void {
  const rows = sourceDb
    .prepare(
      `SELECT name, cli, pane_id, status, role, tab, created_at, updated_at
         FROM agents
        WHERE workstream_id = ?
        ORDER BY id`,
    )
    .all(sourceWsId) as AgentCopyRow[];
  const insert = targetDb.prepare(
    `INSERT INTO agents (workstream_id, name, cli, pane_id, status, role, tab, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      targetWsId,
      row.name,
      row.cli,
      row.pane_id,
      row.status,
      row.role,
      row.tab,
      row.created_at,
      row.updated_at,
    );
  }
}

function copyTasks(
  sourceDb: Db,
  targetDb: Db,
  sourceWsId: number,
  targetWsId: number,
  includeOwners: boolean,
): void {
  const rows = sourceDb
    .prepare(
      `SELECT t.local_id, t.title, t.status, t.impact, t.effort_days, a.name AS owner_name,
              t.created_at, t.updated_at
         FROM tasks t
         LEFT JOIN agents a ON a.id = t.owner_id
        WHERE t.workstream_id = ?
        ORDER BY t.id`,
    )
    .all(sourceWsId) as TaskCopyRow[];
  const ownerLookup = targetDb.prepare(
    "SELECT id FROM agents WHERE workstream_id = ? AND name = ?",
  );
  const insert = targetDb.prepare(
    `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days, owner_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const ownerId =
      includeOwners && row.owner_name !== null
        ? ((ownerLookup.get(targetWsId, row.owner_name) as { id: number } | undefined)?.id ?? null)
        : null;
    insert.run(
      targetWsId,
      row.local_id,
      row.title,
      row.status,
      row.impact,
      row.effort_days,
      ownerId,
      row.created_at,
      row.updated_at,
    );
  }
}

function copyEdges(sourceDb: Db, targetDb: Db, sourceWsId: number, targetWsId: number): void {
  const rows = sourceDb
    .prepare(
      `SELECT f.local_id AS from_local_id, t.local_id AS to_local_id, e.created_at
         FROM task_edges e
         JOIN tasks f ON f.id = e.from_task_id
         JOIN tasks t ON t.id = e.to_task_id
        WHERE f.workstream_id = ? AND t.workstream_id = ?
        ORDER BY e.created_at, f.local_id, t.local_id`,
    )
    .all(sourceWsId, sourceWsId) as EdgeCopyRow[];
  const insert = targetDb.prepare(
    `INSERT OR IGNORE INTO task_edges (from_task_id, to_task_id, created_at)
     SELECT f.id, t.id, ?
       FROM tasks f, tasks t
      WHERE f.workstream_id = ? AND f.local_id = ?
        AND t.workstream_id = ? AND t.local_id = ?`,
  );
  for (const row of rows) {
    insert.run(row.created_at, targetWsId, row.from_local_id, targetWsId, row.to_local_id);
  }
}

function copyNotes(sourceDb: Db, targetDb: Db, sourceWsId: number, targetWsId: number): void {
  const rows = sourceDb
    .prepare(
      `SELECT t.local_id AS task_local_id, n.author, n.content, n.created_at
         FROM task_notes n
         JOIN tasks t ON t.id = n.task_id
        WHERE t.workstream_id = ?
        ORDER BY n.id`,
    )
    .all(sourceWsId) as NoteCopyRow[];
  const insert = targetDb.prepare(
    `INSERT INTO task_notes (task_id, author, content, created_at)
     SELECT id, ?, ?, ? FROM tasks WHERE workstream_id = ? AND local_id = ?`,
  );
  for (const row of rows) {
    insert.run(row.author, row.content, row.created_at, targetWsId, row.task_local_id);
  }
}

function copyLogs(
  sourceDb: Db,
  targetDb: Db,
  sourceWsId: number,
  targetWsId: number,
  preserveSeq: boolean,
): void {
  const rows = sourceDb
    .prepare(
      `SELECT seq, source, kind, payload, created_at
         FROM agent_logs
        WHERE workstream_id = ?
        ORDER BY seq`,
    )
    .all(sourceWsId) as LogCopyRow[];
  const insertPreserve = targetDb.prepare(
    "INSERT INTO agent_logs (seq, workstream_id, source, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertRenumber = targetDb.prepare(
    "INSERT INTO agent_logs (workstream_id, source, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    if (preserveSeq) {
      insertPreserve.run(row.seq, targetWsId, row.source, row.kind, row.payload, row.created_at);
    } else {
      insertRenumber.run(targetWsId, row.source, row.kind, row.payload, row.created_at);
    }
  }
}

function copyWorkspaces(sourceDb: Db, targetDb: Db, sourceWsId: number, targetWsId: number): void {
  const rows = sourceDb
    .prepare(
      `SELECT a.name AS agent_name, v.backend, v.path, v.parent_ref, v.created_at
         FROM vcs_workspaces v
         JOIN agents a ON a.id = v.agent_id
        WHERE v.workstream_id = ?
        ORDER BY v.id`,
    )
    .all(sourceWsId) as WorkspaceCopyRow[];
  const agentLookup = targetDb.prepare(
    "SELECT id FROM agents WHERE workstream_id = ? AND name = ?",
  );
  const insert = targetDb.prepare(
    `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const agentId = (agentLookup.get(targetWsId, row.agent_name) as { id: number } | undefined)?.id;
    if (agentId === undefined) continue;
    insert.run(agentId, targetWsId, row.backend, row.path, row.parent_ref, row.created_at);
  }
}

function copySync(sourceDb: Db, targetDb: Db, sourceWsId: number, targetWsId: number): void {
  const row = sourceDb
    .prepare("SELECT last_known_peer_seqs FROM workstream_sync WHERE workstream_id = ?")
    .get(sourceWsId) as { last_known_peer_seqs: string } | undefined;
  if (!row) return;
  targetDb
    .prepare("INSERT INTO workstream_sync (workstream_id, last_known_peer_seqs) VALUES (?, ?)")
    .run(targetWsId, row.last_known_peer_seqs);
}

function writeSyncState(
  db: Db,
  workstreamId: number,
  sourceMachineId: string,
  sourceSeq: number,
): void {
  const localSeq = latestSeq(db, workstreamId);
  const peers: Record<string, number> = {
    [sourceMachineId]: sourceSeq,
    [localSeqKey(sourceMachineId)]: localSeq,
  };
  db.prepare(
    `INSERT OR REPLACE INTO workstream_sync (workstream_id, last_known_peer_seqs)
     VALUES (?, ?)`,
  ).run(workstreamId, JSON.stringify(peers));
}

function lastKnownPeerSync(
  db: Db,
  workstreamId: number,
  machineId: string,
): { sourceSeq: number; localSeq: number } {
  const row = db
    .prepare("SELECT last_known_peer_seqs FROM workstream_sync WHERE workstream_id = ?")
    .get(workstreamId) as { last_known_peer_seqs: string } | undefined;
  if (!row) return { sourceSeq: 0, localSeq: 0 };
  const parsed = parsePeerSeqs(row.last_known_peer_seqs);
  const sourceSeq = parsed[machineId] ?? 0;
  return { sourceSeq, localSeq: parsed[localSeqKey(machineId)] ?? sourceSeq };
}

function localSeqKey(machineId: string): string {
  return `${machineId}:local`;
}

function parsePeerSeqs(raw: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function readImportManifest(file: string): DbExportManifest {
  const manifestPath = `${file}.manifest.json`;
  if (!existsSync(manifestPath)) throw new DbImportManifestMissingError(manifestPath);
  return JSON.parse(readFileSync(manifestPath, "utf8")) as DbExportManifest;
}

function assertImportSchemaCompatible(sourceVersion: number): void {
  if (sourceVersion < CURRENT_SCHEMA_VERSION) throw new DbImportSchemaTooOldError(sourceVersion);
  if (sourceVersion > CURRENT_SCHEMA_VERSION) throw new DbImportSchemaTooNewError(sourceVersion);
}

function buildExportManifest(db: Db): DbExportManifest {
  const identity = getMachineIdentity(db);
  const schemaRow = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
    | { version: number }
    | undefined;
  const workstreams = listLocalWorkstreams(db);

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

function listLocalWorkstreams(db: Db): WorkstreamIdRow[] {
  return db.prepare("SELECT id, name FROM workstreams ORDER BY name").all() as WorkstreamIdRow[];
}

function getMachineIdentity(db: Db): MachineIdentityRow | undefined {
  return db
    .prepare("SELECT machine_id, hostname, created_at FROM machine_identity WHERE id = 1")
    .get() as MachineIdentityRow | undefined;
}

function countWorkstream(db: Db, wsId: number): Record<string, number> {
  return {
    tasks: count(db, "SELECT COUNT(*) AS n FROM tasks WHERE workstream_id = ?", wsId),
    edges: count(
      db,
      `SELECT COUNT(*) AS n
         FROM task_edges e
         JOIN tasks f ON f.id = e.from_task_id
         JOIN tasks t ON t.id = e.to_task_id
        WHERE f.workstream_id = ? AND t.workstream_id = ?`,
      wsId,
      wsId,
    ),
    notes: count(
      db,
      `SELECT COUNT(*) AS n
         FROM task_notes n
         JOIN tasks t ON t.id = n.task_id
        WHERE t.workstream_id = ?`,
      wsId,
    ),
  };
}

function countsFromManifest(ws: DbExportManifestWorkstream): Record<string, number> {
  return { tasks: ws.tasks, edges: ws.edges, notes: ws.notes };
}

function normaliseOnlyWorkstreams(input: readonly string[] | undefined): Set<string> {
  if (!input || input.length === 0) return new Set();
  return new Set(
    input
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  );
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

export {
  DbReplayLocalIdConflictError,
  DbReplayWorkstreamMissingError,
  buildReplayPlan,
  replayDb,
  type DbReplayEdgeItem,
  type DbReplayNoteItem,
  type DbReplayPlan,
  type DbReplayResult,
  type DbReplayTaskConflict,
  type DbReplayTaskItem,
  type ReplayDbOptions,
} from "./db-sync-replay.js";
