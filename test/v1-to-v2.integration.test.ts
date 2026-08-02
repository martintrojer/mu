// scripts/v1-to-v2.ts — the 1.x → 2.0 data escape hatch.
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
// v1 DB (857 tasks / 1601 edges / 2295 notes / 7430 log rows); see the
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
import { UsageError, runImporter } from "../scripts/v1-to-v2.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

/** The v8 (final 1.x) schema, trimmed to the tables the importer reads
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
    status: "CLOSED",
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
  // Byte-identical duplicate: v1 allowed it, v2's grow-only note
  // identity (task, author, content) collapses it to one row.
  note.run(2, "worker-1", "dup", T(9));
  note.run(2, "worker-1", "dup", T(10));

  const log = db.prepare(
    "INSERT INTO agent_logs (workstream_id, source, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  log.run(1, "system", "event", "task add alpha (impact=80, effort=1.5)", T(11));
  log.run(null, "system", "event", "workstream destroy gone", T(12));

  if (opts.archives === true) {
    db.prepare(
      "INSERT INTO archives (label, description, created_at, last_added_at) VALUES ('v0-3', null, ?, ?)",
    ).run(T(13), T(13));
  }
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

describe("scripts/v1-to-v2.ts (the 1.x → 2.0 escape hatch)", () => {
  let dir: string;
  let source: Fixture;
  let out: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-v1-to-v2-"));
    source = makeV8Db(join(dir, "v1.db"));
    out = join(dir, "v2.db");
  });

  afterEach(() => {
    rmFixtureDir(dir);
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
          status: "CLOSED",
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
      const groups = db.prepare("SELECT DISTINCT group_id AS g FROM ops").all();
      expect(groups).toHaveLength(1);

      const intents = db
        .prepare("SELECT intent, COUNT(*) AS n FROM ops GROUP BY intent ORDER BY intent")
        .all();
      // Only the two import intents: nothing pretends to be a live edit.
      expect(intents).toEqual([
        // 2 ws + 3 tasks + 1 edge + 4 notes
        { intent: "migrate.v1", n: 10 },
        { intent: "migrate.v1-log", n: 2 },
      ]);

      // Log ops use the log-only 'event' entity, so they never ship to a
      // peer (not in SYNCED_ENTITIES) and are never projected.
      expect(
        db.prepare("SELECT DISTINCT entity AS e FROM ops WHERE intent = 'migrate.v1-log'").all(),
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
      task_notes: 3,
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
          db.prepare("SELECT COUNT(*) AS n FROM ops WHERE intent = 'migrate.v1-log'").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("refuses v1 archives loudly rather than producing a half-archive", async () => {
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

  it("refuses to write in place, over an existing target, or from a non-v8 source", async () => {
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

    // A v9 DB is not a v1 DB; importing one would double every row.
    const v9 = join(dir, "already-v2.db");
    await runCli(["workstream", "init", "demo"], v9);
    const wrongVersion = runScript([v9, "--out", join(dir, "nope.db")]);
    expect(wrongVersion.exitCode).toBe(2);
    expect(wrongVersion.stderr).toContain("only understands v8");
  });
});
