// scripts/migrate.ts — the 0.4.x → 1.0 data escape hatch.
//
// Integration tier: it writes several real DB files per test and runs
// `mu doctor --deep` (a full rebuild) over them.
//
// The script is a SIDECAR run via `npx tsx`, and `tsx` is deliberately
// NOT a dependency of this repo — so this drives `runImporter`, the
// script's exported seam, in-process. Same code path the shebang takes;
// `main()` is only the try/catch + process.exitCode shell around it.
//
// The acceptance run that matters was against a COPY of the user's live
// pre-1.0 DB (857 tasks / 1601 edges / 2295 notes / 7430 log rows); see the
// task note on v2-data-escape-hatch. This file pins the CONTRACT so a
// later refactor cannot quietly break it:
//
//   * read-only on the source (byte-identical after the run),
//   * refuses to write in place / over an existing target,
//   * ops, not rows: `mu doctor --deep` reports NO drift,
//   * every task/edge/note field survives,
//   * duplicate notes merge (grow-only note identity) and are REPORTED,
//   * archives refuse loudly rather than half-importing,
//   * idempotent.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImporter, UsageError } from "../scripts/migrate.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

/** The v8 (final pre-1.0) schema, trimmed to the tables the importer reads
 *  or counts. Inlined because src/db.ts no longer knows v8 exists —
 *  that is the whole point of the clean break. */
const V8_SCHEMA = `
CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
CREATE TABLE machine_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1), machine_id TEXT NOT NULL,
  hostname TEXT, created_at TEXT NOT NULL);
CREATE TABLE workstreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE workstream_sync (
  workstream_id INTEGER PRIMARY KEY REFERENCES workstreams (id) ON DELETE CASCADE,
  last_known_peer_seqs TEXT NOT NULL DEFAULT '{}');
CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  name TEXT NOT NULL, cli TEXT NOT NULL DEFAULT 'pi', pane_id TEXT NOT NULL,
  status TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'full-access', tab TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (workstream_id, name));
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  local_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
  impact INTEGER NOT NULL, effort_days REAL NOT NULL,
  owner_id INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (workstream_id, local_id));
CREATE TABLE task_edges (
  from_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  to_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (from_task_id, to_task_id));
CREATE TABLE task_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE agent_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER REFERENCES workstreams (id) ON DELETE CASCADE,
  source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'message',
  payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE vcs_workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  backend TEXT NOT NULL, path TEXT NOT NULL UNIQUE, parent_ref TEXT, created_at TEXT NOT NULL);
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workstream TEXT, label TEXT NOT NULL,
  db_path TEXT NOT NULL, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT UNIQUE NOT NULL, description TEXT,
  created_at TEXT NOT NULL, last_added_at TEXT NOT NULL);
CREATE TABLE archived_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  source_workstream TEXT NOT NULL, original_local_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, impact INTEGER NOT NULL, effort_days REAL NOT NULL,
  owner_name TEXT, archived_at_status TEXT NOT NULL, archived_at TEXT NOT NULL,
  original_created_at TEXT NOT NULL, original_updated_at TEXT NOT NULL);
`;

const V9_SCHEMA = `
CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
CREATE TABLE machine_identity (id INTEGER PRIMARY KEY CHECK (id = 1), machine_id TEXT NOT NULL, hostname TEXT, created_at TEXT NOT NULL, last_wall INTEGER NOT NULL DEFAULT 0, last_counter INTEGER NOT NULL DEFAULT 0);
CREATE TABLE workstreams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE, name TEXT NOT NULL, cli TEXT NOT NULL, pane_id TEXT NOT NULL, status TEXT NOT NULL, role TEXT NOT NULL, tab TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workstream_id, name));
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE, local_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, impact INTEGER NOT NULL, effort_days REAL NOT NULL, owner_id INTEGER REFERENCES agents(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workstream_id, local_id));
CREATE TABLE task_edges (from_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, to_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY(from_task_id, to_task_id));
CREATE TABLE task_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, author TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, hlc TEXT NOT NULL, machine_id TEXT NOT NULL, group_id TEXT NOT NULL, actor TEXT, intent TEXT, entity TEXT NOT NULL, key TEXT NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(machine_id, hlc));
CREATE TABLE sync_peers (machine_id TEXT PRIMARY KEY, last_applied_seq INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT);
CREATE TABLE vcs_workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE, workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE, backend TEXT NOT NULL, path TEXT NOT NULL UNIQUE, parent_ref TEXT, created_at TEXT NOT NULL);
`;

