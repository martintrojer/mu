#!/usr/bin/env -S npx tsx
// scripts/migrate-v4-to-v5.ts
//
// One-off migration from v4 (TEXT primary keys, FK cascades on TEXT
// names) to v5 (surrogate INTEGER PKs, INTEGER FKs, per-scope UNIQUE
// on operator-facing TEXT names). See docs/SCHEMA_v5_DESIGN.md.
//
// USAGE:
//   npx tsx scripts/migrate-v4-to-v5.ts                  # uses $MU_DB_PATH
//   npx tsx scripts/migrate-v4-to-v5.ts /path/to/mu.db   # explicit
//
// SAFETY / MANUAL ROLLBACK:
//   The script renames the v4 file to mu.db.v4-backup-<ts> BEFORE
//   swapping in the v5 file. Neither the snapshots table nor `mu undo`
//   sees that backup; it is the migration's escape hatch only. To
//   restore manually:
//
//     mv ~/.local/state/mu/mu.db ~/.local/state/mu/mu.db.v5-broken
//     mv ~/.local/state/mu/mu.db.v4-backup-<ts> ~/.local/state/mu/mu.db
//     # then re-pin mu to the pre-v5 version and continue using v4.
//
// This script imports nothing from the mu SDK on purpose — it has to
// run against a v4 DB, which the v5 SDK refuses to open. Pure
// node:better-sqlite3 + node:fs.

import { existsSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";

type Db = DatabaseType;

// ─── v5 schema (kept in lock-step with src/db.ts CURRENT_SCHEMA) ───
//
// Inlined here so the script has no SDK dependency. If src/db.ts's
// CURRENT_SCHEMA drifts from this block, the migration produces a
// v5-shape that doesn't match the live binary — caught by the
// integration test (test/migrate-v4-to-v5.integration.test.ts).

const V5_SCHEMA = `
CREATE TABLE schema_version (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

CREATE TABLE workstreams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  cli           TEXT NOT NULL DEFAULT 'pi',
  pane_id       TEXT NOT NULL,
  status        TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'full-access',
  tab           TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workstream_id, name),
  CHECK (status IN ('spawning','busy','needs_input','needs_permission','free','unreachable','terminated')),
  CHECK (role IN ('full-access','read-only'))
);
CREATE INDEX idx_agents_workstream ON agents (workstream_id);
CREATE INDEX idx_agents_status     ON agents (status);

CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  local_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN',
  impact        INTEGER NOT NULL,
  effort_days   REAL NOT NULL,
  owner_id      INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workstream_id, local_id),
  CHECK (impact BETWEEN 1 AND 100),
  CHECK (effort_days > 0),
  CHECK (status IN ('OPEN','IN_PROGRESS','CLOSED','REJECTED','DEFERRED'))
);
CREATE INDEX idx_tasks_workstream ON tasks (workstream_id);
CREATE INDEX idx_tasks_status     ON tasks (status);
CREATE INDEX idx_tasks_owner      ON tasks (owner_id);

CREATE TABLE task_edges (
  from_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  to_task_id   INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (from_task_id, to_task_id),
  CHECK (from_task_id <> to_task_id)
);
CREATE INDEX idx_task_edges_to ON task_edges (to_task_id);

CREATE TABLE task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_task_notes_task ON task_notes (task_id);

CREATE TABLE agent_logs (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER REFERENCES workstreams (id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'message',
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_agent_logs_seq    ON agent_logs (seq);
CREATE INDEX idx_agent_logs_ws_seq ON agent_logs (workstream_id, seq);
CREATE INDEX idx_agent_logs_source ON agent_logs (source);

CREATE TABLE vcs_workspaces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  backend       TEXT NOT NULL CHECK (backend IN ('jj','sl','git','none')),
  path          TEXT NOT NULL UNIQUE,
  parent_ref    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_vcs_workspaces_workstream ON vcs_workspaces (workstream_id);

CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  reason        TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','granted','denied','timeout')),
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (workstream_id, slug)
);
CREATE INDEX idx_approvals_status     ON approvals (status);
CREATE INDEX idx_approvals_workstream ON approvals (workstream_id);

CREATE TABLE snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream      TEXT,
  label           TEXT NOT NULL,
  db_path         TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_snapshots_created_at ON snapshots (created_at);
CREATE INDEX idx_snapshots_workstream ON snapshots (workstream);

CREATE VIEW ready AS
  SELECT t.* FROM tasks t
   WHERE t.status = 'OPEN'
     AND NOT EXISTS (
       SELECT 1 FROM task_edges e JOIN tasks b ON e.from_task_id = b.id
        WHERE e.to_task_id = t.id AND b.status <> 'CLOSED'
     );

CREATE VIEW blocked AS
  SELECT t.* FROM tasks t
   WHERE t.status = 'OPEN'
     AND EXISTS (
       SELECT 1 FROM task_edges e JOIN tasks b ON e.from_task_id = b.id
        WHERE e.to_task_id = t.id AND b.status <> 'CLOSED'
     );

CREATE VIEW goals AS
  SELECT t.* FROM tasks t
   WHERE t.status NOT IN ('CLOSED','REJECTED','DEFERRED')
     AND NOT EXISTS (
       SELECT 1 FROM task_edges WHERE from_task_id = t.id
     );
`;

// ─── Path resolution ──────────────────────────────────────────────

function defaultDbPath(): string {
  if (process.env.MU_DB_PATH) return process.env.MU_DB_PATH;
  if (process.env.MU_STATE_DIR) return join(process.env.MU_STATE_DIR, "mu.db");
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "mu", "mu.db");
}

