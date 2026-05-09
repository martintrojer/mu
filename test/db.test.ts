// Tests for src/db.ts — verifies the schema, idempotency, pragmas,
// view semantics, and FK cascade behaviour.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, type Db, defaultDbPath, openDb } from "../src/db.js";
import { _runOneMigration } from "../src/migrations.js";

describe("openDb", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-test-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the parent directory and opens the file", () => {
    const nested = join(tempDir, "nested", "deeper", "mu.db");
    const db = openDb({ path: nested });
    db.close();
    // No throw = parent dirs created.
  });

  it("applies the nine expected tables", () => {
    const db = openDb({ path: dbPath });
    const tables = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual([
      "agent_logs",
      "agents",
      "approvals",
      "schema_version",
      "snapshots",
      "task_edges",
      "task_notes",
      "tasks",
      "vcs_workspaces",
      "workstreams",
    ]);
    db.close();
  });

  it("creates the ready/blocked/goals views", () => {
    const db = openDb({ path: dbPath });
    const views = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(views).toEqual(["blocked", "goals", "ready"]);
    db.close();
  });

  it("enables WAL journal mode", () => {
    const db = openDb({ path: dbPath });
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
    db.close();
  });

  it("enables foreign_keys", () => {
    const db = openDb({ path: dbPath });
    const fk = db.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
    db.close();
  });

  it("is idempotent — opening twice does not error and does not duplicate", () => {
    const db1 = openDb({ path: dbPath });
    db1.close();
    const db2 = openDb({ path: dbPath });
    const tables = (
      db2
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual([
      "agent_logs",
      "agents",
      "approvals",
      "schema_version",
      "snapshots",
      "task_edges",
      "task_notes",
      "tasks",
      "vcs_workspaces",
      "workstreams",
    ]);
    db2.close();
  });

  it("preserves data across reopen", () => {
    const db1 = openDb({ path: dbPath });
    insertTask(db1, { id: "spec", title: "Spec", impact: 80, effortDays: 1 });
    db1.close();
    const db2 = openDb({ path: dbPath });
    const rows = db2.prepare("SELECT local_id FROM tasks").all() as { local_id: string }[];
    expect(rows.map((r) => r.local_id)).toEqual(["spec"]);
    db2.close();
  });

  it("ready view returns OPEN tasks with no blockers", () => {
    const db = openDb({ path: dbPath });
    insertTask(db, { id: "a", title: "A", impact: 50, effortDays: 1 });
    const rows = db.prepare("SELECT local_id FROM ready").all() as { local_id: string }[];
    expect(rows.map((r) => r.local_id)).toEqual(["a"]);
    db.close();
  });

  it("blocked view returns OPEN tasks with open blockers; ready excludes them", () => {
    const db = openDb({ path: dbPath });
    insertTask(db, { id: "a", title: "A", impact: 50, effortDays: 1 });
    insertTask(db, { id: "b", title: "B", impact: 50, effortDays: 1 });
    insertEdge(db, "a", "b");
    const ready = (db.prepare("SELECT local_id FROM ready").all() as { local_id: string }[]).map(
      (r) => r.local_id,
    );
    const blocked = (
      db.prepare("SELECT local_id FROM blocked").all() as { local_id: string }[]
    ).map((r) => r.local_id);
    expect(ready).toEqual(["a"]);
    expect(blocked).toEqual(["b"]);
    db.close();
  });

  it("CLOSED blocker unblocks dependent in ready view", () => {
    const db = openDb({ path: dbPath });
    insertTask(db, { id: "a", title: "A", impact: 50, effortDays: 1 });
    insertTask(db, { id: "b", title: "B", impact: 50, effortDays: 1 });
    insertEdge(db, "a", "b");
    db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='a'").run();
    void taskIdByLocalId; // silence "unused" warning when this test path doesn't hit it
    const ready = (
      db.prepare("SELECT local_id FROM ready ORDER BY local_id").all() as {
        local_id: string;
      }[]
    ).map((r) => r.local_id);
    expect(ready).toEqual(["b"]);
    db.close();
  });

  it("goals view returns tasks with no outgoing edges", () => {
    const db = openDb({ path: dbPath });
    insertTask(db, { id: "a", title: "A", impact: 50, effortDays: 1 });
    insertTask(db, { id: "b", title: "B", impact: 50, effortDays: 1 });
    insertTask(db, { id: "c", title: "C", impact: 50, effortDays: 1 });
    insertEdge(db, "a", "b");
    insertEdge(db, "b", "c");
    const goals = (
      db.prepare("SELECT local_id FROM goals ORDER BY local_id").all() as {
        local_id: string;
      }[]
    ).map((r) => r.local_id);
    // c has no outgoing edges (nothing depends on it being a blocker), so it's a goal.
    expect(goals).toEqual(["c"]);
    db.close();
  });

  it("cascade-deletes edges and notes when a task is deleted", () => {
    const db = openDb({ path: dbPath });
    insertTask(db, { id: "a", title: "A", impact: 50, effortDays: 1 });
    insertTask(db, { id: "b", title: "B", impact: 50, effortDays: 1 });
    insertEdge(db, "a", "b");
    insertNote(db, "a", "alice", "starting work");
    insertNote(db, "a", "alice", "finished part 1");

    const aId = taskIdByLocalId(db, "a");
    db.prepare("DELETE FROM tasks WHERE id = ?").run(aId);

    const edges = db.prepare("SELECT * FROM task_edges").all();
    const notes = db.prepare("SELECT * FROM task_notes").all();
    expect(edges).toEqual([]);
    expect(notes).toEqual([]);
    db.close();
  });

  it("rejects impact outside 1..100", () => {
    const db = openDb({ path: dbPath });
    expect(() => insertTask(db, { id: "x", title: "X", impact: 0, effortDays: 1 })).toThrow();
    expect(() => insertTask(db, { id: "y", title: "Y", impact: 101, effortDays: 1 })).toThrow();
    db.close();
  });

  it("rejects effort_days <= 0", () => {
    const db = openDb({ path: dbPath });
    expect(() => insertTask(db, { id: "x", title: "X", impact: 50, effortDays: 0 })).toThrow();
    expect(() => insertTask(db, { id: "y", title: "Y", impact: 50, effortDays: -1 })).toThrow();
    db.close();
  });

  it("rejects unknown task status", () => {
    const db = openDb({ path: dbPath });
    ensureTestWorkstream(db, "test");
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name = ?").get("test") as {
        id: number;
      }
    ).id;
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days, created_at, updated_at)
         VALUES (?, 'x', 'X', 'BOGUS', 50, 1, datetime('now'), datetime('now'))`,
        )
        .run(wsId),
    ).toThrow();
    db.close();
  });

  it("rejects self-referential edges", () => {
    const db = openDb({ path: dbPath });
    insertTask(db, { id: "a", title: "A", impact: 50, effortDays: 1 });
    expect(() => insertEdge(db, "a", "a")).toThrow();
    db.close();
  });

  it("rejects edges to non-existent tasks (FK)", () => {
    const db = openDb({ path: dbPath });
    insertTask(db, { id: "a", title: "A", impact: 50, effortDays: 1 });
    expect(() => insertEdge(db, "a", "ghost")).toThrow();
    db.close();
  });

  it("agent insert and basic CRUD round-trip", () => {
    const db = openDb({ path: dbPath });
    ensureTestWorkstream(db, "auth");
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name = ?").get("auth") as {
        id: number;
      }
    ).id;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agents (name, workstream_id, cli, pane_id, status, role, tab, created_at, updated_at)
       VALUES (@name, @ws, @cli, @pane, @status, @role, @tab, @t, @t)`,
    ).run({
      name: "alice",
      ws: wsId,
      cli: "pi",
      pane: "%15",
      status: "spawning",
      role: "full-access",
      tab: "Backend",
      t: now,
    });
    const row = db
      .prepare(
        `SELECT a.name AS name, ws.name AS workstream, a.cli AS cli, a.pane_id AS pane_id, a.status AS status
           FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.name = 'alice'`,
      )
      .get() as {
      name: string;
      workstream: string;
      cli: string;
      pane_id: string;
      status: string;
    };
    expect(row).toMatchObject({
      name: "alice",
      workstream: "auth",
      cli: "pi",
      pane_id: "%15",
      status: "spawning",
    });
    db.close();
  });
});

