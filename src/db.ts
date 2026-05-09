// mu — DB module.
//
// Opens ~/.mu/mu.db (or MU_DB_PATH override), enables WAL + foreign keys,
// applies the schema idempotently, runs any pending migrations, and
// exposes the live Database handle.
//
// Schema (see CHANGELOG.md §"Schema"):
//   - 8 tables: workstreams, agents, tasks, task_edges, task_notes,
//               agent_logs, vcs_workspaces, approvals
//   - 1 meta table: schema_version (single row, integer)
//   - 3 views:  ready, blocked, goals
//
// Migrations are versioned via the schema_version table. CURRENT_SCHEMA
// below is the shape a fresh DB starts with (today: version 2). Existing
// DBs at older versions get migrated up via the runMigrations() helper
// on every openDb() call. Migrations are forward-only; downgrades are
// not supported.
//
// Adding a new migration:
//   1. Bump CURRENT_SCHEMA_VERSION.
//   2. Update the CURRENT_SCHEMA block so fresh DBs match.
//   3. Add a (fromVersion -> toVersion) entry to MIGRATIONS that
//      transforms an existing DB from the previous shape into the new one.
//   4. Cover both the fresh-create AND the migrate-existing paths
//      in test/db.test.ts.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export type Db = DatabaseType;

export interface OpenDbOptions {
  /**
   * Absolute path to the SQLite file. Defaults to MU_DB_PATH env var or
   * the XDG state path (see `defaultDbPath`). Use a per-test temp path
   * in tests.
   */
  path?: string;

  /**
   * If true, opens the DB read-only. Used by `mu sql` and similar read-only
   * surfaces to enforce no-mutation guarantees at the connection level.
   */
  readonly?: boolean;
}

/**
 * Resolve the canonical mu state directory:
 *   MU_STATE_DIR > $XDG_STATE_HOME/mu > ~/.local/state/mu
 */
export function defaultStateDir(): string {
  if (process.env.MU_STATE_DIR) return process.env.MU_STATE_DIR;
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(stateHome, "mu");
}

/**
 * Resolve the canonical DB path:
 *   MU_DB_PATH > <state-dir>/mu.db
 */
export function defaultDbPath(): string {
  if (process.env.MU_DB_PATH) return process.env.MU_DB_PATH;
  return join(defaultStateDir(), "mu.db");
}

/**
 * Per-workstream artifact directory: <state-dir>/workstreams/<workstream>/
 *
 * Created lazily by callers. 0.1.0 doesn't write to it yet — reserved
 * for future snapshots / tracing logs / forensic pane captures. The DB
 * stays canonical and shared; this directory is only for things that
 * naturally don't need cross-workstream queries.
 */
export function workstreamStateDir(workstream: string): string {
  return join(defaultStateDir(), "workstreams", workstream);
}

/**
 * Open the mu database. Creates the parent directory and applies the schema
 * idempotently on every open. Safe to call from many short-lived processes
 * concurrently — WAL mode handles cross-process writes.
 */
export function openDb(options: OpenDbOptions = {}): Db {
  const path = options.path ?? defaultDbPath();
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { readonly: options.readonly ?? false });

  if (!options.readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Detect 'pre-existing v1 DB' (had tables but no schema_version row)
    // BEFORE applySchema, so we can run the v1 -> v2 migration on the
    // real data instead of stamping it as v2 by accident.
    const detectedVersion = detectExistingSchemaVersion(db);
    applySchema(db);
    if (detectedVersion !== null && detectedVersion < CURRENT_SCHEMA_VERSION) {
      // Existing DB at an older version: reset the version row so
      // runMigrations sees the real starting point (applySchema's
      // INSERT OR IGNORE may have stamped it as CURRENT for fresh DBs).
      db.prepare("UPDATE schema_version SET version = ? WHERE id = 1").run(detectedVersion);
    }
    runMigrations(db);
  } else {
    db.pragma("foreign_keys = ON");
  }

  return db;
}

