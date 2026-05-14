// mu — DB module.
//
// Opens ~/.mu/mu.db (or MU_DB_PATH override), enables WAL + foreign keys,
// applies the schema idempotently, and exposes the live Database handle.
//
// Schema (see CHANGELOG.md §"Schema"):
//   - core tables: workstreams, agents, tasks, task_edges, task_notes,
//                  agent_logs, vcs_workspaces, snapshots
//     (+5 v6 archive_* tables; -1 approvals dropped in v7;
//      +2 v8 sync-substrate tables)
//   - 2 singleton-ish meta tables: schema_version, machine_identity
//   - 3 views:  ready, blocked, goals
//
// v5 (this version) is the surrogate-INTEGER-PK shape per
// docs/ARCHITECTURE.md § Surrogate-PK + SDK-boundary discipline.
// Every entity table has an INTEGER PK; FKs reference INTEGER ids;
// the operator-facing TEXT name is per-scope unique via
// UNIQUE (<scope_id>, <name>).
//
// IMPORTANT: src/db.ts knows ONLY the v5 shape. Pre-v5 DBs are
// rejected at openDb time with SchemaTooOldError; the operator
// recovers the one-shot v4→v5 migration script from git history
// (`git log --all --diff-filter=D -- scripts/migrate-v4-to-v5.ts`).
// The old in-process forward-only migration ladder (v1→v2, v2→v3,
// v3→v4) was removed in schema_v5_drop_migrations_ts: with the
// loud-fail hook below catching every pre-v5 DB before openDb
// returns, none of those migration paths could ever run.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";
import type { HasNextSteps, NextStep } from "./output.js";

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
 * Open the mu database. Creates the parent directory and applies the schema
 * idempotently on every open. Safe to call from many short-lived processes
 * concurrently — WAL mode handles cross-process writes.
 */
export function openDb(options: OpenDbOptions = {}): Db {
  const path = options.path ?? defaultDbPath();
  refuseUserDbDuringTests(path);
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { readonly: options.readonly ?? false });

  if (!options.readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Detect schema version BEFORE applySchema so a real v<5 DB is not
    // silently stamped as v5 by the CREATE-IF-NOT-EXISTS in applySchema.
    const detectedVersion = detectExistingSchemaVersion(db);
    if (detectedVersion !== null && detectedVersion < MIN_ACCEPTED_SCHEMA_VERSION) {
      // Loud-fail: refuse to touch a pre-v5 DB. The operator
      // restores the one-shot migrator from git history and retries.
      // (See docs/ARCHITECTURE.md § Surrogate-PK + SDK-boundary
      // discipline for the v5 substrate; the migrator was deleted
      // in the post-landing cleanup per the temp-impl-artifact rule.)
      // v5 DBs are forward-bumped to v6 in `applySchema` (purely
      // additive change).
      try {
        db.close();
      } catch {
        // best effort
      }
      throw new SchemaTooOldError(detectedVersion, MIN_ACCEPTED_SCHEMA_VERSION);
    }
    applySchema(db);
    seedMachineIdentity(db);
  } else {
    db.pragma("foreign_keys = ON");
  }

  return db;
}

/**
 * Hard guard (Layer "db" of bug_test_flake_round_2): refuse to open
 * the user's REAL default mu.db when running under vitest. Tests
 * MUST point at a per-test temp DB (via MU_DB_PATH or the explicit
 * `{ path }` option). A test that forgets to override either one
 * silently mutated the dev box's live state — we observed a stray
 * 'demo' workstream row replicated from test/tui-acceptance.integration.test.ts
 * into ~/.local/state/mu/mu.db. The guard throws a useful diagnostic
 * the moment the offending openDb() call is made; the failing test's
 * stack trace then names the leak source directly.
 *
 * Test mode = `process.env.VITEST` is defined OR `NODE_ENV === "test"`.
 * vitest sets VITEST="true" in every fork; the NODE_ENV branch is for
 * other runners that may invoke openDb during tests.
 *
 * The user's REAL DB path is computed from HOME / XDG_STATE_HOME
 * directly (NOT from defaultDbPath() — which would honour MU_DB_PATH
 * and produce the temp path the test set, defeating the check).
 * Production code paths (the `mu` CLI binary) never set VITEST, so
 * the guard is a complete no-op outside the test runner.
 */
