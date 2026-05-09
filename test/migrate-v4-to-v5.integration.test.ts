// test/migrate-v4-to-v5.integration.test.ts
//
// Integration test for scripts/migrate-v4-to-v5.ts. Runs the script's
// `migrate()` function in-process against a hand-crafted v4 fixture
// DB. Per docs/SCHEMA_v5_DESIGN.md "Migration test plan".
//
// This test is INTENTIONALLY standalone: it constructs the v4 schema
// inline (the v4 CURRENT_SCHEMA was deleted in this same commit), so
// it doesn't rely on the live src/db.ts shape or on any pre-v5 SDK
// helper. Should pass in isolation even while the rest of the test
// suite is RED waiting on schema_v5_sdk_signatures.

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../scripts/migrate-v4-to-v5.js";
import { SchemaTooOldError, openDb } from "../src/db.js";

type Db = DatabaseType;

// ─── v4 schema (inlined; do NOT import from src/db.ts \u2014 v4 is gone) ─

const V4_SCHEMA = `
CREATE TABLE schema_version (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

CREATE TABLE workstreams (
  name        TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

CREATE TABLE agents (
  name        TEXT PRIMARY KEY,
  workstream  TEXT NOT NULL,
  cli         TEXT NOT NULL DEFAULT 'pi',
  pane_id     TEXT NOT NULL,
  status      TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'full-access',
  tab         TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (status IN ('spawning','busy','needs_input','needs_permission','free','unreachable','terminated')),
  CHECK (role IN ('full-access','read-only'))
);

CREATE TABLE tasks (
  local_id    TEXT PRIMARY KEY,
  workstream  TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN',
  impact      INTEGER NOT NULL,
  effort_days REAL NOT NULL,
  owner       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (owner)      REFERENCES agents (name)      ON DELETE SET NULL ON UPDATE CASCADE,
  CHECK (impact BETWEEN 1 AND 100),
  CHECK (effort_days > 0),
  CHECK (status IN ('OPEN','IN_PROGRESS','CLOSED','REJECTED','DEFERRED'))
);

CREATE TABLE task_edges (
  from_task   TEXT NOT NULL,
  to_task     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (from_task, to_task),
  FOREIGN KEY (from_task) REFERENCES tasks (local_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (to_task)   REFERENCES tasks (local_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (from_task <> to_task)
);

CREATE TABLE task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks (local_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE agent_logs (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream TEXT,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'message',
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE vcs_workspaces (
  agent       TEXT PRIMARY KEY REFERENCES agents (name) ON DELETE CASCADE ON UPDATE CASCADE,
  workstream  TEXT NOT NULL REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE,
  backend     TEXT NOT NULL CHECK (backend IN ('jj','sl','git','none')),
  path        TEXT NOT NULL UNIQUE,
  parent_ref  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE approvals (
  slug         TEXT PRIMARY KEY,
  workstream   TEXT REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE,
  reason       TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','granted','denied','timeout')),
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream      TEXT,
  label           TEXT NOT NULL,
  db_path         TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);
`;