/**
 * Sniff an existing DB's schema version BEFORE applySchema runs, so we
 * can distinguish:
 *   - Brand-new DB: no tables at all -> returns null (fresh, will be
 *     stamped to CURRENT_SCHEMA_VERSION by applySchema).
 *   - Pre-versioning DB (had v1 tables before schema_version existed):
 *     workstreams exists, schema_version doesn't -> returns 1.
 *   - Already-versioned DB: schema_version row present -> returns its
 *     value.
 */
function detectExistingSchemaVersion(db: Db): number | null {
  const hasVersionTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { name: string } | undefined;
  if (hasVersionTable) {
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
      | { version: number }
      | undefined;
    return row?.version ?? null;
  }
  // No schema_version table. Check whether any of the original v1
  // tables exist; if so this is a pre-versioning v1 DB.
  const hasWorkstreams = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workstreams'")
    .get() as { name: string } | undefined;
  if (hasWorkstreams) return 1;
  return null;
}

/** Test seam: ensure a workstream's artifact dir exists. Unused today. */
export function ensureWorkstreamStateDir(workstream: string): string {
  const path = workstreamStateDir(workstream);
  mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Apply the schema. Idempotent: tables use CREATE TABLE IF NOT EXISTS;
 * views are dropped and recreated so the latest definition always wins.
 *
 * For fresh DBs this writes the current schema shape and stamps
 * schema_version = CURRENT_SCHEMA_VERSION. For existing DBs this is a
 * no-op for the table CREATEs (IF NOT EXISTS) but DOES recreate the
 * views. Migrations against older shapes are handled by runMigrations.
 */
function applySchema(db: Db): void {
  db.exec(CURRENT_SCHEMA);
  // Stamp the version on a fresh DB. INSERT OR IGNORE so we don't
  // overwrite an existing version (which the migration logic owns).
  db.prepare("INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, ?)").run(
    CURRENT_SCHEMA_VERSION,
  );
}

/** The schema version a fresh DB starts at (and the target every existing
 *  DB gets migrated up to on openDb). Bump this when adding a migration
 *  in src/migrations.ts; also update the CURRENT_SCHEMA block below so
 *  fresh DBs match. */
export const CURRENT_SCHEMA_VERSION = 4;

/** Tables a healthy DB must contain. Single source of truth so
 *  `mu doctor` and any other consumer don't drift. Adding a new table
 *  = one new entry here AND a CREATE TABLE in CURRENT_SCHEMA AND a
 *  migration in src/migrations.ts that adds it to existing DBs. */
export const EXPECTED_TABLES: readonly string[] = [
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
];

// ─── View DDL — single source of truth ────────────────────────────────
//
// The three views (ready, blocked, goals) get DROPped + CREATEd in
// three places: applySchema (here, on every openDb), and twice in
// src/migrations.ts (the v1->v2 and v2->v3 migrations both have to
// rebuild views after dropping tables they depend on). Defining the
// SQL once here and importing it from migrations.ts keeps the current
// shape from drifting silently.
//
// HISTORICAL NOTE: migrateV1ToV2 keeps its OWN inline `goals` view
// because the v2 shape (`status <> 'CLOSED'`) differs from the v3
// shape (`status NOT IN ('CLOSED','REJECTED','DEFERRED')`). The
// constant below is the CURRENT (v3+) shape; rewriting v1->v2 to use
// it would retroactively rewrite history. ready and blocked are byte-
// identical across every version so far, so v1->v2 imports those.
//
// Each constant is self-contained: DROP IF EXISTS + CREATE. Running
// DROP twice in a row is harmless, so callers that already DROP up-
// front (the migrations do, before rebuilding tables the views depend
// on) can still re-execute these without churn.

export const READY_VIEW_SQL = `
DROP VIEW IF EXISTS ready;
CREATE VIEW ready AS
  SELECT t.*
    FROM tasks t
   WHERE t.status = 'OPEN'
     AND NOT EXISTS (
       SELECT 1
         FROM task_edges e
         JOIN tasks      b ON e.from_task = b.local_id
        WHERE e.to_task = t.local_id
          AND b.status <> 'CLOSED'
     );
`;

export const BLOCKED_VIEW_SQL = `
DROP VIEW IF EXISTS blocked;
CREATE VIEW blocked AS
  SELECT t.*
    FROM tasks t
   WHERE t.status = 'OPEN'
     AND EXISTS (
       SELECT 1
         FROM task_edges e
         JOIN tasks      b ON e.from_task = b.local_id
        WHERE e.to_task = t.local_id
          AND b.status <> 'CLOSED'
     );
`;

// A goal is an active endpoint of the DAG — a task with no dependents
// that we're still working toward. CLOSED, REJECTED, and DEFERRED are
// all excluded: a finished/abandoned/parked leaf is not an active goal.
// (REJECTED and DEFERRED still BLOCK dependents per the views above
// — they're terminal/parked from the perspective of 'what's a goal',
// but they don't satisfy a blocked-by edge: only CLOSED does that.)
export const GOALS_VIEW_SQL = `
DROP VIEW IF EXISTS goals;
CREATE VIEW goals AS
  SELECT t.*
    FROM tasks t
   WHERE t.status NOT IN ('CLOSED', 'REJECTED', 'DEFERRED')
     AND NOT EXISTS (
       SELECT 1 FROM task_edges WHERE from_task = t.local_id
     );
`;

const CURRENT_SCHEMA = `
-- ─── Schema versioning ────────────────────────────────────────────────
--
-- Single-row table tracking which schema version this DB is at. Migrations
-- read and update this; the row is INSERT-OR-IGNOREd by applySchema with
-- the current version on a fresh DB.
CREATE TABLE IF NOT EXISTS schema_version (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

-- ─── Tables ───────────────────────────────────────────────────────────

-- One row per workstream — the unit of organisation. Workstreams are the
-- single source of truth for "does this name exist?"; agents and tasks
-- FK into here so a typo in 'mu spawn -w typo' is caught at the DB layer
-- (provided the workstream wasn't auto-created from a prior insert).
--
-- Auto-created on first insertAgent / addTask via ensureWorkstream() to
-- preserve initial-release ergonomics where adding a task didn't require explicit
-- mu init. The mu init verb still calls ensureWorkstream so init has
-- DB-side meaning beyond "create the tmux session".
CREATE TABLE IF NOT EXISTS workstreams (
  name        TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL                  -- ISO 8601
);

-- One row per managed agent.
CREATE TABLE IF NOT EXISTS agents (
  name        TEXT PRIMARY KEY,
  workstream  TEXT NOT NULL,
  cli         TEXT NOT NULL DEFAULT 'pi',    -- free TEXT by design — mu is
                                             --   heterogeneous; adding a new
                                             --   CLI must not need a schema
                                             --   change. 0.1.0 only really
                                             --   detects pi status.
  pane_id     TEXT NOT NULL,                 -- stable tmux pane id, e.g. "%15"
  status      TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'full-access',
  tab         TEXT,                          -- window name; NULL = use agent name
  created_at  TEXT NOT NULL,                 -- ISO 8601
  updated_at  TEXT NOT NULL,                 -- ISO 8601
  FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (status IN (
    'spawning', 'busy', 'needs_input', 'needs_permission',
    'free', 'unreachable', 'terminated'
  )),
  CHECK (role IN ('full-access', 'read-only'))
);

CREATE INDEX IF NOT EXISTS idx_agents_workstream ON agents (workstream);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);

-- One row per task in the DAG. Mandatory impact + effort_days drives ROI
-- prioritisation in the ready view.
--
-- Tasks are scoped to a workstream. local_id is the PRIMARY KEY (globally
-- unique across all workstreams), so two workstreams cannot have a task
-- with the same id — in practice this is fine because mu users normally
-- have one workstream per project, and the global namespace catches
-- accidental collisions early. A future release may switch to composite (local_id,
-- workstream) PRIMARY KEY if real users hit naming friction (recorded as
-- in docs/ROADMAP.md §"Schema normalization").
--
-- Cross-workstream edges are forbidden: addTask checks that every blocker
-- shares the new task's workstream.
--
-- owner is a real FK to agents(name) ON DELETE SET NULL ON UPDATE CASCADE:
-- when an agent is closed, tasks they owned drop their owner automatically
-- (matches the "owner = current ownership, not history" semantics that the
-- mu task release verb encodes; historical attribution lives in notes).
-- When an agent is renamed (via UPDATE on agents.name), the cascade
-- updates tasks.owner so it stays in sync.
CREATE TABLE IF NOT EXISTS tasks (
  local_id    TEXT PRIMARY KEY,
  workstream  TEXT NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN',
  -- OPEN | IN_PROGRESS | CLOSED | REJECTED | DEFERRED
  -- CLOSED   : completed; unblocks downstream dependents.
  -- REJECTED : terminal 'won't do' (out of scope, duplicate, wontfix);
  --            still BLOCKS downstream so dependents must be addressed.
  -- DEFERRED : parked, may revisit. Still blocks downstream too.
  -- See VOCABULARY.md for the full state-transition table.
  impact      INTEGER NOT NULL,              -- 1..100
  effort_days REAL NOT NULL,                 -- > 0
  owner       TEXT,                          -- FK → agents(name) SET NULL
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (owner)      REFERENCES agents (name)      ON DELETE SET NULL ON UPDATE CASCADE,
  CHECK (impact BETWEEN 1 AND 100),
  CHECK (effort_days > 0),
  CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CLOSED', 'REJECTED', 'DEFERRED'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_workstream ON tasks (workstream);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks (owner);

-- "blocks" relationships. A → B means A must close before B can start.
-- Cascade delete keeps the graph consistent when a task is removed.
CREATE TABLE IF NOT EXISTS task_edges (
  from_task   TEXT NOT NULL,                 -- blocker
  to_task     TEXT NOT NULL,                 -- dependent
  created_at  TEXT NOT NULL,
  PRIMARY KEY (from_task, to_task),
  FOREIGN KEY (from_task) REFERENCES tasks (local_id) ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (to_task)   REFERENCES tasks (local_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (from_task <> to_task)
);

CREATE INDEX IF NOT EXISTS idx_task_edges_to ON task_edges (to_task);

-- Append-only context per task. Survives across LLM sessions and agent
-- restarts. Author is the agent name (or "user" / "orchestrator").
CREATE TABLE IF NOT EXISTS task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks (local_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes (task_id);

-- agent_logs: append-only timeline of activity in the workstream.
--
-- Three roles in one table:
--   1. Manual broadcasts: "mu log 'X done; anyone waiting on it can go'"
--      — source = the calling agent (resolved via $TMUX_PANE) or 'user'.
--   2. System events: "task design CLOSED by worker-1" — source =
--      'system'. Auto-emitted by every state-changing verb so a tail
--      subscriber sees every mutation. (Wired in a follow-up commit.)
--   3. Anything an external script wants to drop in via 'mu log --as ...'.
--
-- The seq column is the cursor: '--since <seq>' returns rows STRICTLY
-- AFTER seq. AUTOINCREMENT (not just INTEGER PK) so a row's seq is
-- monotonic even after deletes — a tail subscriber's cursor is durable
-- against arbitrary cleanup.
--
-- workstream is nullable on principle (some future event might be
-- machine-wide) but every emitter today sets it. ON DELETE CASCADE
-- so destroying a workstream cleans its log.
--
-- kind is plain TEXT — 'message' (default for mu log), 'event' (auto
-- system events), 'broadcast' (explicit cross-agent), or anything a
-- caller invents. No CHECK so future kinds need no migration.
CREATE TABLE IF NOT EXISTS agent_logs (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream TEXT,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'message',
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_logs_seq ON agent_logs (seq);
CREATE INDEX IF NOT EXISTS idx_agent_logs_ws_seq ON agent_logs (workstream, seq);
CREATE INDEX IF NOT EXISTS idx_agent_logs_source ON agent_logs (source);

-- vcs_workspaces: one isolated working copy per agent.
--
-- The Tier-A blocker for actually running parallel agents in the same
-- repository: without per-agent workspaces, two agents editing the
-- working tree corrupt each other's changes. The backend column lets
-- the workspace be a git worktree, jj workspace, sapling clone, or a
-- naive cp -a snapshot ('none').
--
-- agent is PK + FK CASCADE: deleting the agent automatically removes
-- the workspace row. The on-disk directory still has to be cleaned up
-- by the verb (mu workspace free, or the agent-close path).
-- workstream FK CASCADE: destroying a workstream removes its workspaces
-- too. path is UNIQUE because two agents pointing at the same on-disk
-- workspace would defeat the purpose.
CREATE TABLE IF NOT EXISTS vcs_workspaces (
  agent       TEXT PRIMARY KEY REFERENCES agents (name) ON DELETE CASCADE ON UPDATE CASCADE,
  workstream  TEXT NOT NULL REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE,
  backend     TEXT NOT NULL CHECK (backend IN ('jj', 'sl', 'git', 'none')),
  path        TEXT NOT NULL UNIQUE,
  parent_ref  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vcs_workspaces_workstream ON vcs_workspaces (workstream);

-- approvals: human-in-the-loop gate for risky agent actions.
--
-- An agent script that's about to do something irreversible (delete a
-- task graph, run a destructive shell command, mark a diff ready to
-- land) requests an approval, then blocks on mu approve wait. A
-- human grants or denies via mu approve grant / deny. Without an
-- approval primitive, the only safety story is "the human runs the
-- destructive verb themselves" — which defeats the autonomous-agent
-- contract.
--
-- slug is the user-facing PK (short, human-typeable). status is a
-- closed enum; created/decided timestamps are ISO 8601. workstream
-- is FK CASCADE so destroying a workstream cleans pending approvals.
CREATE TABLE IF NOT EXISTS approvals (
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

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status);
CREATE INDEX IF NOT EXISTS idx_approvals_workstream ON approvals (workstream);

-- snapshots: pre-mutation backups of the whole DB.
--
-- One row per snapshot. db_path points at a standalone .db file under
-- <state-dir>/snapshots/<id>.db (flat layout — see snap_design note
-- #293 for why per-workstream subdirs were rejected). schema_version
-- captures the source DB's version at write time; restore checks it
-- against CURRENT_SCHEMA_VERSION to refuse cross-version restores.
--
-- workstream is nullable: a workstream-destroy snapshot logically
-- spans every workstream in the DB (whole-DB backup), so anchoring
-- it to one name would lie. Per-workstream destructive ops (task
-- close, agent close, etc.) record their workstream so list/filter
-- by workstream stays useful.
--
-- NO FK on workstream. Destroying a workstream must NOT cascade-delete
-- its pre-destroy snapshot — that's the whole point.
CREATE TABLE IF NOT EXISTS snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream      TEXT,
  label           TEXT NOT NULL,
  db_path         TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_created_at ON snapshots (created_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_workstream ON snapshots (workstream);

-- ─── Views (always replaced so the latest definition wins) ────────────
-- See READY_VIEW_SQL / BLOCKED_VIEW_SQL / GOALS_VIEW_SQL above for the
-- canonical DDL — interpolated here so applySchema is one db.exec().
${READY_VIEW_SQL}
${BLOCKED_VIEW_SQL}
${GOALS_VIEW_SQL}
`;
