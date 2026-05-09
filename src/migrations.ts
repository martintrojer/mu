// mu — schema migrations.
//
// Forward-only migrations from one schema version to the next. Each
// function rebuilds the DB in place from `version - 1` to `version`.
//
// Migrations run inside a single transaction with foreign_keys=OFF so
// the table-rebuild dance (CREATE _new, INSERT SELECT, DROP, RENAME)
// doesn't trip FK constraints on intermediate states. After each
// migration, foreign_keys is turned back on and PRAGMA foreign_key_check
// verifies integrity. If the check finds violations, the transaction
// rolls back and the open fails.
//
// Adding a new migration:
//   1. Bump CURRENT_SCHEMA_VERSION in src/db.ts.
//   2. Update the CURRENT_SCHEMA block in src/db.ts so fresh DBs match.
//   3. Add a (toVersion -> fn) entry to MIGRATIONS below that
//      transforms an existing DB from the previous shape into the new one.
//   4. Cover both the fresh-create AND the migrate-existing paths
//      in test/db.test.ts.

import {
  BLOCKED_VIEW_SQL,
  CURRENT_SCHEMA_VERSION,
  type Db,
  GOALS_VIEW_SQL,
  READY_VIEW_SQL,
} from "./db.js";

type Migration = (db: Db) => void;

const MIGRATIONS: ReadonlyMap<number, Migration> = new Map([
  // v1 -> v2: add ON UPDATE CASCADE to every FK so renaming a
  // workstream / task / agent cascades through children atomically.
  // SQLite can't ALTER TABLE to modify FK clauses, so we rebuild
  // every affected table.
  [2, migrateV1ToV2],
  // v2 -> v3: widen tasks.status CHECK to add REJECTED + DEFERRED;
  // recreate the `goals` view so it excludes them from the
  // 'still-being-worked-toward' filter.
  [3, migrateV2ToV3],
  // v3 -> v4: add the snapshots table for the snapshots-and-undo
  // feature (snap_schema). Pure additive: one CREATE TABLE plus two
  // CREATE INDEX, no row touching, no FK rebuild.
  [4, migrateV3ToV4],
]);

/**
 * Drive every pending migration from the DB's current schema_version
 * up to CURRENT_SCHEMA_VERSION. Called by openDb after applySchema.
 *
 * Throws if any migration is missing (programming error: someone
 * bumped CURRENT_SCHEMA_VERSION without registering a migration) or
 * if a migration's post-condition (no FK violations) fails.
 */
export function runMigrations(db: Db): void {
  const current = currentSchemaVersion(db);
  for (let v = current + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    const migrate = MIGRATIONS.get(v);
    if (!migrate) {
      throw new Error(
        `no migration registered to version ${v}; this is a programming error in src/migrations.ts`,
      );
    }
    runOneMigration(db, v, migrate);
  }
}

function currentSchemaVersion(db: Db): number {
  const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as
    | { version: number }
    | undefined;
  if (!row) {
    throw new Error(
      "schema_version row missing; applySchema should have inserted it before runMigrations",
    );
  }
  return row.version;
}

/**
 * Wrap a migration in the safe-rebuild transaction pattern:
 *   1. PRAGMA foreign_keys = OFF (must be outside the transaction; SQLite
 *      forbids toggling it inside).
 *   2. BEGIN.
 *   3. Run the migration body.
 *   4. PRAGMA foreign_key_check INSIDE the transaction. Any violations
 *      mean the migration mishandled the data — abort BEFORE the
 *      schema_version bump and ROLLBACK so neither the data changes
 *      nor the version stamp commit.
 *   5. UPDATE schema_version.
 *   6. COMMIT.
 *   7. PRAGMA foreign_keys = ON.
 *
 * Earlier this function did the foreign_key_check AFTER the COMMIT,
 * which meant a migration that left orphans would still bump the
 * version stamp before throwing — leaving the DB in a half-migrated
 * state that openDb couldn't recover from on the next run. Real DB
 * surfaced this on first attempt.
 */