function refuseUserDbDuringTests(path: string): void {
  const inTest = process.env.VITEST !== undefined || process.env.NODE_ENV === "test";
  if (!inTest) return;
  const home = process.env.HOME ?? homedir();
  const xdg = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
  const realDb = resolve(join(xdg, "mu", "mu.db"));
  if (resolve(path) === realDb) {
    throw new Error(
      `openDb refused: tests must NEVER write to the user DB (${realDb}). Set MU_DB_PATH to a per-test temp path (test/_runCli.ts does this automatically) or pass an explicit { path } argument. The leak source is the call site of openDb in this stack frame.`,
    );
  }
}

/**
 * Thrown by openDb when the on-disk DB is at a schema version older
 * than v5. v5 dropped the in-process forward migrator; the one-shot
 * v4→v5 migration script lives in git history (recover via
 * `git log --all --diff-filter=D -- scripts/migrate-v4-to-v5.ts`).
 *
 * Maps to exit code 4 (conflict) in cli.ts handle().
 */
// ─── Resolve helpers (operator-facing name -> surrogate id) ───────────
//
// docs/ARCHITECTURE.md § Surrogate-PK + SDK-boundary discipline:
//
//   PUBLIC SDK functions take operator-facing names (workstream + local
//   id + agent name). Internal helpers take surrogate ids. Resolution
//   happens at the public-function entry, exactly once.
//
// `resolveWorkstreamId` is the only resolve helper that throws a typed
// error from this leaf module — `WorkstreamNotFoundError` is defined
// here, so there is no cycle. The task / agent resolvers RETURN
// `number | null` (`tryResolveTaskId` / `tryResolveAgentId`) and let
// SDK callers in `src/tasks/*.ts` / `src/agents.ts` throw the typed
// `TaskNotFoundError` / `AgentNotFoundError` they own. That keeps
// `cli/handle.ts`'s `instanceof`-based exit-code map (3 = not-found)
// honest: a leaf throwing a plain `Error` whose `.name` was monkey-
// patched to `"TaskNotFoundError"` flunks `instanceof TaskNotFoundError`
// and falls through to the generic exit 1
// (review_substrate_resolve_id_anonymous_errors).

