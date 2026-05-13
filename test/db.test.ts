// Tests for src/db.ts — verifies the schema, idempotency, pragmas,
// view semantics, and FK cascade behaviour.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, defaultDbPath, openDb } from "../src/db.js";
import { addBlockEdge, addTask } from "../src/tasks.js";
import { TaskNotFoundError } from "../src/tasks/errors.js";

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

  it("applies the expected tables (v7: approvals dropped vs v6)", () => {
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
      "archived_edges",
      "archived_events",
      "archived_notes",
      "archived_tasks",
      "archives",
      "schema_version",
      "snapshots",
      "task_edges",
      "task_notes",
      "tasks",
      "vcs_workspaces",
      "workstreams",
    ]);
    // schema_version stamped to current (v7).
    const v = (
      db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
    expect(v).toBe(7);
    db.close();
  });

  it("v6 → v7 in-place migration drops the approvals table", () => {
    // Simulate a v6 DB by opening, then manually re-creating an
    // approvals table + setting schema_version=6, then re-opening.
    const db1 = openDb({ path: dbPath });
    db1.exec(
      `CREATE TABLE approvals (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id INTEGER NOT NULL,
        slug          TEXT NOT NULL,
        reason        TEXT NOT NULL,
        requested_by  TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        decided_by    TEXT,
        decided_at    TEXT,
        created_at    TEXT NOT NULL,
        UNIQUE (workstream_id, slug)
      )`,
    );
    db1.prepare("UPDATE schema_version SET version = 6 WHERE id = 1").run();
    // Sanity: the table exists at v6.
    const beforeRow = db1
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approvals'")
      .get() as { name: string } | undefined;
    expect(beforeRow?.name).toBe("approvals");
    db1.close();

    // Re-open: v6 → v7 migration runs, dropping approvals + bumping version.
    const db2 = openDb({ path: dbPath });
    const afterRow = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approvals'")
      .get() as { name: string } | undefined;
    expect(afterRow).toBeUndefined();
    const v = (
      db2.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }
    ).version;
    expect(v).toBe(7);
    db2.close();
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
      "archived_edges",
      "archived_events",
      "archived_notes",
      "archived_tasks",
      "archives",
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

  // Two complementary assertions for the "can't point an edge at a
  // non-existent task" contract. The original single test routed both
  // through an `insertEdge` helper that swallowed the SDK's
  // "task not found" lookup error and synthesised a raw INSERT with
  // surrogate id -999999 to coerce SQLite's FK error — so it passed for
  // the wrong reason (a regression that, say, removed the typed
  // TaskNotFoundError throw would have left the synthetic-FK path
  // happily green). Split into:
  //   (a) direct DB-level FK: raw INSERT into task_edges with a bogus
  //       surrogate id MUST raise SQLite's FOREIGN KEY error. Pins the
  //       schema's `REFERENCES tasks (id)` constraint.
  //   (b) SDK-level path: addBlockEdge MUST raise the typed
  //       TaskNotFoundError BEFORE any SQL runs, so callers get exit-3
  //       semantics and an actionable error rather than a generic SQL
  //       failure. Pins the resolver's early-throw behaviour.
  it("FK constraint blocks edges with a bogus tasks.id surrogate", () => {
    const db = openDb({ path: dbPath });
    insertTask(db, { id: "a", title: "A", impact: 50, effortDays: 1 });
    const aId = taskIdByLocalId(db, "a");
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_edges (from_task_id, to_task_id, created_at)
           VALUES (?, ?, datetime('now'))`,
        )
        .run(aId, 999999),
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("addBlockEdge throws TaskNotFoundError for an unknown local_id", () => {
    const db = openDb({ path: dbPath });
    addTask(db, {
      localId: "a",
      workstream: "test",
      title: "A",
      impact: 50,
      effortDays: 1,
    });
    expect(() => addBlockEdge(db, "test", "a", "ghost")).toThrowError(TaskNotFoundError);
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
  // Translate the test fixture's operator-facing local_ids. Both
  // endpoints MUST exist; the "non-existent task" assertion lives in
  // the FK / SDK tests above and exercises the contract directly
  // rather than through this helper.
  const toId = taskIdByLocalId(db, to);
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
