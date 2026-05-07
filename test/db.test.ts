// Tests for src/db.ts — verifies the schema, idempotency, pragmas,
// view semantics, and FK cascade behaviour.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, defaultDbPath, openDb } from "../src/db.js";

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

  it("applies the eight expected tables", () => {
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

    db.prepare("DELETE FROM tasks WHERE local_id='a'").run();

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
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (local_id, workstream, title, status, impact, effort_days, created_at, updated_at)
         VALUES ('x', 'test', 'X', 'BOGUS', 50, 1, datetime('now'), datetime('now'))`,
        )
        .run(),
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
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agents (name, workstream, cli, pane_id, status, role, tab, created_at, updated_at)
       VALUES (@name, @ws, @cli, @pane, @status, @role, @tab, @t, @t)`,
    ).run({
      name: "alice",
      ws: "auth",
      cli: "pi",
      pane: "%15",
      status: "spawning",
      role: "full-access",
      tab: "Backend",
      t: now,
    });
    const row = db.prepare("SELECT * FROM agents WHERE name='alice'").get() as {
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
  // Workstreams table is FK-referenced by tasks; ensure the row exists
  // before the task INSERT (mirrors what addTask does via
  // ensureWorkstream).
  ensureTestWorkstream(db, "test");
  db.prepare(
    `INSERT INTO tasks (local_id, workstream, title, status, impact, effort_days, created_at, updated_at)
     VALUES (@id, 'test', @title, @status, @impact, @effort_days, datetime('now'), datetime('now'))`,
  ).run({
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

function insertEdge(db: Db, from: string, to: string): void {
  db.prepare(
    `INSERT INTO task_edges (from_task, to_task, created_at) VALUES (?, ?, datetime('now'))`,
  ).run(from, to);
}

function insertNote(db: Db, taskId: string, author: string, content: string): void {
  db.prepare(
    `INSERT INTO task_notes (task_id, author, content, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(taskId, author, content);
}