describe("defaultDbPath", () => {
  // Helper: env var removal must use `delete` because assigning `undefined`
  // coerces to the literal string "undefined" in process.env.
  function withEnv(key: string, value: string | undefined, fn: () => void): void {
    const original = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    try {
      fn();
    } finally {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }

  it("respects MU_DB_PATH env var", () => {
    withEnv("MU_DB_PATH", "/tmp/some-mu.db", () => {
      expect(defaultDbPath()).toBe("/tmp/some-mu.db");
    });
  });

  it("falls back to XDG state path (~/.local/state/mu/mu.db) when no env var is set", () => {
    withEnv("MU_DB_PATH", undefined, () => {
      withEnv("MU_STATE_DIR", undefined, () => {
        withEnv("XDG_STATE_HOME", undefined, () => {
          const path = defaultDbPath();
          expect(path).toMatch(/\.local\/state\/mu\/mu\.db$/);
        });
      });
    });
  });

  it("honors XDG_STATE_HOME", () => {
    withEnv("MU_DB_PATH", undefined, () => {
      withEnv("MU_STATE_DIR", undefined, () => {
        withEnv("XDG_STATE_HOME", "/custom/xdg", () => {
          expect(defaultDbPath()).toBe("/custom/xdg/mu/mu.db");
        });
      });
    });
  });

  it("honors MU_STATE_DIR over XDG_STATE_HOME", () => {
    withEnv("MU_DB_PATH", undefined, () => {
      withEnv("MU_STATE_DIR", "/explicit/mu", () => {
        withEnv("XDG_STATE_HOME", "/custom/xdg", () => {
          expect(defaultDbPath()).toBe("/explicit/mu/mu.db");
        });
      });
    });
  });

  it("MU_DB_PATH wins over everything", () => {
    withEnv("MU_DB_PATH", "/from/env.db", () => {
      withEnv("MU_STATE_DIR", "/explicit/mu", () => {
        withEnv("XDG_STATE_HOME", "/custom/xdg", () => {
          expect(defaultDbPath()).toBe("/from/env.db");
        });
      });
    });
  });
});

// ─── Test helpers ───────────────────────────────────────────────────────

interface InsertTaskInput {
  id: string;
  title: string;
  impact: number;
  effortDays: number;
  status?: string;
}

function insertTask(db: Db, input: InsertTaskInput): void {
  // v5: tasks references workstream_id (INTEGER FK) and uses INTEGER
  // PK on tasks.id. Helpers translate the test fixture's operator-facing
  // strings to surrogate ids on the way in.
  ensureTestWorkstream(db, "test");
  const wsId = (
    db.prepare("SELECT id FROM workstreams WHERE name = ?").get("test") as {
      id: number;
    }
  ).id;
  db.prepare(
    `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days, created_at, updated_at)
     VALUES (?, @id, @title, @status, @impact, @effort_days, datetime('now'), datetime('now'))`,
  ).run(wsId, {
    id: input.id,
    title: input.title,
    status: input.status ?? "OPEN",
    impact: input.impact,
    effort_days: input.effortDays,
  });
}

function ensureTestWorkstream(db: Db, name: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO workstreams (name, created_at) VALUES (?, datetime('now'))",
  ).run(name);
}

