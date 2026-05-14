import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import {
  type DbExportManifest,
  DbImportConflictError,
  DbImportManifestMissingError,
  DbImportSchemaTooNewError,
  DbImportSchemaTooOldError,
  DbImportSourceStaleError,
  type ImportDbResult,
  buildImportPlan,
  exportDb,
  importDb,
} from "../src/db-sync.js";
import { CURRENT_SCHEMA_VERSION, type Db, openDb } from "../src/db.js";
import { appendLog, latestSeq } from "../src/logs.js";
import { addBlockEdge, addNote, addTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let localDb: Db;
let sourceDb: Db;
let localPath: string;
let sourcePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-db-import-"));
  process.env.MU_STATE_DIR = join(tempDir, "state");
  localPath = join(tempDir, "local.db");
  sourcePath = join(tempDir, "source.db");
  localDb = openDb({ path: localPath });
  sourceDb = openDb({ path: sourcePath });
  setTmuxExecutor(async (args) => {
    if (args[0] === "list-sessions") return { stdout: "", stderr: "no sessions", exitCode: 1 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
});

afterEach(() => {
  resetTmuxExecutor();
  localDb.close();
  sourceDb.close();
  rmSync(tempDir, { recursive: true, force: true });
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

function machineId(db: Db): string {
  return (
    db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as {
      machine_id: string;
    }
  ).machine_id;
}

function wsId(db: Db, name: string): number {
  return (db.prepare("SELECT id FROM workstreams WHERE name = ?").get(name) as { id: number }).id;
}

function taskTitles(db: Db, workstream: string): string[] {
  return (
    db
      .prepare(
        "SELECT title FROM tasks WHERE workstream_id = (SELECT id FROM workstreams WHERE name = ?) ORDER BY local_id",
      )
      .all(workstream) as { title: string }[]
  ).map((r) => r.title);
}

function taskCount(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE workstream_id = (SELECT id FROM workstreams WHERE name = ?)",
      )
      .get(workstream) as { n: number }
  ).n;
}

function syncSeq(db: Db, workstream: string, peer: string): number {
  const row = db
    .prepare(
      `SELECT last_known_peer_seqs AS json
         FROM workstream_sync
        WHERE workstream_id = (SELECT id FROM workstreams WHERE name = ?)`,
    )
    .get(workstream) as { json: string } | undefined;
  if (!row) return 0;
  const parsed = JSON.parse(row.json) as Record<string, number>;
  return parsed[peer] ?? 0;
}

function writeSync(db: Db, workstream: string, peer: string, seq: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO workstream_sync (workstream_id, last_known_peer_seqs)
     VALUES ((SELECT id FROM workstreams WHERE name = ?), ?)`,
  ).run(workstream, JSON.stringify({ [peer]: seq }));
}

function addWork(db: Db, workstream: string, localId: string, title = localId): void {
  addTask(db, { workstream, localId, title, impact: 50, effortDays: 1 });
}

function log(db: Db, workstream: string | null, payload: string): number {
  return appendLog(db, { workstream, source: "tester", kind: "message", payload }).seq;
}

function exportSource(): { manifest: DbExportManifest; file: string } {
  const file = join(tempDir, `export-${Math.random().toString(16).slice(2)}.db`);
  const result = exportDb(sourceDb, file);
  return { manifest: result.manifest, file };
}

function seedIdenticalSyncedAlpha(): {
  manifest: DbExportManifest;
  file: string;
  sourcePeer: string;
  seq: number;
} {
  addWork(sourceDb, "alpha", "a", "A");
  addNote(sourceDb, "a", "note", { workstream: "alpha" });
  const { manifest, file } = exportSource();
  importDb(localDb, file, { apply: true });
  const sourcePeer = manifest.machineId;
  const seq = manifest.workstreams.find((w) => w.name === "alpha")?.latestSeq ?? 0;
  return { manifest, file, sourcePeer, seq };
}

function expectDecision(
  summary: readonly { workstream: string; decision: string }[],
  workstream: string,
  decision: string,
): void {
  expect(summary.find((s) => s.workstream === workstream)?.decision).toBe(decision);
}

describe("importDb planning", () => {
  it("classifies IDENTICAL and does not mutate on apply", () => {
    const { file } = seedIdenticalSyncedAlpha();

    const dry = importDb(localDb, file);
    expectDecision(dry.summary, "alpha", "IDENTICAL");
    expect(dry.applied).toBe(false);

    const beforeSnapshots = (
      localDb.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }
    ).n;
    const result = importDb(localDb, file, { apply: true });
    expectDecision(result.summary, "alpha", "IDENTICAL");
    expect(taskTitles(localDb, "alpha")).toEqual(["A"]);
    expect((localDb.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n).toBe(
      beforeSnapshots,
    );
  });

  it("classifies FAST_FORWARD and replaces local rows on apply", () => {
    const { file: first } = seedIdenticalSyncedAlpha();
    expectDecision(importDb(localDb, first).summary, "alpha", "IDENTICAL");

    addWork(sourceDb, "alpha", "b", "B source");
    const { manifest, file } = exportSource();
    const plan = importDb(localDb, file);
    expectDecision(plan.summary, "alpha", "FAST_FORWARD");
    expect(taskTitles(localDb, "alpha")).toEqual(["A"]);

    const applied = importDb(localDb, file, { apply: true });
    expectDecision(applied.summary, "alpha", "FAST_FORWARD");
    expect(taskTitles(localDb, "alpha")).toEqual(["A", "B source"]);
    const seq = manifest.workstreams.find((w) => w.name === "alpha")?.latestSeq ?? 0;
    expect(syncSeq(localDb, "alpha", manifest.machineId)).toBe(seq);
    expect(syncSeq(localDb, "alpha", `${manifest.machineId}:local`)).toBe(
      latestSeq(localDb, wsId(localDb, "alpha")),
    );
  });

  it("classifies LOCAL_AHEAD and refuses apply", () => {
    const { file } = seedIdenticalSyncedAlpha();
    addWork(localDb, "alpha", "local", "Local only");
    log(localDb, "alpha", "local advanced");

    const plan = importDb(localDb, file);
    expectDecision(plan.summary, "alpha", "LOCAL_AHEAD");
    expect(plan.summary.find((s) => s.workstream === "alpha")?.needs).toBe(
      "re-export from this machine",
    );
    expect(() => importDb(localDb, file, { apply: true })).toThrow(DbImportSourceStaleError);
    expect(taskTitles(localDb, "alpha")).toEqual(["A", "Local only"]);
  });

  it("classifies CONFLICT, refuses by default, and --force-source parks then replaces", () => {
    seedIdenticalSyncedAlpha();
    addWork(localDb, "alpha", "local", "Local loser");
    log(localDb, "alpha", "local advanced");
    addWork(sourceDb, "alpha", "source", "Source winner");
    const { file } = exportSource();

    const plan = importDb(localDb, file);
    expectDecision(plan.summary, "alpha", "CONFLICT");
    expect(() => importDb(localDb, file, { apply: true })).toThrow(DbImportConflictError);

    const applied = importDb(localDb, file, { apply: true, forceSource: true });
    expectDecision(applied.summary, "alpha", "CONFLICT");
    const parkPath = applied.summary.find((s) => s.workstream === "alpha")?.parkPath;
    expect(parkPath).toBeDefined();
    expect(parkPath ? existsSync(parkPath) : false).toBe(true);
    expect(taskTitles(localDb, "alpha")).toEqual(["A", "Source winner"]);

    const parked = openDb({ path: parkPath, readonly: true });
    try {
      expect(taskTitles(parked, "alpha")).toEqual(["A", "Local loser"]);
    } finally {
      parked.close();
    }
  });

  it("classifies IMPORT for source-only workstreams and LEAVE_ALONE for local-only collateral", () => {
    addWork(sourceDb, "alpha", "a", "A source");
    addWork(localDb, "beta", "b", "B local");
    const { file } = exportSource();

    const plan = importDb(localDb, file);
    expectDecision(plan.summary, "alpha", "IMPORT");
    expectDecision(plan.summary, "beta", "LEAVE_ALONE");

    importDb(localDb, file, { apply: true });
    expect(taskTitles(localDb, "alpha")).toEqual(["A source"]);
    expect(taskTitles(localDb, "beta")).toEqual(["B local"]);
  });

  it("honors repeated/comma --only-ws restrictions", async () => {
    addWork(sourceDb, "alpha", "a", "A source");
    addWork(sourceDb, "beta", "b", "B source");
    const { file } = exportSource();

    const result = importDb(localDb, file, { onlyWorkstreams: ["alpha,beta", "missing"] });
    expect(result.summary.map((s) => s.workstream)).toEqual(["alpha", "beta"]);

    const cli = await runCli(
      ["db", "import", file, "--only-ws", "alpha,beta", "--only-ws", "missing", "--json"],
      localPath,
    );
    expect(cli.error).toBeUndefined();
    const parsed = JSON.parse(cli.stdout) as ImportDbResult;
    expect(parsed.summary.map((s) => s.workstream)).toEqual(["alpha", "beta"]);
  });
});

describe("importDb data movement", () => {
  it("imports a clean machine without overwriting local machine_identity", () => {
    const originalLocalMachine = machineId(localDb);
    addWork(sourceDb, "alpha", "a", "A");
    addWork(sourceDb, "alpha", "b", "B");
    addBlockEdge(sourceDb, "alpha", "b", "a");
    addNote(sourceDb, "a", "note a", { workstream: "alpha", author: "tester" });
    log(sourceDb, "alpha", "source log");
    const { manifest, file } = exportSource();

    importDb(localDb, file, { apply: true });
    expect(machineId(localDb)).toBe(originalLocalMachine);
    expect(machineId(localDb)).not.toBe(manifest.machineId);
    expect(taskCount(localDb, "alpha")).toBe(2);
    expect((localDb.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n).toBe(
      1,
    );
    const seq = manifest.workstreams.find((w) => w.name === "alpha")?.latestSeq ?? 0;
    expect(syncSeq(localDb, "alpha", manifest.machineId)).toBe(seq);
  });

  it("drops source agents and workspace_path data on import", () => {
    addWork(sourceDb, "alpha", "a", "A");
    insertAgent(sourceDb, {
      workstream: "alpha",
      name: "worker-1",
      cli: "pi",
      paneId: "%1",
      status: "free",
    });
    sourceDb
      .prepare(
        `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, created_at)
         VALUES ((SELECT id FROM agents WHERE name = 'worker-1'), ?, 'none', '/tmp/source-workspace', ?)`,
      )
      .run(wsId(sourceDb, "alpha"), new Date().toISOString());
    const { file } = exportSource();

    importDb(localDb, file, { apply: true });
    expect((localDb.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(0);
    expect(
      (localDb.prepare("SELECT COUNT(*) AS n FROM vcs_workspaces").get() as { n: number }).n,
    ).toBe(0);
    expect(taskTitles(localDb, "alpha")).toEqual(["A"]);
  });

  it("renumbers imported agent_logs while tracking sync state", () => {
    log(localDb, null, "prelude");
    addWork(sourceDb, "alpha", "a", "A");
    log(sourceDb, "alpha", "source log");
    const { manifest, file } = exportSource();

    importDb(localDb, file, { apply: true });
    const rows = localDb.prepare("SELECT seq, payload FROM agent_logs ORDER BY seq").all() as {
      seq: number;
      payload: string;
    }[];
    expect(rows.map((r) => r.payload)).toContain("source log");
    expect(rows.some((r) => r.payload === "source log" && r.seq !== 1)).toBe(true);
    const seq = manifest.workstreams.find((w) => w.name === "alpha")?.latestSeq ?? 0;
    expect(syncSeq(localDb, "alpha", manifest.machineId)).toBe(seq);
  });
});

describe("importDb safeguards", () => {
  it("captures an undo snapshot before destructive apply", async () => {
    seedIdenticalSyncedAlpha();
    addWork(sourceDb, "alpha", "b", "B source");
    const { file } = exportSource();

    const result = importDb(localDb, file, { apply: true });
    expect(result.snapshotId).toBeDefined();
    expect(taskTitles(localDb, "alpha")).toEqual(["A", "B source"]);

    localDb.close();
    const undo = await runCli(["undo", "--yes", "--json"], localPath);
    expect(undo.error).toBeUndefined();
    localDb = openDb({ path: localPath });
    expect(taskTitles(localDb, "alpha")).toEqual(["A"]);
  });

  it("validates source schema version and manifest presence", () => {
    addWork(sourceDb, "alpha", "a", "A");
    const { file } = exportSource();
    const manifestPath = `${file}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DbExportManifest;

    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, schemaVersion: CURRENT_SCHEMA_VERSION - 1 })}\n`,
    );
    expect(() => importDb(localDb, file)).toThrow(DbImportSchemaTooOldError);

    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, schemaVersion: CURRENT_SCHEMA_VERSION + 1 })}\n`,
    );
    expect(() => importDb(localDb, file)).toThrow(DbImportSchemaTooNewError);

    rmSync(manifestPath);
    expect(() => importDb(localDb, file)).toThrow(DbImportManifestMissingError);
  });

  it("CLI maps import conflict and schema errors to distinct typed envelopes", async () => {
    seedIdenticalSyncedAlpha();
    addWork(localDb, "alpha", "local", "Local loser");
    log(localDb, "alpha", "local advanced");
    addWork(sourceDb, "alpha", "source", "Source winner");
    const { file } = exportSource();

    const conflict = await runCli(["db", "import", file, "--apply", "--json"], localPath);
    expect(conflict.exitCode).toBe(12);
    expect(JSON.parse(conflict.stderr)).toMatchObject({ error: "DbImportConflictError" });

    const manifestPath = `${file}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DbExportManifest;
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, schemaVersion: CURRENT_SCHEMA_VERSION + 1 })}\n`,
    );
    const schema = await runCli(["db", "import", file, "--json"], localPath);
    expect(schema.exitCode).toBe(10);
    expect(JSON.parse(schema.stderr)).toMatchObject({ error: "DbImportSchemaTooNewError" });
  });

  it("does not treat importing a DB from the same machine as conflict", () => {
    addWork(localDb, "alpha", "a", "A");
    const exported = exportDb(localDb, join(tempDir, "same-machine.db"));
    expect(buildImportPlan(localDb, exported.manifest, exported.file)).toMatchObject([
      { workstream: "alpha", decision: "IDENTICAL" },
    ]);
  });

  it("classifies a source-omitted synced workstream as LOCAL_AHEAD", () => {
    const exported = exportDb(sourceDb, join(tempDir, "empty-source.db"));
    ensureWorkstream(localDb, "ghost");
    writeSync(localDb, "ghost", exported.manifest.machineId, 1);

    const plan = buildImportPlan(localDb, exported.manifest, exported.file, ["ghost"]);
    expectDecision(plan, "ghost", "LOCAL_AHEAD");
    expect(() =>
      importDb(localDb, exported.file, { apply: true, onlyWorkstreams: ["ghost"] }),
    ).toThrow(DbImportSourceStaleError);
  });
});