export class WorkstreamNotFoundError extends Error implements HasNextSteps {
  override readonly name = "WorkstreamNotFoundError";
  constructor(public readonly workstream: string) {
    super(`no such workstream: ${workstream}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List workstreams", command: "mu workstream list" },
      {
        intent: "Initialise this workstream",
        command: `mu workstream init ${this.workstream}`,
      },
    ];
  }
}

/** Resolve a workstream name to its INTEGER surrogate id. Throws
 *  WorkstreamNotFoundError on miss. Pure: no auto-create — callers
 *  that want the auto-create-or-resolve semantics use
 *  `ensureWorkstream` from src/workstream.ts (which returns void;
 *  follow up with `resolveWorkstreamId` if the id is needed).
 */
export function resolveWorkstreamId(db: Db, workstream: string): number {
  const row = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as
    | { id: number }
    | undefined;
  if (!row) throw new WorkstreamNotFoundError(workstream);
  return row.id;
}

/** Resolve a workstream name to its id, returning null on miss instead
 *  of throwing. Useful for read paths that want to early-return [] on
 *  a non-existent workstream (e.g. listTasks). */
export function tryResolveWorkstreamId(db: Db, workstream: string): number | null {
  const row = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as
    | { id: number }
    | undefined;
  return row ? row.id : null;
}

/** Resolve a (workstream_id, local_id) pair to the task's surrogate
 *  id, returning `null` on miss. SDK callers in `src/tasks/*.ts`
 *  wrap the null return in `TaskNotFoundError` so the CLI's typed-
 *  error → exit-code map (3 = not-found) fires. The leaf intentionally
 *  does NOT throw a typed error (it would either pull in a cyclic
 *  import or — as before — fake the `.name` and silently flunk
 *  `instanceof TaskNotFoundError`, falling through to exit 1).
 *  Renamed from `resolveTaskId` in
 *  review_substrate_resolve_id_anonymous_errors. */
export function tryResolveTaskId(db: Db, workstreamId: number, localId: string): number | null {
  const row = db
    .prepare("SELECT id FROM tasks WHERE workstream_id = ? AND local_id = ?")
    .get(workstreamId, localId) as { id: number } | undefined;
  return row ? row.id : null;
}

/** Resolve a (workstream_id, agent_name) pair to the agent's surrogate
 *  id, returning `null` on miss. SDK callers in `src/agents.ts` wrap
 *  the null return in `AgentNotFoundError` so the CLI's typed-error →
 *  exit-code map (3 = not-found) fires. See `tryResolveTaskId` for the
 *  full rationale (review_substrate_resolve_id_anonymous_errors). */
export function tryResolveAgentId(db: Db, workstreamId: number, name: string): number | null {
  const row = db
    .prepare("SELECT id FROM agents WHERE workstream_id = ? AND name = ?")
    .get(workstreamId, name) as { id: number } | undefined;
  return row ? row.id : null;
}

export class SchemaTooOldError extends Error implements HasNextSteps {
  override readonly name = "SchemaTooOldError";
  constructor(
    public readonly detectedVersion: number,
    public readonly requiredVersion: number,
  ) {
    super(
      `Detected v${detectedVersion} schema; v${requiredVersion} is required. The one-shot v4→v5 migration script (scripts/migrate-v4-to-v5.ts) was deleted post-landing; recover it from git history and run it once, then retry your command.`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Recover the one-shot v4→v5 migration script from git history",
        command: "git log --all --diff-filter=D -- scripts/migrate-v4-to-v5.ts | head",
      },
      {
        intent: "Then run it once against the DB",
        command:
          "git show <commit>:scripts/migrate-v4-to-v5.ts > /tmp/migrate.ts && npx tsx /tmp/migrate.ts",
      },
      {
        intent: "Then retry the original command",
        command: "# (your original mu invocation)",
      },
      {
        intent: "Inspect the on-disk DB version",
        command: `sqlite3 "$MU_DB_PATH" 'SELECT version FROM schema_version'`,
      },
    ];
  }
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

/**
 * Apply the schema. Idempotent: tables use CREATE TABLE IF NOT EXISTS;
 * views are dropped and recreated so the latest definition always wins.
 *
 * For fresh DBs this writes the current schema shape and stamps
 * schema_version = CURRENT_SCHEMA_VERSION. For existing DBs this is a
 * no-op for the table CREATEs (IF NOT EXISTS) but DOES recreate the
 * views. Pre-v5 DBs never reach this function — openDb's loud-fail
 * hook rejects them with SchemaTooOldError first.
 *
 * v5 → v6 in-place bump: v6 was purely additive (5 new archive_*
 * tables; no existing column / FK / view touched). The CREATE TABLE
 * IF NOT EXISTS blocks above create the new tables on a v5 DB.
 *
 * v6 → v7 in-place bump: v7 is destructive — drops the `approvals`
 * table (zero usage in 200+ task dogfood; anti-anticipatory pruning
 * per VISION.md "no traits with zero implementors"). The DROP runs
 * BEFORE the version stamp so a partial migration doesn't leave a
 * v7-stamped DB with the v6 table still present. Gated on the
 * detected pre-bump version so it's a one-shot for v6 DBs and a
 * harmless `IF EXISTS` no-op for fresh v7 DBs.
 *
 * v7 → v8 in-place bump: v8 is additive (machine_identity and
 * workstream_sync tables). openDb seeds machine_identity after this
 * schema block so v7 DBs upgraded in place get an identity too.
 */
function seedMachineIdentity(db: Db): void {
  const row = db.prepare("SELECT COUNT(*) AS count FROM machine_identity").get() as {
    count: number;
  };
  if (row.count !== 0) return;
  db.prepare(
    `INSERT OR IGNORE INTO machine_identity (id, machine_id, hostname, created_at)
     VALUES (1, ?, ?, ?)`,
  ).run(randomUUID(), hostname(), new Date().toISOString());
}

function applySchema(db: Db): void {
  // Sniff the recorded version BEFORE the schema CREATEs land — needed
  // to decide whether the v6 → v7 destructive migration runs (only on
  // a DB that's at v6 or older but ≥ v5, the openDb floor).
  const preBumpVersion = detectExistingSchemaVersion(db);
  db.exec(CURRENT_SCHEMA);
  // v6 → v7 destructive migration: drop the approvals table on any
  // pre-v7 DB. IF EXISTS so a fresh v7 DB (no approvals table ever
  // created) is a no-op too. The DROP must precede the version
  // stamp below: a partial migration that crashed mid-DROP would
  // re-run on next open instead of silently leaving the table.
  if (preBumpVersion !== null && preBumpVersion < 7) {
    db.exec("DROP INDEX IF EXISTS idx_approvals_status");
    db.exec("DROP INDEX IF EXISTS idx_approvals_workstream");
    db.exec("DROP TABLE IF EXISTS approvals");
  }
  // Stamp the version on a fresh DB. INSERT OR IGNORE so we don't
  // overwrite the version on an existing v5+ DB.
  db.prepare("INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, ?)").run(
    CURRENT_SCHEMA_VERSION,
  );
  // Forward-additive bump for in-place transitions (v5 → v6 archive
  // tables, v6 → v7 approvals removal). Guarded by `version < ?` so a
  // future open against a same-or-newer DB doesn't accidentally
  // downgrade.
  db.prepare("UPDATE schema_version SET version = ? WHERE id = 1 AND version < ?").run(
    CURRENT_SCHEMA_VERSION,
    CURRENT_SCHEMA_VERSION,
  );
}

/** The schema version a fresh DB starts at. v8 adds the
 *  machine_identity and workstream_sync sync substrate on top of v7
 *  (which dropped the approvals table), v6 (which added 5 archive_*
 *  tables), and v5's surrogate-PK substrate. The refusal floor is
 *  v5 — pre-v5 DBs throw `SchemaTooOldError`; v5+ DBs are
 *  forward-bumped in place by `applySchema`. */
export const CURRENT_SCHEMA_VERSION = 8;

/** The lowest schema version `openDb` will accept. v5+ DBs are
 *  forward-bumped to the current version in place (v5 → v6 added
 *  archive tables; v6 → v7 dropped the approvals table; v7 → v8
 *  adds the sync substrate). Pre-v5 DBs throw `SchemaTooOldError`. */
const MIN_ACCEPTED_SCHEMA_VERSION = 5;

/** Tables a healthy DB must contain. Single source of truth so
 *  `mu doctor` and any other consumer don't drift. Adding a new table
 *  = one new entry here AND a CREATE TABLE in CURRENT_SCHEMA. (Schema
 *  changes that aren't compatible with prior schemas bump
 *  CURRENT_SCHEMA_VERSION and ship with a one-shot script under
 *  scripts/ (the v4→v5 transition was the canonical example
 *  before the script was deleted post-landing). */
export const EXPECTED_TABLES: readonly string[] = [
  "agent_logs",
  "agents",
  "archived_edges",
  "archived_events",
  "archived_notes",
  "archived_tasks",
  "archives",
  "machine_identity",
  "schema_version",
  "snapshots",
  "task_edges",
  "task_notes",
  "tasks",
  "vcs_workspaces",
  "workstream_sync",
  "workstreams",
];

// ─── View DDL — single source of truth ────────────────────────────────
//
// The three views (ready, blocked, goals) get DROPped + CREATEd by
// applySchema on every openDb. Each constant is self-contained:
// DROP IF EXISTS + CREATE. Running DROP twice in a row is harmless,
// so callers that already DROP up-front can still re-execute these
// without churn.
//
// Exported as named constants so consumers can reference the canonical
// shape (e.g. one-shot migration scripts under scripts/) without
// duplicating SQL.

export const READY_VIEW_SQL = `
DROP VIEW IF EXISTS ready;
CREATE VIEW ready AS
  SELECT t.*
    FROM tasks t
   WHERE t.status = 'OPEN'
     AND NOT EXISTS (
       SELECT 1
         FROM task_edges e
         JOIN tasks      b ON e.from_task_id = b.id
        WHERE e.to_task_id = t.id
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
         JOIN tasks      b ON e.from_task_id = b.id
        WHERE e.to_task_id = t.id
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
       SELECT 1 FROM task_edges WHERE from_task_id = t.id
     );
`;

// ─── v5 SCHEMA ────────────────────────────────────────────────────────
//
// Per docs/ARCHITECTURE.md § Surrogate-PK + SDK-boundary discipline.
// Every entity table has:
//   - INTEGER PRIMARY KEY AUTOINCREMENT (surrogate identity)
//   - <scope>_id INTEGER NOT NULL REFERENCES <parent>(id) ON DELETE CASCADE
//   - <name>     TEXT  NOT NULL  (operator-facing, mutable)
//   - UNIQUE (<scope>_id, <name>)
//
// Foreign keys are INTEGER. Renames become single-row UPDATEs (no
// cascade chain). The TEXT name is just an attribute. snapshots is
// the documented exception (intentionally NO FK on workstream so a
// destroy snapshot outlives its workstream).

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

-- machine_identity: one durable identity per DB/machine, seeded by
-- openDb after schema creation. hostname is advisory only.
CREATE TABLE IF NOT EXISTS machine_identity (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  machine_id TEXT NOT NULL,
  hostname   TEXT,
  created_at TEXT NOT NULL
);

-- ─── Tables ───────────────────────────────────────────────────────────

-- workstreams: top of the hierarchy. name stays globally unique
-- because it IS a tmux session name; no <scope_id> column because
-- there's no parent.
CREATE TABLE IF NOT EXISTS workstreams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  created_at  TEXT NOT NULL                  -- ISO 8601
);

-- workstream_sync: per-workstream cross-machine drift state. Rows are
-- created on demand by db import/export code, not pre-seeded.
CREATE TABLE IF NOT EXISTS workstream_sync (
  workstream_id        INTEGER PRIMARY KEY REFERENCES workstreams (id) ON DELETE CASCADE,
  last_known_peer_seqs TEXT NOT NULL DEFAULT '{}'
);

-- agents: one row per managed pane. Per-workstream unique on name.
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                  -- per-workstream unique
  cli           TEXT NOT NULL DEFAULT 'pi',
  pane_id       TEXT NOT NULL,
  status        TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'full-access',
  tab           TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workstream_id, name),
  CHECK (status IN (
    'spawning', 'busy', 'needs_input', 'needs_permission',
    'free', 'unreachable', 'terminated'
  )),
  CHECK (role IN ('full-access', 'read-only'))
);