const T = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

interface Fixture {
  path: string;
  sha: string;
}

/** A small but SHAPE-COMPLETE v8 DB: two workstreams, a blocked-by
 *  edge, notes including a byte-identical duplicate pair, an owned
 *  task, an agent + its workspace + a snapshot row (all of which must
 *  be reported as NOT carried), and log rows. */
function makeV8Db(path: string, opts: { archives?: boolean } = {}): Fixture {
  const db = new Database(path);
  db.exec(V8_SCHEMA);
  db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 8)").run();
  db.prepare(
    "INSERT INTO machine_identity (id, machine_id, hostname, created_at) VALUES (1, 'old-machine', 'box', ?)",
  ).run(T(0));

  db.prepare("INSERT INTO workstreams (id, name, created_at) VALUES (1, 'demo', ?)").run(T(0));
  db.prepare("INSERT INTO workstreams (id, name, created_at) VALUES (2, 'other', ?)").run(T(1));
  db.prepare(
    `INSERT INTO agents (id, workstream_id, name, cli, pane_id, status, created_at, updated_at)
     VALUES (1, 1, 'worker-1', 'pi', '%17', 'free', ?, ?)`,
  ).run(T(2), T(2));
  db.prepare(
    `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, created_at)
     VALUES (1, 1, 'git', '/tmp/ws-worker-1', ?)`,
  ).run(T(2));
  db.prepare(
    `INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at)
     VALUES ('demo', 'pre-refactor', '/tmp/snap.db', 8, ?)`,
  ).run(T(2));

  const task = db.prepare(
    `INSERT INTO tasks (id, workstream_id, local_id, title, status, impact, effort_days,
                        owner_id, created_at, updated_at)
     VALUES (@id, @ws, @localId, @title, @status, @impact, @effort, @owner, @created, @updated)`,
  );
  task.run({
    id: 1,
    ws: 1,
    localId: "alpha",
    title: "Alpha task",
    status: "REJECTED",
    impact: 80,
    effort: 1.5,
    owner: null,
    created: T(3),
    updated: T(20),
  });
  task.run({
    id: 2,
    ws: 1,
    localId: "beta",
    title: "Beta task",
    status: "IN_PROGRESS",
    impact: 45,
    effort: 0.5,
    // Owned: ownership must NOT come across (owner_id FKs into agents).
    owner: 1,
    created: T(4),
    updated: T(21),
  });
  task.run({
    id: 3,
    ws: 2,
    localId: "alpha",
    title: "Same local id, other workstream",
    status: "OPEN",
    impact: 10,
    effort: 3,
    owner: null,
    created: T(5),
    updated: T(5),
  });

  db.prepare("INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (1, 2, ?)").run(
    T(6),
  );

  const note = db.prepare(
    "INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)",
  );
  note.run(1, "worker-1", "first note", T(7));
  note.run(1, null, "anonymous note", T(8));
  // Byte-identical duplicate: v8 allowed it, v9's grow-only note
  // identity (task, author, content) collapses it to one row.
  note.run(2, "worker-1", "dup", T(9));
  note.run(2, "worker-1", "dup", T(10));

  const log = db.prepare(
    "INSERT INTO agent_logs (workstream_id, source, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  log.run(1, "system", "event", "task add alpha (impact=80, effort=1.5)", T(11));
  log.run(null, "system", "event", "workstream teardown gone", T(12));

  if (opts.archives === true) {
    db.prepare(
      "INSERT INTO archives (label, description, created_at, last_added_at) VALUES ('v0-3', null, ?, ?)",
    ).run(T(13), T(13));
  }
  db.close();
  return { path, sha: sha256(path) };
}

