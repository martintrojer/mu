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
import { type TaskStatus, addBlockEdge, addNote, addTask } from "../src/tasks.js";
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

function localAgentCount(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM agents WHERE workstream_id = (SELECT id FROM workstreams WHERE name = ?)",
      )
      .get(workstream) as { n: number }
  ).n;
}

function localWorkspaceCount(db: Db, workstream: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM vcs_workspaces WHERE workstream_id = (SELECT id FROM workstreams WHERE name = ?)",
      )
      .get(workstream) as { n: number }
  ).n;
}

function seedLocalAgentAndWorkspace(db: Db, workstream: string, agentName: string): void {
  insertAgent(db, {
    workstream,
    name: agentName,
    cli: "pi",
    paneId: `%${agentName}`,
    status: "free",
  });
  const workstreamId = wsId(db, workstream);
  db.prepare(
    `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, created_at)
     VALUES ((SELECT id FROM agents WHERE workstream_id = ? AND name = ?), ?, 'none', ?, ?)`,
  ).run(
    workstreamId,
    agentName,
    workstreamId,
    join(tempDir, `${workstream}-${agentName}`),
    new Date().toISOString(),
  );
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

interface FidelityTaskRow {
  local_id: string;
  title: string;
  status: TaskStatus;
  impact: number;
  effort_days: number;
  owner_id: number | null;
  created_at: string;
  updated_at: string;
}

interface FidelityEdgeRow {
  from_local_id: string;
  to_local_id: string;
  created_at: string;
}

interface FidelityNoteRow {
  task_local_id: string;
  author: string | null;
  content: string;
  created_at: string;
}

interface FidelitySnapshot {
  tasks: FidelityTaskRow[];
  edges: FidelityEdgeRow[];
  notes: FidelityNoteRow[];
}

function fidelitySnapshot(db: Db, workstream: string): FidelitySnapshot {
  const tasks = db
    .prepare(
      `SELECT local_id, title, status, impact, effort_days, owner_id, created_at, updated_at
         FROM tasks
        WHERE workstream_id = (SELECT id FROM workstreams WHERE name = ?)
        ORDER BY local_id`,
    )
    .all(workstream) as FidelityTaskRow[];
  const edges = db
    .prepare(
      `SELECT f.local_id AS from_local_id, t.local_id AS to_local_id, e.created_at
         FROM task_edges e
         JOIN tasks f ON f.id = e.from_task_id
         JOIN tasks t ON t.id = e.to_task_id
         JOIN workstreams ws ON ws.id = f.workstream_id
        WHERE ws.name = ? AND t.workstream_id = ws.id
        ORDER BY from_local_id, to_local_id`,
    )
    .all(workstream) as FidelityEdgeRow[];
  const notes = db
    .prepare(
      `SELECT t.local_id AS task_local_id, n.author, n.content, n.created_at
         FROM task_notes n
         JOIN tasks t ON t.id = n.task_id
         JOIN workstreams ws ON ws.id = t.workstream_id
        WHERE ws.name = ?
        ORDER BY task_local_id, n.created_at, n.content`,
    )
    .all(workstream) as FidelityNoteRow[];
  return { tasks, edges, notes };
}

function expectImportedFixtureMatchesSource(destinationDb: Db): void {
  const expected = fidelitySnapshot(sourceDb, "alpha");
  const actual = fidelitySnapshot(destinationDb, "alpha");
  expect(actual).toEqual({
    ...expected,
    tasks: expected.tasks.map((task) => ({ ...task, owner_id: null })),
  });
}

function seedFidelitySource(): void {
  const tasks: Array<{
    localId: string;
    title: string;
    status: TaskStatus;
    impact: number;
    effortDays: number;
    createdAt: string;
    updatedAt: string;
  }> = [
    {
      localId: "open",
      title: "Open fixture",
      status: "OPEN",
      impact: 1,
      effortDays: 0.1,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:01:00.000Z",
    },
    {
      localId: "doing",
      title: "In progress fixture",
      status: "IN_PROGRESS",
      impact: 50,
      effortDays: 1.5,
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:01:00.000Z",
    },
    {
      localId: "closed",
      title: "Closed fixture",
      status: "CLOSED",
      impact: 100,
      effortDays: 30,
      createdAt: "2026-05-03T00:00:00.000Z",
      updatedAt: "2026-05-03T00:01:00.000Z",
    },
    {
      localId: "rejected",
      title: "Rejected fixture",
      status: "REJECTED",
      impact: 25,
      effortDays: 2,
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:01:00.000Z",
    },
    {
      localId: "deferred",
      title: "Deferred fixture",
      status: "DEFERRED",
      impact: 75,
      effortDays: 7.25,
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:01:00.000Z",
    },
  ];
  for (const task of tasks) {
    addTask(sourceDb, {
      workstream: "alpha",
      localId: task.localId,
      title: task.title,
      impact: task.impact,
      effortDays: task.effortDays,
    });
    sourceDb
      .prepare(
        `UPDATE tasks
            SET status = ?, created_at = ?, updated_at = ?
          WHERE workstream_id = (SELECT id FROM workstreams WHERE name = 'alpha')
            AND local_id = ?`,
      )
      .run(task.status, task.createdAt, task.updatedAt, task.localId);
  }
  sourceDb
    .prepare(
      `INSERT INTO task_edges (from_task_id, to_task_id, created_at)
       SELECT f.id, t.id, ? FROM tasks f, tasks t
        WHERE f.workstream_id = (SELECT id FROM workstreams WHERE name = 'alpha')
          AND t.workstream_id = f.workstream_id
          AND f.local_id = ? AND t.local_id = ?`,
    )
    .run("2026-05-06T00:00:00.000Z", "open", "doing");
  sourceDb
    .prepare(
      `INSERT INTO task_edges (from_task_id, to_task_id, created_at)
       SELECT f.id, t.id, ? FROM tasks f, tasks t
        WHERE f.workstream_id = (SELECT id FROM workstreams WHERE name = 'alpha')
          AND t.workstream_id = f.workstream_id
          AND f.local_id = ? AND t.local_id = ?`,
    )
    .run("2026-05-06T00:01:00.000Z", "doing", "closed");
  sourceDb
    .prepare(
      `INSERT INTO task_notes (task_id, author, content, created_at)
       SELECT id, ?, ?, ? FROM tasks
        WHERE workstream_id = (SELECT id FROM workstreams WHERE name = 'alpha')
          AND local_id = ?`,
    )
    .run(null, "null-author source note", "2026-05-07T00:00:00.000Z", "open");
  sourceDb
    .prepare(
      `INSERT INTO task_notes (task_id, author, content, created_at)
       SELECT id, ?, ?, ? FROM tasks
        WHERE workstream_id = (SELECT id FROM workstreams WHERE name = 'alpha')
          AND local_id = ?`,
    )
    .run("worker-1", "authored source note", "2026-05-07T00:01:00.000Z", "closed");
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
    const { sourcePeer, seq } = seedIdenticalSyncedAlpha();
    addWork(localDb, "alpha", "blocker", "Local-only blocker");
    addWork(localDb, "alpha", "local", "Local loser");
    addBlockEdge(localDb, "alpha", "local", "blocker");
    addNote(localDb, "local", "local-only forensic note", {
      workstream: "alpha",
      author: "local-author",
    });
    log(localDb, "alpha", "local-only forensic log");
    writeSync(localDb, "alpha", sourcePeer, seq);
    seedLocalAgentAndWorkspace(localDb, "alpha", "local-agent");
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
    expect(localAgentCount(localDb, "alpha")).toBe(0);
    expect(localWorkspaceCount(localDb, "alpha")).toBe(0);

    const parked = openDb({ path: parkPath, readonly: true });
    try {
      expect(taskTitles(parked, "alpha")).toEqual(["A", "Local-only blocker", "Local loser"]);
      expect(
        (
          parked
            .prepare(
              `SELECT COUNT(*) AS n
                 FROM task_notes n
                 JOIN tasks t ON t.id = n.task_id
                 JOIN workstreams ws ON ws.id = t.workstream_id
                WHERE ws.name = 'alpha'
                  AND t.local_id = 'local'
                  AND n.author = 'local-author'
                  AND n.content = 'local-only forensic note'`,
            )
            .get() as { n: number }
        ).n,
      ).toBe(1);
      expect(
        (
          parked
            .prepare(
              `SELECT COUNT(*) AS n
                 FROM task_edges e
                 JOIN tasks f ON f.id = e.from_task_id
                 JOIN tasks t ON t.id = e.to_task_id
                WHERE f.local_id = 'blocker' AND t.local_id = 'local'`,
            )
            .get() as { n: number }
        ).n,
      ).toBe(1);
      expect(
        (
          parked
            .prepare(
              "SELECT COUNT(*) AS n FROM agent_logs WHERE payload = 'local-only forensic log'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(1);
      expect(syncSeq(parked, "alpha", sourcePeer)).toBe(seq);
      expect(localAgentCount(parked, "alpha")).toBe(1);
      expect(localWorkspaceCount(parked, "alpha")).toBe(1);
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

  it("preserves task, edge, and note content through IMPORT and FAST_FORWARD", () => {
    seedFidelitySource();
    const first = exportSource();

    importDb(localDb, first.file, { apply: true });
    expectDecision(importDb(localDb, first.file).summary, "alpha", "IDENTICAL");
    expectImportedFixtureMatchesSource(localDb);

    addWork(sourceDb, "alpha", "fresh", "Fresh fast-forward task");
    sourceDb
      .prepare(
        `UPDATE tasks
            SET status = 'CLOSED', impact = 100, effort_days = 30,
                created_at = '2026-05-08T00:00:00.000Z',
                updated_at = '2026-05-08T00:01:00.000Z'
          WHERE workstream_id = (SELECT id FROM workstreams WHERE name = 'alpha')
            AND local_id = 'fresh'`,
      )
      .run();
    sourceDb
      .prepare(
        `INSERT INTO task_edges (from_task_id, to_task_id, created_at)
         SELECT f.id, t.id, '2026-05-08T00:02:00.000Z' FROM tasks f, tasks t
          WHERE f.workstream_id = (SELECT id FROM workstreams WHERE name = 'alpha')
            AND t.workstream_id = f.workstream_id
            AND f.local_id = 'deferred' AND t.local_id = 'fresh'`,
      )
      .run();
    sourceDb
      .prepare(
        `INSERT INTO task_notes (task_id, author, content, created_at)
         SELECT id, 'worker-2', 'fast-forward source note', '2026-05-08T00:03:00.000Z'
           FROM tasks
          WHERE workstream_id = (SELECT id FROM workstreams WHERE name = 'alpha')
            AND local_id = 'fresh'`,
      )
      .run();
    log(sourceDb, "alpha", "advance source for fast-forward");
    const next = exportSource();
    expectDecision(importDb(localDb, next.file).summary, "alpha", "FAST_FORWARD");
    importDb(localDb, next.file, { apply: true });
    expectImportedFixtureMatchesSource(localDb);
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

  it("removes destination-local agents and workspaces on FAST_FORWARD and force-source CONFLICT", () => {
    seedIdenticalSyncedAlpha();
    addWork(localDb, "beta", "b", "Unrelated local");
    seedLocalAgentAndWorkspace(localDb, "alpha", "alpha-agent");
    seedLocalAgentAndWorkspace(localDb, "beta", "beta-agent");

    addWork(sourceDb, "alpha", "fast", "Fast-forward source");
    const fastForward = exportSource();
    expectDecision(importDb(localDb, fastForward.file).summary, "alpha", "FAST_FORWARD");
    importDb(localDb, fastForward.file, { apply: true });
    expect(taskTitles(localDb, "alpha")).toEqual(["A", "Fast-forward source"]);
    expect(localAgentCount(localDb, "alpha")).toBe(0);
    expect(localWorkspaceCount(localDb, "alpha")).toBe(0);
    expect(localAgentCount(localDb, "beta")).toBe(1);
    expect(localWorkspaceCount(localDb, "beta")).toBe(1);

    seedLocalAgentAndWorkspace(localDb, "alpha", "alpha-agent-2");
    addWork(localDb, "alpha", "local", "Local loser");
    log(localDb, "alpha", "local advanced for conflict");
    addWork(sourceDb, "alpha", "conflict", "Conflict source");
    const conflict = exportSource();
    expectDecision(importDb(localDb, conflict.file).summary, "alpha", "CONFLICT");
    importDb(localDb, conflict.file, { apply: true, forceSource: true });
    expect(taskTitles(localDb, "alpha")).toEqual(["A", "Conflict source", "Fast-forward source"]);
    expect(localAgentCount(localDb, "alpha")).toBe(0);
    expect(localWorkspaceCount(localDb, "alpha")).toBe(0);
    expect(localAgentCount(localDb, "beta")).toBe(1);
    expect(localWorkspaceCount(localDb, "beta")).toBe(1);
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