function seedV4(path: string): { counts: Record<string, number> } {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(V4_SCHEMA);
  db.prepare("INSERT INTO schema_version (id, version) VALUES (1, 4)").run();

  const now = "2026-05-09T10:00:00.000Z";

  // 2 workstreams
  db.prepare("INSERT INTO workstreams (name, created_at) VALUES (?, ?)").run("wsA", now);
  db.prepare("INSERT INTO workstreams (name, created_at) VALUES (?, ?)").run("wsB", now);

  // 3 agents (2 in wsA, 1 in wsB)
  const insA = db.prepare(
    "INSERT INTO agents (name, workstream, cli, pane_id, status, role, tab, created_at, updated_at) VALUES (?, ?, 'pi', ?, ?, 'full-access', NULL, ?, ?)",
  );
  insA.run("alice", "wsA", "%1", "free", now, now);
  insA.run("bob", "wsA", "%2", "busy", now, now);
  insA.run("carol", "wsB", "%3", "free", now, now);

  // 4 tasks across both workstreams; bob owns one to exercise SET NULL.
  const insT = db.prepare(
    "INSERT INTO tasks (local_id, workstream, title, status, impact, effort_days, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insT.run("design", "wsA", "Design v5", "CLOSED", 80, 1, null, now, now);
  insT.run("ship", "wsA", "Ship v5", "OPEN", 90, 2, "bob", now, now);
  insT.run("review", "wsA", "Review", "OPEN", 50, 1, null, now, now);
  insT.run("setup", "wsB", "Set up wsB", "OPEN", 30, 0.5, null, now, now);

  // task_edges: design -> ship, design -> review (small DAG)
  const insE = db.prepare(
    "INSERT INTO task_edges (from_task, to_task, created_at) VALUES (?, ?, ?)",
  );
  insE.run("design", "ship", now);
  insE.run("design", "review", now);

  // task_notes
  const insN = db.prepare(
    "INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)",
  );
  insN.run("design", "alice", "kicked off", now);
  insN.run("ship", "bob", "in progress", now);
  insN.run("ship", "system", "claimed by bob", now);

  // agent_logs
  const insL = db.prepare(
    "INSERT INTO agent_logs (workstream, source, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insL.run("wsA", "system", "event", "task design CLOSED", now);
  insL.run("wsA", "alice", "message", "design done", now);
  insL.run("wsA", "system", "event", "task ship CLAIMED by bob", now);
  insL.run("wsB", "carol", "message", "starting wsB", now);
  insL.run(null, "system", "event", "machine-wide event", now);

  // vcs_workspaces
  const insW = db.prepare(
    "INSERT INTO vcs_workspaces (agent, workstream, backend, path, parent_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insW.run("alice", "wsA", "jj", "/tmp/ws/alice", "abc123", now);
  insW.run("carol", "wsB", "git", "/tmp/ws/carol", "def456", now);

  // approvals
  const insAp = db.prepare(
    "INSERT INTO approvals (slug, workstream, reason, requested_by, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insAp.run("destroy-wsA", "wsA", "destructive cleanup", "alice", "pending", null, null, now);
  insAp.run("merge-x", "wsB", "merge", "carol", "granted", "user", now, now);

  // snapshots (no FK; freeform workstream column)
  db.prepare(
    "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("wsA", "pre-destroy snapshot", "/tmp/snaps/1.db", 4, now);

  const counts: Record<string, number> = {};
  for (const t of [
    "workstreams",
    "agents",
    "tasks",
    "task_edges",
    "task_notes",
    "agent_logs",
    "vcs_workspaces",
    "approvals",
    "snapshots",
  ]) {
    counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  db.close();
  return { counts };
}

describe("scripts/migrate-v4-to-v5", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-mig-v5-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips every entity table with matching row counts", () => {
    const { counts: v4Counts } = seedV4(dbPath);
    const { backupPath, rowCounts } = migrate(dbPath);

    // Backup file replaces the original; the migrated DB is at dbPath.
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).size).toBeGreaterThan(0);

    for (const t of Object.keys(v4Counts)) {
      expect(rowCounts[t]).toBe(v4Counts[t]);
    }

    // Re-open as v5 and confirm shape directly.
    const db = new Database(dbPath, { readonly: true }) as Db;
    const ver = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
    expect(ver).toBe(5);

    // Surrogate ids exist on every entity table.
    for (const t of [
      "workstreams",
      "agents",
      "tasks",
      "task_notes",
      "vcs_workspaces",
      "approvals",
    ]) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("id");
    }

    // tasks.workstream_id is INTEGER, owner_id is INTEGER, local_id is TEXT.
    const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{
      name: string;
      type: string;
    }>;
    const taskCol = (n: string) => taskCols.find((c) => c.name === n);
    expect(taskCol("workstream_id")?.type).toBe("INTEGER");
    expect(taskCol("owner_id")?.type).toBe("INTEGER");
    expect(taskCol("local_id")?.type).toBe("TEXT");
    db.close();
  });

  it("preserves owner FK as SET NULL on agent delete", () => {
    seedV4(dbPath);
    migrate(dbPath);
    const db = new Database(dbPath) as Db;
    db.pragma("foreign_keys = ON");

    // bob owns 'ship' in wsA. Delete bob; ship.owner_id must drop to NULL.
    const wsAId = (
      db.prepare("SELECT id FROM workstreams WHERE name = 'wsA'").get() as { id: number }
    ).id;
    const bobId = (
      db.prepare("SELECT id FROM agents WHERE name = 'bob' AND workstream_id = ?").get(wsAId) as {
        id: number;
      }
    ).id;
    const shipBefore = db
      .prepare("SELECT owner_id FROM tasks WHERE local_id = 'ship' AND workstream_id = ?")
      .get(wsAId) as { owner_id: number | null };
    expect(shipBefore.owner_id).toBe(bobId);

    db.prepare("DELETE FROM agents WHERE id = ?").run(bobId);

    const shipAfter = db
      .prepare("SELECT owner_id FROM tasks WHERE local_id = 'ship' AND workstream_id = ?")
      .get(wsAId) as { owner_id: number | null };
    expect(shipAfter.owner_id).toBeNull();
    db.close();
  });

  it("cascades on workstream destroy except snapshots", () => {
    seedV4(dbPath);
    migrate(dbPath);
    const db = new Database(dbPath) as Db;
    db.pragma("foreign_keys = ON");

    const wsAId = (
      db.prepare("SELECT id FROM workstreams WHERE name = 'wsA'").get() as { id: number }
    ).id;
    db.prepare("DELETE FROM workstreams WHERE id = ?").run(wsAId);

    // Children gone.
    for (const t of ["agents", "tasks", "vcs_workspaces", "approvals", "agent_logs"]) {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE workstream_id = ?`).get(wsAId) as {
          n: number;
        }
      ).n;
      expect(n).toBe(0);
    }
    // Snapshots row intentionally outlives the workstream.
    const snapsCount = (
      db.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE workstream = 'wsA'").get() as {
        n: number;
      }
    ).n;
    expect(snapsCount).toBe(1);
    db.close();
  });

  it("enforces (workstream_id, name) UNIQUE on agents", () => {
    seedV4(dbPath);
    migrate(dbPath);
    const db = new Database(dbPath) as Db;
    const wsAId = (
      db.prepare("SELECT id FROM workstreams WHERE name = 'wsA'").get() as { id: number }
    ).id;
    expect(() =>
      db
        .prepare(
          "INSERT INTO agents (workstream_id, name, cli, pane_id, status, role, tab, created_at, updated_at) VALUES (?, 'alice', 'pi', '%99', 'free', 'full-access', NULL, '2026-05-09T11:00Z', '2026-05-09T11:00Z')",
        )
        .run(wsAId),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it("allows the same task local_id in two different workstreams", () => {
    seedV4(dbPath);
    migrate(dbPath);
    const db = new Database(dbPath) as Db;
    const wsBId = (
      db.prepare("SELECT id FROM workstreams WHERE name = 'wsB'").get() as { id: number }
    ).id;
    // wsA has local_id='design' already; insert one in wsB with the same local_id.
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days, owner_id, created_at, updated_at) VALUES (?, 'design', 'Design wsB', 'OPEN', 60, 1, NULL, '2026-05-09T11:00Z', '2026-05-09T11:00Z')",
        )
        .run(wsBId),
    ).not.toThrow();
    // ... and a duplicate within wsB IS rejected.
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days, owner_id, created_at, updated_at) VALUES (?, 'design', 'Design wsB 2', 'OPEN', 60, 1, NULL, '2026-05-09T11:00Z', '2026-05-09T11:00Z')",
        )
        .run(wsBId),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it("recreates the ready/blocked/goals views with v5 column names", () => {
    seedV4(dbPath);
    migrate(dbPath);
    const db = new Database(dbPath, { readonly: true }) as Db;

    // View bodies are stored in sqlite_master.
    const viewSqls = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view'")
      .all() as Array<{ name: string; sql: string }>;
    expect(viewSqls.map((v) => v.name).sort()).toEqual(["blocked", "goals", "ready"]);
    for (const v of viewSqls) {
      // No v4 column references anywhere.
      expect(v.sql).not.toMatch(/from_task\b/);
      expect(v.sql).not.toMatch(/to_task\b/);
      expect(v.sql).not.toMatch(/e\.from_task\b/);
    }

    // ready returns OPEN tasks whose blockers are CLOSED:
    //   - 'ship' is blocked by 'design' (CLOSED) → ready
    //   - 'review' is blocked by 'design' (CLOSED) → ready
    //   - 'setup' has no blockers → ready
    const readyIds = (
      db.prepare("SELECT local_id FROM ready ORDER BY local_id").all() as Array<{
        local_id: string;
      }>
    ).map((r) => r.local_id);
    expect(readyIds).toEqual(["review", "setup", "ship"]);

    // blocked is empty (the lone closed blocker means nothing is still blocked).
    const blockedCount = (db.prepare("SELECT COUNT(*) AS n FROM blocked").get() as { n: number }).n;
    expect(blockedCount).toBe(0);
    db.close();
  });

  it("ends with schema_version = 5", () => {
    seedV4(dbPath);
    const { rowCounts } = migrate(dbPath);
    expect(rowCounts.workstreams).toBe(2);
    const db = new Database(dbPath, { readonly: true }) as Db;
    const ver = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
    expect(ver).toBe(5);
    db.close();
  });

  it("openDb refuses a v4 DB with SchemaTooOldError (loud-fail hook)", () => {
    seedV4(dbPath);
    expect(() => openDb({ path: dbPath })).toThrow(SchemaTooOldError);
    try {
      openDb({ path: dbPath });
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaTooOldError);
      const e = err as SchemaTooOldError;
      expect(e.detectedVersion).toBe(4);
      expect(e.requiredVersion).toBe(5);
      expect(e.message).toContain("scripts/migrate-v4-to-v5.ts");
      expect(e.errorNextSteps().length).toBeGreaterThan(0);
    }
  });

  it("after migration, openDb succeeds and reports v5", () => {
    seedV4(dbPath);
    migrate(dbPath);
    const db = openDb({ path: dbPath });
    const ver = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
    expect(ver).toBe(5);
    db.close();
  });
});