function makeV9Db(path: string): Fixture {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(V9_SCHEMA);
  db.prepare("INSERT INTO schema_version VALUES (1, 9)").run();
  db.prepare(
    "INSERT INTO machine_identity VALUES (1, 'v9-machine', 'box', ?, 2000000000000, 7)",
  ).run(T(0));
  db.prepare("INSERT INTO workstreams VALUES (1, 'demo', ?)").run(T(0));
  db.prepare(
    "INSERT INTO agents VALUES (1, 1, 'worker-1', 'pi', '%17', 'free', 'full-access', NULL, ?, ?)",
  ).run(T(1), T(1));
  const task = db.prepare("INSERT INTO tasks VALUES (?, 1, ?, ?, ?, 50, 1, ?, ?, ?)");
  task.run(1, "rejected", "Rejected task", "REJECTED", 1, T(2), T(4));
  task.run(2, "deferred", "Deferred task", "DEFERRED", null, T(3), T(5));
  db.prepare("INSERT INTO task_edges VALUES (1, 2, ?)").run(T(6));
  db.prepare("INSERT INTO task_notes VALUES (1, 1, 'worker-1', 'existing note', ?)").run(T(7));
  db.prepare("INSERT INTO sync_peers VALUES ('peer-machine', 12, ?)").run(T(8));
  db.prepare(
    "INSERT INTO vcs_workspaces VALUES (1, 1, 1, 'git', '/tmp/ws-worker-1', 'main', ?)",
  ).run(T(9));

  const op = db.prepare(
    `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (?, 'v9-machine', ?, 'worker-1', ?, ?, ?, 'put', ?, ?)`,
  );
  const rows = [
    [
      "0001767225600000.000000.v9-machine",
      "g1",
      "workstream.init",
      "workstream",
      "demo",
      JSON.stringify({ name: "demo", created_at: T(0) }),
      T(0),
    ],
    [
      "0001767225660000.000000.v9-machine",
      "g2",
      "task.add",
      "task",
      "demo/rejected",
      JSON.stringify({
        local_id: "rejected",
        title: "Rejected task",
        status: "REJECTED",
        impact: 50,
        effort_days: 1,
        created_at: T(2),
        updated_at: T(4),
      }),
      T(2),
    ],
    [
      "0001767225720000.000000.v9-machine",
      "g3",
      "task.add",
      "task",
      "demo/deferred",
      JSON.stringify({
        local_id: "deferred",
        title: "Deferred task",
        status: "DEFERRED",
        impact: 50,
        effort_days: 1,
        created_at: T(3),
        updated_at: T(5),
      }),
      T(3),
    ],
    [
      "0001767225780000.000000.v9-machine",
      "g4",
      "task.block",
      "edge",
      "demo/rejected->demo/deferred",
      JSON.stringify({ created_at: T(6) }),
      T(6),
    ],
    [
      "0001767225840000.000000.v9-machine",
      "g5",
      "task.note",
      "note",
      "demo/rejected#1",
      JSON.stringify({ author: "worker-1", content: "existing note", created_at: T(7) }),
      T(7),
    ],
    // Real v9 databases can contain historical tombstones while their
    // live projection has since been restored outside the retained op
    // set. Migration must preserve both the history and current rows.
  ] as const;
  for (const row of rows) op.run(...row);
  // Real v9 databases can contain historical tombstones while their
  // live projection has since been restored outside the retained op
  // set. Migration must preserve both the history and current rows.
  db.prepare(
    `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES ('0001767225900000.000000.v9-machine', 'v9-machine', 'g6', 'worker-1',
             'workstream.destroy', 'workstream', 'demo', 'del', '{}', ?)`,
  ).run(T(8));
  db.close();
  return { path, sha: sha256(path) };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface Run {
  stdout: string;
  /** The `UsageError` message, or '' when the run succeeded. Mirrors
   *  what `main()` writes to the real stderr. */
  stderr: string;
  /** 0 on success, 2 on a refusal — same mapping `main()` applies. */
  exitCode: number;
}

function runScript(args: readonly string[]): Run {
  const lines: string[] = [];
  try {
    const code = runImporter(args, (text) => lines.push(text));
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: code };
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    return { stdout: lines.join("\n"), stderr: err.message, exitCode: 2 };
  }
}