CREATE INDEX IF NOT EXISTS idx_agents_workstream ON agents (workstream_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);

-- tasks: per-workstream unique on local_id (TRULY local now —
-- different workstreams may reuse the same local_id).
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  local_id      TEXT NOT NULL,                 -- per-workstream unique
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN',
  -- OPEN | IN_PROGRESS | CLOSED | REJECTED | DEFERRED — see VOCABULARY.md.
  impact        INTEGER NOT NULL,
  effort_days   REAL NOT NULL,
  owner_id      INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workstream_id, local_id),
  CHECK (impact BETWEEN 1 AND 100),
  CHECK (effort_days > 0),
  CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CLOSED', 'REJECTED', 'DEFERRED'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_workstream ON tasks (workstream_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks (owner_id);

-- task_edges: composite PK by pair. INTEGER FKs into tasks.id.
CREATE TABLE IF NOT EXISTS task_edges (
  from_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  to_task_id   INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (from_task_id, to_task_id),
  CHECK (from_task_id <> to_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_edges_to ON task_edges (to_task_id);

-- task_notes: append-only context. author stays free-text
-- ("orchestrator", "user", "π - mu", "system") — not always a
-- registered agent.
CREATE TABLE IF NOT EXISTS task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes (task_id);

-- agent_logs: append-only timeline. source stays free-text ("system",
-- "user", "orchestrator", or any agent name) — not an FK relation.
-- workstream_id is nullable (a future machine-wide event might exist)
-- but every current emitter sets it; CASCADE on workstream destroy.
CREATE TABLE IF NOT EXISTS agent_logs (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER REFERENCES workstreams (id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'message',
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_logs_seq ON agent_logs (seq);
CREATE INDEX IF NOT EXISTS idx_agent_logs_ws_seq ON agent_logs (workstream_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_logs_source ON agent_logs (source);

-- vcs_workspaces: one isolated working copy per agent.
-- UNIQUE (agent_id) enforces the 1:1 invariant; workstream_id is
-- denormalised for query convenience. path is UNIQUE because two
-- agents pointing at the same on-disk workspace would defeat the
-- purpose.
CREATE TABLE IF NOT EXISTS vcs_workspaces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  backend       TEXT NOT NULL CHECK (backend IN ('jj', 'sl', 'git', 'none')),
  path          TEXT NOT NULL UNIQUE,
  parent_ref    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vcs_workspaces_workstream ON vcs_workspaces (workstream_id);

-- snapshots: documented exception. NO FK on workstream — a destroy
-- snapshot must outlive its workstream. workstream column stays TEXT
-- so the snapshot remains readable even after every reference is gone.
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

-- ─── v6 archive tables (additive on top of v5) ────────────────────
--
-- 5 new tables landed in v6 to back the mu archive verb (cross-workstream
-- preservation of CLOSED/REJECTED/DEFERRED tasks before destroy).
-- Additive only: no existing column / FK / view touched. The v5 → v6
-- transition is in-place via applySchema (no separate migration
-- script). See docs/VOCABULARY.md § archive for terminology.
--
-- Design constraint: archives outlive workstreams. archives.label is
-- globally unique (NOT per-workstream), and archived_tasks columns
-- that refer to the source workstream are TEXT (not FKs) so the
-- destroyed workstream's name stays readable post-destroy.

-- archives: one row per operator-named archive bucket. label is
-- globally unique because archives outlive workstreams (an archive
-- whose label was scoped to a workstream would lose its name when
-- the workstream is destroyed).
CREATE TABLE IF NOT EXISTS archives (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT UNIQUE NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL,
  last_added_at TEXT NOT NULL                  -- bumped on every successful add (additive accumulation invariant)
);

-- archived_tasks: snapshot of a task at archive time. source_workstream
-- is intentionally TEXT (the source workstream may be destroyed after
-- archive); owner_name is snapshotted for the same reason. The
-- (archive_id, source_workstream, original_local_id) UNIQUE is the
-- idempotency lever for mu archive add re-runs.
CREATE TABLE IF NOT EXISTS archived_tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id          INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  source_workstream   TEXT NOT NULL,
  original_local_id   TEXT NOT NULL,
  title               TEXT NOT NULL,
  status              TEXT NOT NULL,
  impact              INTEGER NOT NULL,
  effort_days         REAL NOT NULL,
  owner_name          TEXT,
  archived_at_status  TEXT NOT NULL,
  archived_at         TEXT NOT NULL,
  original_created_at TEXT NOT NULL,
  original_updated_at TEXT NOT NULL,
  UNIQUE (archive_id, source_workstream, original_local_id)
);

CREATE INDEX IF NOT EXISTS idx_archived_tasks_archive ON archived_tasks (archive_id);
CREATE INDEX IF NOT EXISTS idx_archived_tasks_source ON archived_tasks (archive_id, source_workstream);

-- archived_edges: composite PK by pair of archived_tasks ids.
-- archive_id is denormalised so a CASCADE on the archive cleans every
-- edge in one shot.
CREATE TABLE IF NOT EXISTS archived_edges (
  archive_id        INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  from_archived_id  INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
  to_archived_id    INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
  PRIMARY KEY (archive_id, from_archived_id, to_archived_id)
);

-- archived_notes: snapshot of task_notes for archived tasks. author
-- stays free-text, mirroring task_notes.
CREATE TABLE IF NOT EXISTS archived_notes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id       INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  archived_task_id INTEGER NOT NULL REFERENCES archived_tasks (id) ON DELETE CASCADE,
  author           TEXT,
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archived_notes_task ON archived_notes (archived_task_id);

-- archived_events: snapshot of kind='event' rows from agent_logs for
-- the source workstream at archive time. Only events (not the full
-- message log; that's recoverable via snapshot+undo if ever needed).
CREATE TABLE IF NOT EXISTS archived_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id        INTEGER NOT NULL REFERENCES archives (id) ON DELETE CASCADE,
  source_workstream TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  source            TEXT NOT NULL,
  payload           TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archived_events_archive ON archived_events (archive_id, source_workstream);

-- ─── Views (always replaced so the latest definition wins) ────────────
-- See READY_VIEW_SQL / BLOCKED_VIEW_SQL / GOALS_VIEW_SQL above for the
-- canonical DDL — interpolated here so applySchema is one db.exec().
${READY_VIEW_SQL}
${BLOCKED_VIEW_SQL}
${GOALS_VIEW_SQL}
`;