// ─── Migration ────────────────────────────────────────────────────

export function migrate(srcPath: string): {
  backupPath: string;
  rowCounts: Record<string, number>;
} {
  if (!existsSync(srcPath)) {
    throw new Error(`source DB not found: ${srcPath}`);
  }

  const newPath = `${srcPath}.new`;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${srcPath}.v4-backup-${ts}`;

  // Clean up any half-finished prior attempt.
  if (existsSync(newPath)) unlinkSync(newPath);

  const src = new Database(srcPath, { readonly: true });
  src.pragma("foreign_keys = OFF");

  const detectedVersion = (
    src.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
      | { version: number }
      | undefined
  )?.version;
  if (detectedVersion === undefined) {
    throw new Error("source DB has no schema_version row; not a recognised mu DB");
  }
  if (detectedVersion === 5) {
    throw new Error("source DB is already at v5; nothing to do");
  }
  if (detectedVersion < 1 || detectedVersion > 4) {
    throw new Error(`source DB at v${detectedVersion}; this script only handles v1..v4 → v5`);
  }

  const dst = new Database(newPath);
  dst.pragma("journal_mode = WAL");
  dst.pragma("foreign_keys = OFF"); // FK off during bulk insert; verified at end.
  dst.exec(V5_SCHEMA);

  const rowCounts: Record<string, number> = {};

  // The transaction wraps ALL inserts so a failure mid-migration leaves
  // the destination empty (we then unlink it) rather than half-populated.
  const txn = dst.transaction(() => {
    // ── 1. workstreams (no parents) ─────────────────────────────
    const wsMap = new Map<string, number>();
    const wsRows = src.prepare("SELECT name, created_at FROM workstreams").all() as Array<{
      name: string;
      created_at: string;
    }>;
    const insWs = dst.prepare("INSERT INTO workstreams (name, created_at) VALUES (?, ?)");
    for (const r of wsRows) {
      const id = Number(insWs.run(r.name, r.created_at).lastInsertRowid);
      wsMap.set(r.name, id);
    }
    rowCounts.workstreams = wsRows.length;

    // ── 2. agents (parent: workstreams) ─────────────────────────
    const agentMap = new Map<string, number>(); // v4 globally-unique TEXT name → v5 id
    const agentRows = src
      .prepare(
        "SELECT name, workstream, cli, pane_id, status, role, tab, created_at, updated_at FROM agents",
      )
      .all() as Array<{
      name: string;
      workstream: string;
      cli: string;
      pane_id: string;
      status: string;
      role: string;
      tab: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const insAgent = dst.prepare(
      "INSERT INTO agents (workstream_id, name, cli, pane_id, status, role, tab, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of agentRows) {
      const wsId = wsMap.get(r.workstream);
      if (wsId === undefined) {
        throw new Error(`agent ${r.name} references unknown workstream ${r.workstream}`);
      }
      const id = Number(
        insAgent.run(
          wsId,
          r.name,
          r.cli,
          r.pane_id,
          r.status,
          r.role,
          r.tab,
          r.created_at,
          r.updated_at,
        ).lastInsertRowid,
      );
      agentMap.set(r.name, id);
    }
    rowCounts.agents = agentRows.length;

    // ── 3. tasks (parents: workstreams + agents) ────────────────
    const taskMap = new Map<string, number>(); // v4 globally-unique local_id → v5 id
    const taskRows = src
      .prepare(
        "SELECT local_id, workstream, title, status, impact, effort_days, owner, created_at, updated_at FROM tasks",
      )
      .all() as Array<{
      local_id: string;
      workstream: string;
      title: string;
      status: string;
      impact: number;
      effort_days: number;
      owner: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const insTask = dst.prepare(
      "INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of taskRows) {
      const wsId = wsMap.get(r.workstream);
      if (wsId === undefined) {
        throw new Error(`task ${r.local_id} references unknown workstream ${r.workstream}`);
      }
      const ownerId = r.owner !== null ? (agentMap.get(r.owner) ?? null) : null;
      const id = Number(
        insTask.run(
          wsId,
          r.local_id,
          r.title,
          r.status,
          r.impact,
          r.effort_days,
          ownerId,
          r.created_at,
          r.updated_at,
        ).lastInsertRowid,
      );
      taskMap.set(r.local_id, id);
    }
    rowCounts.tasks = taskRows.length;

    // ── 4. task_edges (parent: tasks) ───────────────────────────
    const edgeRows = src
      .prepare("SELECT from_task, to_task, created_at FROM task_edges")
      .all() as Array<{ from_task: string; to_task: string; created_at: string }>;
    const insEdge = dst.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    );
    for (const r of edgeRows) {
      const fromId = taskMap.get(r.from_task);
      const toId = taskMap.get(r.to_task);
      if (fromId === undefined || toId === undefined) {
        throw new Error(`task_edges row references unknown task: ${r.from_task} -> ${r.to_task}`);
      }
      insEdge.run(fromId, toId, r.created_at);
    }
    rowCounts.task_edges = edgeRows.length;

    // ── 5. task_notes (parent: tasks) ───────────────────────────
    const noteRows = src
      .prepare("SELECT task_id, author, content, created_at FROM task_notes ORDER BY id")
      .all() as Array<{
      task_id: string;
      author: string | null;
      content: string;
      created_at: string;
    }>;
    const insNote = dst.prepare(
      "INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const r of noteRows) {
      const tId = taskMap.get(r.task_id);
      if (tId === undefined) {
        throw new Error(`task_notes row references unknown task ${r.task_id}`);
      }
      insNote.run(tId, r.author, r.content, r.created_at);
    }
    rowCounts.task_notes = noteRows.length;

    // ── 6. agent_logs (parent: workstreams; source stays free-text) ──
    const logRows = src
      .prepare("SELECT workstream, source, kind, payload, created_at FROM agent_logs ORDER BY seq")
      .all() as Array<{
      workstream: string | null;
      source: string;
      kind: string;
      payload: string;
      created_at: string;
    }>;
    const insLog = dst.prepare(
      "INSERT INTO agent_logs (workstream_id, source, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const r of logRows) {
      const wsId = r.workstream !== null ? (wsMap.get(r.workstream) ?? null) : null;
      insLog.run(wsId, r.source, r.kind, r.payload, r.created_at);
    }
    rowCounts.agent_logs = logRows.length;

    // ── 7. vcs_workspaces (parents: agents + workstreams) ───────
    const wsxRows = src
      .prepare(
        "SELECT agent, workstream, backend, path, parent_ref, created_at FROM vcs_workspaces",
      )
      .all() as Array<{
      agent: string;
      workstream: string;
      backend: string;
      path: string;
      parent_ref: string | null;
      created_at: string;
    }>;
    const insWsx = dst.prepare(
      "INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const r of wsxRows) {
      const agentId = agentMap.get(r.agent);
      const wsId = wsMap.get(r.workstream);
      if (agentId === undefined) {
        throw new Error(`vcs_workspaces row references unknown agent ${r.agent}`);
      }
      if (wsId === undefined) {
        throw new Error(`vcs_workspaces row references unknown workstream ${r.workstream}`);
      }
      insWsx.run(agentId, wsId, r.backend, r.path, r.parent_ref, r.created_at);
    }
    rowCounts.vcs_workspaces = wsxRows.length;

    // ── 8. approvals (parent: workstreams) ──────────────────────
    const apRows = src
      .prepare(
        "SELECT slug, workstream, reason, requested_by, status, decided_by, decided_at, created_at FROM approvals",
      )
      .all() as Array<{
      slug: string;
      workstream: string | null;
      reason: string;
      requested_by: string;
      status: string;
      decided_by: string | null;
      decided_at: string | null;
      created_at: string;
    }>;
    const insAp = dst.prepare(
      "INSERT INTO approvals (workstream_id, slug, reason, requested_by, status, decided_by, decided_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of apRows) {
      // v5 makes workstream_id NOT NULL; refuse to migrate orphaned approvals.
      if (r.workstream === null || !wsMap.has(r.workstream)) {
        throw new Error(
          `approvals row ${r.slug} has null/unknown workstream (${r.workstream}); v5 requires workstream_id NOT NULL`,
        );
      }
      const wsId = wsMap.get(r.workstream) as number;
      insAp.run(
        wsId,
        r.slug,
        r.reason,
        r.requested_by,
        r.status,
        r.decided_by,
        r.decided_at,
        r.created_at,
      );
    }
    rowCounts.approvals = apRows.length;

    // ── 9. snapshots (no FK; verbatim) ──────────────────────────
    const snapRows = src
      .prepare(
        "SELECT workstream, label, db_path, schema_version, created_at FROM snapshots ORDER BY id",
      )
      .all() as Array<{
      workstream: string | null;
      label: string;
      db_path: string;
      schema_version: number;
      created_at: string;
    }>;
    const insSnap = dst.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const r of snapRows) {
      insSnap.run(r.workstream, r.label, r.db_path, r.schema_version, r.created_at);
    }
    rowCounts.snapshots = snapRows.length;

    // ── 10. schema_version ─ bump to 5 LAST so a crashed migration
    //        leaves an empty/non-versioned dst that we unlink rather
    //        than a half-populated DB labelled v5.
    dst.prepare("INSERT INTO schema_version (id, version) VALUES (1, 5)").run();
  });

  try {
    txn();
  } catch (err) {
    try {
      dst.close();
    } catch {
      // best effort
    }
    if (existsSync(newPath)) unlinkSync(newPath);
    src.close();
    throw err;
  }

  // FK integrity check on the destination.
  dst.pragma("foreign_keys = ON");
  const violations = dst.pragma("foreign_key_check") as Array<unknown>;
  if (violations.length > 0) {
    dst.close();
    if (existsSync(newPath)) unlinkSync(newPath);
    src.close();
    throw new Error(
      `v5 DB has ${violations.length} FK violations after migration; aborted, no files renamed`,
    );
  }

  // Row-count verification: every entity table must match v4 → v5
  // exactly. (Snapshots row count is verified above too.)
  const expectedTables = [
    "workstreams",
    "agents",
    "tasks",
    "task_edges",
    "task_notes",
    "agent_logs",
    "vcs_workspaces",
    "approvals",
    "snapshots",
  ] as const;
  for (const t of expectedTables) {
    const v4Count = (src.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const v5Count = (dst.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    if (v4Count !== v5Count) {
      dst.close();
      if (existsSync(newPath)) unlinkSync(newPath);
      src.close();
      throw new Error(`row count mismatch on ${t}: v4 had ${v4Count}, v5 has ${v5Count}; aborted`);
    }
  }

  dst.exec("VACUUM");
  dst.close();
  src.close();

  // Atomic-ish swap: rename v4 → backup, then v5 → live. If a crash
  // happens between the two renames, the operator has both files on
  // disk and can recover by hand.
  renameSync(srcPath, backupPath);
  renameSync(newPath, srcPath);

  return { backupPath, rowCounts };
}

// ─── CLI entry point ──────────────────────────────────────────────

function isMain(): boolean {
  // tsx executes the file directly; argv[1] is the script path.
  // Skip when imported (test file imports `migrate`).
  const argv1 = process.argv[1] ?? "";
  return argv1.endsWith("migrate-v4-to-v5.ts");
}

if (isMain()) {
  const srcPath = process.argv[2] ?? defaultDbPath();
  console.log(`migrating ${srcPath} → v5 …`);
  try {
    const { backupPath, rowCounts } = migrate(srcPath);
    console.log("done.");
    console.log(`v4 backup: ${backupPath}`);
    console.log(`row counts: ${JSON.stringify(rowCounts)}`);
    console.log(`to roll back: mv ${srcPath} ${srcPath}.v5-broken && mv ${backupPath} ${srcPath}`);
  } catch (err) {
    console.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