describe("scripts/migrate.ts", () => {
  let dir: string;
  let source: Fixture;
  let out: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-migrate-"));
    source = makeV8Db(join(dir, "old.db"));
    out = join(dir, "new.db");
  });

  afterEach(() => {
    rmFixtureDir(dir);
  });

  it("migrates v9 history, legacy statuses, relationships, and valid machine-local rows", async () => {
    const v9 = makeV9Db(join(dir, "v9.db"));
    const target = join(dir, "v10.db");
    const run = runScript([v9.path, "--out", target]);
    expect(run.exitCode).toBe(0);
    expect(sha256(v9.path)).toBe(v9.sha);

    const sourceDb = new Database(v9.path, { readonly: true });
    const sourceOps = sourceDb
      .prepare(
        "SELECT hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at FROM ops ORDER BY seq",
      )
      .all();
    sourceDb.close();

    const db = new Database(target, { readonly: true });
    try {
      expect(db.prepare("SELECT local_id, status, owner_id FROM tasks ORDER BY id").all()).toEqual([
        { local_id: "rejected", status: "OPEN", owner_id: 1 },
        { local_id: "deferred", status: "OPEN", owner_id: null },
      ]);
      expect(
        db
          .prepare(
            `SELECT t.local_id, n.content FROM task_notes n
             JOIN tasks t ON t.id = n.task_id ORDER BY t.local_id, n.content`,
          )
          .all(),
      ).toEqual([
        { local_id: "deferred", content: "MIGRATION: previous status was DEFERRED" },
        { local_id: "rejected", content: "MIGRATION: previous status was REJECTED" },
        { local_id: "rejected", content: "existing note" },
      ]);
      expect((db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n).toBe(1);
      expect(db.prepare("SELECT name, pane_id FROM agents").all()).toEqual([
        { name: "worker-1", pane_id: "%17" },
      ]);
      expect(db.prepare("SELECT path FROM vcs_workspaces").all()).toEqual([
        { path: "/tmp/ws-worker-1" },
      ]);
      expect(
        db
          .prepare("SELECT last_applied_seq FROM sync_peers WHERE machine_id = 'peer-machine'")
          .get(),
      ).toEqual({ last_applied_seq: 12 });
      expect(db.prepare("SELECT machine_id, last_wall FROM machine_identity").get()).toEqual({
        machine_id: "v9-machine",
        last_wall: 2000000000000,
      });
      expect(
        (db.prepare("SELECT last_counter FROM machine_identity").get() as { last_counter: number })
          .last_counter,
      ).toBeGreaterThanOrEqual(7);
      expect(
        db
          .prepare(
            `SELECT hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at
               FROM ops WHERE group_id IN ('g1','g2','g3','g4','g5','g6') ORDER BY seq`,
          )
          .all(),
      ).toEqual(sourceOps);
    } finally {
      db.close();
    }

    const doctor = await runCli(["doctor", "--deep", "--json"], target);
    expect(doctor.exitCode).toBeNull();
    expect((JSON.parse(doctor.stdout) as { drift: { ok: boolean } }).drift.ok).toBe(true);
  });

  it("imports every portable row and leaves the source byte-identical", async () => {
    const run = runScript([source.path, "--out", out]);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);

    // THE read-only contract. Not "we did not mean to write" — proof.
    expect(sha256(source.path)).toBe(source.sha);
    expect(run.stdout).toContain("source unchanged YES");

    const db = new Database(out, { readonly: true });
    try {
      const tasks = db
        .prepare(
          `SELECT w.name || '/' || t.local_id AS key, t.title, t.status, t.impact,
                  t.effort_days AS effort, t.created_at, t.updated_at, t.owner_id
             FROM tasks t JOIN workstreams w ON w.id = t.workstream_id ORDER BY key`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(tasks).toEqual([
        {
          key: "demo/alpha",
          title: "Alpha task",
          status: "OPEN",
          impact: 80,
          effort: 1.5,
          created_at: T(3),
          updated_at: T(20),
          owner_id: null,
        },
        {
          key: "demo/beta",
          title: "Beta task",
          status: "IN_PROGRESS",
          impact: 45,
          effort: 0.5,
          created_at: T(4),
          updated_at: T(21),
          // Ownership does NOT come across: owner_id FKs into the
          // machine-local agents table, which is not imported.
          owner_id: null,
        },
        {
          key: "other/alpha",
          title: "Same local id, other workstream",
          status: "OPEN",
          impact: 10,
          effort: 3,
          created_at: T(5),
          updated_at: T(5),
          owner_id: null,
        },
      ]);

      const edges = db
        .prepare(
          `SELECT wf.name || '/' || f.local_id || '->' || wt.name || '/' || t.local_id AS key,
                  e.created_at
             FROM task_edges e
             JOIN tasks f ON f.id = e.from_task_id
             JOIN tasks t ON t.id = e.to_task_id
             JOIN workstreams wf ON wf.id = f.workstream_id
             JOIN workstreams wt ON wt.id = t.workstream_id`,
        )
        .all();
      expect(edges).toEqual([{ key: "demo/alpha->demo/beta", created_at: T(6) }]);

      // 4 source notes, 1 duplicate pair collapsed by grow-only identity.
      const notes = db
        .prepare("SELECT author, content, created_at FROM task_notes ORDER BY created_at")
        .all();
      expect(notes).toEqual([
        { author: "worker-1", content: "first note", created_at: T(7) },
        { author: null, content: "anonymous note", created_at: T(8) },
        { author: "worker-1", content: "dup", created_at: T(9) },
        {
          author: "migration",
          content: "MIGRATION: previous status was REJECTED",
          created_at: T(20),
        },
      ]);

      // Machine-local tables stay EMPTY. Resurrecting them would produce
      // rows that lie about reality (pane_id / absolute paths).
      for (const table of ["agents", "vcs_workspaces"]) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
      }
    } finally {
      db.close();
    }
  });

  it("synthesizes OPS, not rows — one group, honest intents, source-ordered HLCs", async () => {
    runScript([source.path, "--out", out]);
    const db = new Database(out, { readonly: true });
    try {
      const groups = db
        .prepare("SELECT DISTINCT group_id AS g FROM ops WHERE intent LIKE 'migrate.v8%'")
        .all();
      expect(groups).toHaveLength(1);

      const intents = db
        .prepare("SELECT intent, COUNT(*) AS n FROM ops GROUP BY intent ORDER BY intent")
        .all();
      // Synthetic imports never pretend to be live edits.
      expect(intents).toEqual([
        { intent: "migrate.status", n: 1 },
        // 2 ws + 3 tasks + 1 edge + 4 notes
        { intent: "migrate.v8", n: 10 },
        { intent: "migrate.v8-log", n: 2 },
      ]);

      // Log ops use the log-only 'event' entity, so they never ship to a
      // peer (not in SYNCED_ENTITIES) and are never projected.
      expect(
        db.prepare("SELECT DISTINCT entity AS e FROM ops WHERE intent = 'migrate.v8-log'").all(),
      ).toEqual([{ e: "event" }]);

      // HLC order === source causality: the workstream op precedes its
      // tasks, which precede the edge and notes that reference them.
      const order = (
        db.prepare("SELECT entity, key FROM ops ORDER BY hlc").all() as Array<{
          entity: string;
          key: string;
        }>
      ).map((r) => `${r.entity}:${r.key}`);
      expect(order.indexOf("workstream:demo")).toBeLessThan(order.indexOf("task:demo/alpha"));
      expect(order.indexOf("task:demo/alpha")).toBeLessThan(
        order.indexOf("edge:demo/alpha->demo/beta"),
      );
      expect(order.indexOf("task:demo/alpha")).toBeLessThan(order.indexOf("note:demo/alpha#1"));

      // The HLC wall time is minted FROM the source timestamp, so the
      // log reads like the history actually happened.
      const first = db
        .prepare("SELECT hlc FROM ops WHERE entity = 'workstream' AND key = 'demo'")
        .get() as { hlc: string };
      expect(Number(first.hlc.slice(0, 15))).toBe(Date.parse(T(0)));
    } finally {
      db.close();
    }
  });

  it("produces a DB with NO drift — the ops-not-rows proof", async () => {
    runScript([source.path, "--out", out]);
    const { stdout, exitCode } = await runCli(["doctor", "--deep", "--json"], out);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout) as {
      drift?: {
        mode: string;
        ok: boolean;
        totalDrift: number;
        rowsCompared: Record<string, number>;
      };
    };
    expect(parsed.drift?.mode).toBe("deep");
    expect(parsed.drift?.ok).toBe(true);
    expect(parsed.drift?.totalDrift).toBe(0);
    // A clean report on an empty DB proves nothing; assert it compared
    // the rows the import claimed to write.
    expect(parsed.drift?.rowsCompared).toEqual({
      workstreams: 2,
      tasks: 3,
      task_notes: 4,
      task_edges: 1,
    });
  });

  it("rebuilds from its own log to the same state", async () => {
    runScript([source.path, "--out", out]);
    const rebuilt = join(dir, "rebuilt.db");
    const r = await runCli(["rebuild", rebuilt], out);
    expect(r.exitCode).toBeNull();

    const sql = `SELECT w.name || '/' || t.local_id AS k, t.title, t.status, t.impact,
                        t.effort_days, t.created_at, t.updated_at
                   FROM tasks t JOIN workstreams w ON w.id = t.workstream_id ORDER BY k`;
    const read = (path: string): unknown => {
      const db = new Database(path, { readonly: true });
      try {
        return db.prepare(sql).all();
      } finally {
        db.close();
      }
    };
    expect(read(rebuilt)).toEqual(read(out));
  });

  it("is idempotent: two runs produce identical portable content", async () => {
    const a = join(dir, "a.db");
    const b = join(dir, "b.db");
    const runA = runScript([source.path, "--out", a]);
    const runB = runScript([source.path, "--out", b]);
    // Same summary table modulo the target path and timing.
    const scrub = (s: string): string =>
      s
        .replace(/\/[^\s]*\/(a|b)\.db/g, "<target>")
        .replace(/elapsed\s+\d+ms/, "elapsed")
        .replace(/machine id\s+\S+/, "machine id");
    expect(scrub(runA.stdout)).toBe(scrub(runB.stdout));

    const content = (path: string): string => {
      const db = new Database(path, { readonly: true });
      try {
        return JSON.stringify([
          db.prepare("SELECT name, created_at FROM workstreams ORDER BY 1").all(),
          db.prepare("SELECT local_id, title, status FROM tasks ORDER BY 1, 2").all(),
          db.prepare("SELECT author, content FROM task_notes ORDER BY 1, 2").all(),
          db.prepare("SELECT entity, key, op, payload, intent FROM ops ORDER BY 1, 2, 4").all(),
        ]);
      } finally {
        db.close();
      }
    };
    expect(content(a)).toBe(content(b));
  });

  it("names everything that did NOT come across, with counts", async () => {
    const { stdout } = runScript([source.path, "--out", out]);
    expect(stdout).toContain("NOT CARRIED ACROSS");
    // Each line carries the count, so "0 rows lost" and "100 rows lost"
    // are distinguishable at a glance.
    expect(stdout).toMatch(/agents\s+1\s/);
    expect(stdout).toMatch(/vcs_workspaces\s+1\s/);
    expect(stdout).toMatch(/snapshots\s+1\s/);
    expect(stdout).toMatch(/task owners\s+1\s/);
    expect(stdout).toContain("duplicate(s) merged");
  });

  it("--drop-logs skips agent_logs and says so", async () => {
    const { stdout } = runScript([source.path, "--out", out, "--drop-logs"]);
    expect(stdout).toContain("DROPPED (--drop-logs)");
    const db = new Database(out, { readonly: true });
    try {
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM ops WHERE intent = 'migrate.v8-log'").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses pre-1.0 archives loudly rather than producing a half-archive", async () => {
    const archived = makeV8Db(join(dir, "arch.db"), { archives: true });
    const target = join(dir, "arch-out.db");
    const run = runScript([archived.path, "--out", target]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("REFUSING");
    expect(run.stderr).toContain("v0-3");
    expect(run.stderr).toContain("--drop-archives");
    // Nothing written: a refusal must not leave a partial DB behind.
    expect(existsSync(target)).toBe(false);

    const forced = runScript([archived.path, "--out", target, "--drop-archives"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toMatch(/archives\s+1\s+DROPPED \(--drop-archives\)/);
  });

  it("refuses to write in place, over an existing target, or from an unsupported source", async () => {
    const inPlace = runScript([source.path, "--out", source.path]);
    expect(inPlace.exitCode).toBe(2);
    expect(inPlace.stderr).toContain("same path");
    expect(sha256(source.path)).toBe(source.sha);

    runScript([source.path, "--out", out]);
    const clobber = runScript([source.path, "--out", out]);
    expect(clobber.exitCode).toBe(2);
    expect(clobber.stderr).toContain("--force");
    // --force is the explicit opt-in, and it works.
    expect(runScript([source.path, "--out", out, "--force"]).exitCode).toBe(0);

    const unsupported = join(dir, "unsupported.db");
    const db = new Database(unsupported);
    db.exec(
      "CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1, 7)",
    );
    db.close();
    const wrongVersion = runScript([unsupported, "--out", join(dir, "nope.db")]);
    expect(wrongVersion.exitCode).toBe(2);
    expect(wrongVersion.stderr).toContain("only understands v8 and v9");
  });
});