function taskIdByLocalId(db: Db, localId: string): number {
  const row = db.prepare("SELECT id FROM tasks WHERE local_id = ? LIMIT 1").get(localId) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`taskIdByLocalId: not found: ${localId}`);
  return row.id;
}

function insertEdge(db: Db, from: string, to: string): void {
  // v5: task_edges holds INTEGER FKs (from_task_id, to_task_id).
  // Translate the test fixture's operator-facing local_ids.
  // For the FK-violation test (insertEdge(a, ghost)), the lookup will
  // throw "not found"; tests catch it via .toThrow().
  let toId: number;
  try {
    toId = taskIdByLocalId(db, to);
  } catch {
    // Match the v4 'FOREIGN KEY constraint failed' contract by inserting
    // a deliberately invalid id so SQLite raises the FK error.
    db.prepare(
      `INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, datetime('now'))`,
    ).run(taskIdByLocalId(db, from), -999999);
    return;
  }
  const fromId = from === to ? toId : taskIdByLocalId(db, from);
  db.prepare(
    `INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, datetime('now'))`,
  ).run(fromId, toId);
}

function insertNote(db: Db, taskLocalId: string, author: string, content: string): void {
  const taskId = taskIdByLocalId(db, taskLocalId);
  db.prepare(
    `INSERT INTO task_notes (task_id, author, content, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(taskId, author, content);
}

// ─── Schema migrations ──────────────────────────────────────────

// v5 dropped the in-process forward-only migration ladder; pre-v5 DBs
// are now rejected at openDb time with SchemaTooOldError, and the
// scripts/migrate-v4-to-v5.ts integration test covers the loud-fail
// + round-trip. The v1→v2 / v2→v3 / v3→v4 in-process migrators are
// still on disk for archaeology (kept by schema_v5_drop_migrations_ts
// as the cleanup follow-up) but no longer wired into openDb. Skip the
// suite that exercised them.
describe.skip("schema migrations: v1 -> v2 (add ON UPDATE CASCADE)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-mig-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Fabricate a v1-shape DB (no schema_version table; FKs without
   * ON UPDATE CASCADE) so we can verify that openDb migrates it.
   * Mirrors the original 0.1.0 schema before this commit.
   */
  function createV1Db(): void {
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    raw.exec(`
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
        FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE,
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
        FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE,
        FOREIGN KEY (owner)      REFERENCES agents (name)      ON DELETE SET NULL,
        CHECK (impact BETWEEN 1 AND 100),
        CHECK (effort_days > 0),
        CHECK (status IN ('OPEN','IN_PROGRESS','CLOSED'))
      );
      CREATE TABLE task_edges (
        from_task   TEXT NOT NULL,
        to_task     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (from_task, to_task),
        FOREIGN KEY (from_task) REFERENCES tasks (local_id) ON DELETE CASCADE,
        FOREIGN KEY (to_task)   REFERENCES tasks (local_id) ON DELETE CASCADE,
        CHECK (from_task <> to_task)
      );
      CREATE TABLE task_notes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        author     TEXT,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (local_id) ON DELETE CASCADE
      );
      CREATE TABLE agent_logs (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream TEXT,
        source     TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'message',
        payload    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE
      );
      CREATE TABLE vcs_workspaces (
        agent       TEXT PRIMARY KEY REFERENCES agents (name) ON DELETE CASCADE,
        workstream  TEXT NOT NULL REFERENCES workstreams (name) ON DELETE CASCADE,
        backend     TEXT NOT NULL CHECK (backend IN ('jj','sl','git','none')),
        path        TEXT NOT NULL UNIQUE,
        parent_ref  TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE approvals (
        slug         TEXT PRIMARY KEY,
        workstream   TEXT REFERENCES workstreams (name) ON DELETE CASCADE,
        reason       TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','granted','denied','timeout')),
        decided_by   TEXT,
        decided_at   TEXT,
        created_at   TEXT NOT NULL
      );
    `);
    raw.close();
  }

  function fkActions(
    db: Db,
    table: string,
  ): Array<{ from: string; to: string; on_update: string; on_delete: string }> {
    return db
      .prepare(`SELECT "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?)`)
      .all(table) as Array<{ from: string; to: string; on_update: string; on_delete: string }>;
  }

  it("detects a pre-versioning DB and stamps it forward to CURRENT_SCHEMA_VERSION", () => {
    createV1Db();
    const db = openDb({ path: dbPath });
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
      version: number;
    };
    expect(row.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("after migration, every FK has ON UPDATE CASCADE", () => {
    createV1Db();
    const db = openDb({ path: dbPath });
    for (const table of [
      "agents",
      "tasks",
      "task_edges",
      "task_notes",
      "agent_logs",
      "vcs_workspaces",
      "approvals",
    ]) {
      const fks = fkActions(db, table);
      for (const fk of fks) {
        expect(fk.on_update).toBe("CASCADE");
      }
    }
    db.close();
  });

  it("preserves data through the v1 -> v2 rebuild", () => {
    createV1Db();
    // Seed some data into the v1 DB directly.
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    raw.exec(`
      INSERT INTO workstreams (name, created_at) VALUES ('auth', datetime('now'));
      INSERT INTO agents (name, workstream, pane_id, status, created_at, updated_at)
        VALUES ('worker-1', 'auth', '%1', 'busy', datetime('now'), datetime('now'));
      INSERT INTO tasks (local_id, workstream, title, impact, effort_days, owner, created_at, updated_at)
        VALUES ('design', 'auth', 'Design', 80, 2, 'worker-1', datetime('now'), datetime('now'));
      INSERT INTO task_notes (task_id, author, content, created_at)
        VALUES ('design', 'worker-1', 'DECISION: JWT', datetime('now'));
    `);
    raw.close();

    const db = openDb({ path: dbPath });
    const ws = db.prepare("SELECT name FROM workstreams").all();
    const agents = db.prepare("SELECT name, workstream FROM agents").all();
    const tasks = db.prepare("SELECT local_id, owner FROM tasks").all();
    const notes = db.prepare("SELECT content FROM task_notes").all();
    expect(ws).toEqual([{ name: "auth" }]);
    expect(agents).toEqual([{ name: "worker-1", workstream: "auth" }]);
    expect(tasks).toEqual([{ local_id: "design", owner: "worker-1" }]);
    expect(notes).toEqual([{ content: "DECISION: JWT" }]);
    db.close();
  });

  it("ON UPDATE CASCADE actually works after migration: rename workstream -> children follow", () => {
    createV1Db();
    const raw = new Database(dbPath);
    raw.pragma("foreign_keys = ON");
    raw.exec(`
      INSERT INTO workstreams (name, created_at) VALUES ('auth', datetime('now'));
      INSERT INTO tasks (local_id, workstream, title, impact, effort_days, created_at, updated_at)
        VALUES ('design', 'auth', 'D', 80, 2, datetime('now'), datetime('now'));
    `);
    raw.close();

    const db = openDb({ path: dbPath });
    db.prepare("UPDATE workstreams SET name = 'authv2' WHERE name = 'auth'").run();
    const t = db.prepare("SELECT workstream FROM tasks WHERE local_id = 'design'").get() as {
      workstream: string;
    };
    expect(t.workstream).toBe("authv2");
    db.close();
  });

  it("a fresh DB (no pre-existing tables) skips migrations and stamps CURRENT_SCHEMA_VERSION", () => {
    const db = openDb({ path: dbPath });
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
      version: number;
    };
    expect(row.version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});

// ─── Migration framework: rollback safety ───────────────────────

describe.skip("schema migrations: framework integrity (rollback on FK violations)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-mig-fw-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Fabricate a *legacy* DB shape: no FK at all on tasks.owner (older
   * than the v1 schema in src/db.ts that includes the FK). This mimics
   * a real DB that's been around since before the FK was added —
   * which surfaced the rollback bug on first attempt.
   */
  function createLegacyDbWithOrphanOwners(): void {
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    raw.pragma("foreign_keys = ON");
    raw.exec(`
      CREATE TABLE workstreams (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE agents (
        name TEXT PRIMARY KEY,
        workstream TEXT NOT NULL,
        cli TEXT NOT NULL DEFAULT 'pi',
        pane_id TEXT NOT NULL,
        status TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'full-access',
        tab TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- Note: no FK at all on tasks.owner, mimicking pre-FK legacy DB.
      CREATE TABLE tasks (
        local_id TEXT PRIMARY KEY,
        workstream TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        impact INTEGER NOT NULL,
        effort_days REAL NOT NULL,
        owner TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (impact BETWEEN 1 AND 100),
        CHECK (effort_days > 0),
        CHECK (status IN ('OPEN','IN_PROGRESS','CLOSED'))
      );
      CREATE TABLE task_edges (
        from_task TEXT NOT NULL,
        to_task TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_task, to_task),
        CHECK (from_task <> to_task)
      );
      CREATE TABLE task_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        author TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE agent_logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream TEXT,
        source TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'message',
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE vcs_workspaces (
        agent TEXT PRIMARY KEY,
        workstream TEXT NOT NULL,
        backend TEXT NOT NULL CHECK (backend IN ('jj','sl','git','none')),
        path TEXT NOT NULL UNIQUE,
        parent_ref TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE approvals (
        slug TEXT PRIMARY KEY,
        workstream TEXT,
        reason TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','granted','denied','timeout')),
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO workstreams (name, created_at) VALUES ('auth', datetime('now'));
      -- Three tasks, each owned by an external (never-spawned-by-mu) agent.
      INSERT INTO tasks (local_id, workstream, title, impact, effort_days, owner, created_at, updated_at)
        VALUES ('a', 'auth', 'A', 50, 1, 'external-pi', datetime('now'), datetime('now')),
               ('b', 'auth', 'B', 50, 1, 'external-pi', datetime('now'), datetime('now')),
               ('c', 'auth', 'C', 50, 1, NULL,           datetime('now'), datetime('now'));
    `);
    raw.close();
  }

  it("clears orphan tasks.owner during v1 -> v2 migration (cascade-equivalent of ON DELETE SET NULL)", () => {
    createLegacyDbWithOrphanOwners();
    const db = openDb({ path: dbPath });
    const owners = db.prepare("SELECT local_id, owner FROM tasks ORDER BY local_id").all();
    expect(owners).toEqual([
      { local_id: "a", owner: null },
      { local_id: "b", owner: null },
      { local_id: "c", owner: null },
    ]);
    db.close();
  });

  it("logs an agent_logs event recording the orphan-cleanup", () => {
    createLegacyDbWithOrphanOwners();
    const db = openDb({ path: dbPath });
    const logs = db
      .prepare(
        "SELECT workstream, payload FROM agent_logs WHERE kind = 'event' AND payload LIKE 'migration v1->v2%'",
      )
      .all() as Array<{ workstream: string; payload: string }>;
    expect(logs.length).toBe(1);
    expect(logs[0]?.workstream).toBe("auth");
    expect(logs[0]?.payload).toMatch(/cleared owner on 2 task\(s\)/);
    db.close();
  });

  it("rolls back the schema_version bump AND intermediate writes when a migration throws", () => {
    // Open a fresh DB (stamps to CURRENT_SCHEMA_VERSION). Then call
    // _runOneMigration directly with a custom migration that creates
    // a canary table THEN throws. Assert (a) schema_version is
    // unchanged (stayed at CURRENT_SCHEMA_VERSION, didn't bump to
    // CURRENT_SCHEMA_VERSION+1) and (b) the canary table doesn't
    // exist (transaction rolled back).
    //
    // Surfaced by review_test_migration_rollback_stub: the previous
    // test for this contract was a 22-line comment with zero expects,
    // passing as a no-op. Schema migrations are highest-blast-radius
    // (a half-applied migration leaves users unable to open the DB);
    // this test is the actual guard.
    const db = openDb({ path: dbPath });
    const startVersion = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: number;
      }
    ).version;

    expect(() =>
      _runOneMigration(db, startVersion + 1, (tx) => {
        tx.exec("CREATE TABLE _canary (x INTEGER)");
        throw new Error("deliberate test failure post-canary");
      }),
    ).toThrow(/deliberate test failure/);

    // schema_version unchanged
    const after = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: number;
      }
    ).version;
    expect(after).toBe(startVersion);

    // canary table rolled back
    const canary = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_canary'")
      .get();
    expect(canary).toBeUndefined();

    db.close();
  });

  it("handles the no-orphan case cleanly (no agent_logs row emitted)", () => {
    createLegacyDbWithOrphanOwners();
    // Pre-clean the orphans manually so the migration finds nothing.
    const raw = new Database(dbPath);
    raw.exec("UPDATE tasks SET owner = NULL");
    raw.close();

    const db = openDb({ path: dbPath });
    const logs = db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_logs WHERE kind = 'event' AND payload LIKE 'migration v1->v2%'",
      )
      .get() as { n: number };
    expect(logs.n).toBe(0);
    db.close();
  });
});