// Exported as a test seam: test/db.test.ts uses this to assert the
// rollback contract directly (canary-table-then-throw migration
// confirms (a) schema_version unchanged, (b) intermediate writes
// rolled back). Not part of the public SDK — hidden behind the
// underscore-prefixed export so it doesn't show up in src/index.ts.
export function _runOneMigration(db: Db, toVersion: number, migrate: (db: Db) => void): void {
  runOneMigration(db, toVersion, migrate);
}

function runOneMigration(db: Db, toVersion: number, migrate: Migration): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    try {
      migrate(db);
      const violations = db.pragma("foreign_key_check") as Array<unknown>;
      if (violations.length > 0) {
        throw new Error(
          `migration to v${toVersion} produced ${violations.length} FK violations; aborting (no schema_version bump, no data committed)`,
        );
      }
      db.prepare("UPDATE schema_version SET version = ? WHERE id = 1").run(toVersion);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// ─── v1 → v2 ────────────────────────────────────────────────────────

/**
 * v1 -> v2: add ON UPDATE CASCADE to every FK.
 *
 * SQLite can't ALTER TABLE to add an ON UPDATE clause, so for each
 * affected table we:
 *   1. CREATE TABLE _new with the new FK shape.
 *   2. INSERT INTO _new SELECT * FROM <old>.
 *   3. DROP TABLE <old>.
 *   4. ALTER TABLE _new RENAME TO <old>.
 *   5. Recreate the indexes (which were dropped with the old table).
 *
 * Order: rebuild children before parents so when foreign_keys is
 * turned back on the references resolve. (We toggle FKs off during
 * the migration anyway, but child-first is the conventional safer
 * recipe.)
 *
 * The CREATE TABLE bodies below MUST stay in lock-step with
 * CURRENT_SCHEMA in src/db.ts. If a future migration changes the
 * schema shape, that migration's table bodies replace these.
 */
function migrateV1ToV2(db: Db): void {
  // Drop views first — they reference `tasks` and `task_edges`, and
  // SQLite refuses to DROP TABLE while a view depends on it. We
  // recreate them at the end of this migration so the DB is fully
  // usable the moment the migration commits.
  db.exec("DROP VIEW IF EXISTS ready;");
  db.exec("DROP VIEW IF EXISTS blocked;");
  db.exec("DROP VIEW IF EXISTS goals;");

  // Pre-cleanup: legacy DBs (predating the FK additions to tasks.owner)
  // can have tasks.owner pointing at agents that don't exist. The new
  // FK on tasks.owner is `ON DELETE SET NULL`; the cleanup below is
  // exactly what that cascade would have done if the FK had been there
  // at delete time. Without this, the post-migration foreign_key_check
  // would refuse to commit. Logged via INSERT into agent_logs so the
  // user has a record of what got cleared.
  // Capture the affected (workstream, count) set BEFORE the UPDATE so
  // we can emit one log row per affected workstream after.
  const orphans = db
    .prepare(
      "SELECT workstream, COUNT(*) AS n FROM tasks WHERE owner IS NOT NULL AND owner NOT IN (SELECT name FROM agents) GROUP BY workstream",
    )
    .all() as Array<{ workstream: string; n: number }>;
  const orphanCount = orphans.reduce((acc, r) => acc + r.n, 0);
  if (orphanCount > 0) {
    db.prepare(
      "UPDATE tasks SET owner = NULL WHERE owner IS NOT NULL AND owner NOT IN (SELECT name FROM agents)",
    ).run();
    // Surface in agent_logs as a system event so 'mu log --kind event'
    // shows it. One row per affected workstream so each workstream's
    // tail subscription sees its own count.
    const insert = db.prepare(
      "INSERT INTO agent_logs (workstream, source, kind, payload, created_at) VALUES (?, 'system', 'event', ?, datetime('now'))",
    );
    for (const { workstream, n } of orphans) {
      insert.run(
        workstream,
        `migration v1->v2: cleared owner on ${n} task(s) pointing at non-existent agent(s); cascade-equivalent of ON DELETE SET NULL`,
      );
    }
  }

  // Children first: vcs_workspaces (refs agents + workstreams),
  // approvals (refs workstreams), agent_logs (refs workstreams),
  // task_notes (refs tasks), task_edges (refs tasks), tasks (refs
  // workstreams + agents), agents (refs workstreams). Parents
  // (workstreams) don't need rebuilding since nothing changed about
  // their column definitions.
  rebuildTable(
    db,
    "vcs_workspaces",
    `
    CREATE TABLE vcs_workspaces_new (
      agent       TEXT PRIMARY KEY REFERENCES agents (name) ON DELETE CASCADE ON UPDATE CASCADE,
      workstream  TEXT NOT NULL REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE,
      backend     TEXT NOT NULL CHECK (backend IN ('jj', 'sl', 'git', 'none')),
      path        TEXT NOT NULL UNIQUE,
      parent_ref  TEXT,
      created_at  TEXT NOT NULL
    );
  `,
    ["CREATE INDEX IF NOT EXISTS idx_vcs_workspaces_workstream ON vcs_workspaces (workstream);"],
  );

  rebuildTable(
    db,
    "approvals",
    `
    CREATE TABLE approvals_new (
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
  `,
    [
      "CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals (status);",
      "CREATE INDEX IF NOT EXISTS idx_approvals_workstream ON approvals (workstream);",
    ],
  );

  rebuildTable(
    db,
    "agent_logs",
    `
    CREATE TABLE agent_logs_new (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      workstream TEXT,
      source     TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'message',
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workstream) REFERENCES workstreams (name) ON DELETE CASCADE ON UPDATE CASCADE
    );
  `,
    [
      "CREATE INDEX IF NOT EXISTS idx_agent_logs_seq ON agent_logs (seq);",
      "CREATE INDEX IF NOT EXISTS idx_agent_logs_ws_seq ON agent_logs (workstream, seq);",
      "CREATE INDEX IF NOT EXISTS idx_agent_logs_source ON agent_logs (source);",
    ],
  );

  rebuildTable(
    db,
    "task_notes",
    `
    CREATE TABLE task_notes_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      author     TEXT,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks (local_id) ON DELETE CASCADE ON UPDATE CASCADE
    );
  `,
    ["CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes (task_id);"],
  );

  rebuildTable(
    db,
    "task_edges",
    `
    CREATE TABLE task_edges_new (
      from_task   TEXT NOT NULL,
      to_task     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (from_task, to_task),
      FOREIGN KEY (from_task) REFERENCES tasks (local_id) ON DELETE CASCADE ON UPDATE CASCADE,
      FOREIGN KEY (to_task)   REFERENCES tasks (local_id) ON DELETE CASCADE ON UPDATE CASCADE,
      CHECK (from_task <> to_task)
    );
  `,
    ["CREATE INDEX IF NOT EXISTS idx_task_edges_to ON task_edges (to_task);"],
  );

  rebuildTable(
    db,
    "tasks",
    `
    CREATE TABLE tasks_new (
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
      CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CLOSED'))
    );
  `,
    [
      "CREATE INDEX IF NOT EXISTS idx_tasks_workstream ON tasks (workstream);",
      "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);",
      "CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks (owner);",
    ],
  );

  rebuildTable(
    db,
    "agents",
    `
    CREATE TABLE agents_new (
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
      CHECK (status IN (
        'spawning', 'busy', 'needs_input', 'needs_permission',
        'free', 'unreachable', 'terminated'
      )),
      CHECK (role IN ('full-access', 'read-only'))
    );
  `,
    [
      "CREATE INDEX IF NOT EXISTS idx_agents_workstream ON agents (workstream);",
      "CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);",
    ],
  );

  // Recreate views inline so the DB is fully usable the moment the
  // migration commits (applySchema also recreates them on every open,
  // but we shouldn't depend on that order).
  //
  // ready and blocked are byte-identical across every version so far,
  // so we pull from the canonical constants in src/db.ts. goals is
  // KEPT INLINE here as a faithful record of the v2 shape
  // (`status <> 'CLOSED'`); the v3 shape widens that exclude list,
  // and migrations are forward-only history — rewriting v1->v2 to
  // emit a v3-shape view would be a lie about what v2 looked like.
  db.exec(READY_VIEW_SQL);
  db.exec(BLOCKED_VIEW_SQL);
  db.exec(`
    CREATE VIEW goals AS
      SELECT t.*
        FROM tasks t
       WHERE t.status <> 'CLOSED'
         AND NOT EXISTS (
           SELECT 1 FROM task_edges WHERE from_task = t.local_id
         );
  `);
}

/** Helper: replace `name` with `name_new` in place via the standard
 *  CREATE/INSERT/DROP/RENAME dance. Recreates indexes after rename. */
function rebuildTable(db: Db, name: string, createNewSql: string, indexSqls: string[]): void {
  db.exec(createNewSql);
  db.exec(`INSERT INTO ${name}_new SELECT * FROM ${name};`);
  db.exec(`DROP TABLE ${name};`);
  db.exec(`ALTER TABLE ${name}_new RENAME TO ${name};`);
  for (const idx of indexSqls) db.exec(idx);
}

// ─── v2 → v3 ──────────────────────────────────────────────────

/**
 * v2 -> v3: widen tasks.status CHECK to add REJECTED + DEFERRED, and
 * recreate the `goals` view to exclude them.
 *
 * Existing data: every row stays valid (the new CHECK is a strict
 * superset). The only invariant change is that the goals view now
 * filters more aggressively — since v2 had no REJECTED/DEFERRED rows,
 * goal counts on a freshly-migrated DB are identical.
 */
// ─── v3 → v4 ──────────────────────────────────────────────

/**
 * v3 -> v4: add the `snapshots` table.
 *
 * Pure additive migration — no existing rows touched, no FK rebuild.
 * The table body MUST stay in lock-step with CURRENT_SCHEMA in
 * src/db.ts. See snap_design note #293 for why workstream is
 * nullable and why there's deliberately NO FK on it.
 */
function migrateV3ToV4(db: Db): void {
  // IF NOT EXISTS on every statement: applySchema runs BEFORE
  // runMigrations and CREATEs the v4 snapshots table from
  // CURRENT_SCHEMA via its own IF NOT EXISTS clauses. So by the time
  // this migration body fires, the table is already there. The
  // migration is still defined explicitly so the v3->v4 step in
  // MIGRATIONS isn't a missing-version error — and so a future hand-
  // crafted v3 DB without the table still gets it.
  db.exec(`
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
  `);
}

function migrateV2ToV3(db: Db): void {
  // Drop views first — SQLite refuses to DROP TABLE while a view
  // depends on it.
  db.exec("DROP VIEW IF EXISTS ready;");
  db.exec("DROP VIEW IF EXISTS blocked;");
  db.exec("DROP VIEW IF EXISTS goals;");

  // Rebuild tasks with the widened CHECK. Every other column matches
  // the v2 shape exactly (kept in lock-step with CURRENT_SCHEMA in
  // src/db.ts).
  rebuildTable(
    db,
    "tasks",
    `
    CREATE TABLE tasks_new (
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
      CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CLOSED', 'REJECTED', 'DEFERRED'))
    );
  `,
    [
      "CREATE INDEX IF NOT EXISTS idx_tasks_workstream ON tasks (workstream);",
      "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);",
      "CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks (owner);",
    ],
  );

  // Recreate views — ready/blocked unchanged from v2 (only CLOSED
  // satisfies a blocked-by edge, both before and after); goals widens
  // its exclude list to also drop REJECTED + DEFERRED leaves. All three
  // pulled from the canonical constants in src/db.ts — v3 IS the
  // current shape, so the live constant is also the historically-
  // correct v3 shape.
  db.exec(READY_VIEW_SQL);
  db.exec(BLOCKED_VIEW_SQL);
  db.exec(GOALS_VIEW_SQL);
}
