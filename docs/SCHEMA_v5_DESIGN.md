# Schema v5 — Surrogate INTEGER PKs as the universal pattern

> **Status:** DESIGN ONLY. No code change accompanies this document.
> Implementation is split across the follow-up tasks listed at the end.
> This doc is the design-anchor for `schema_surrogate_pks_for_global_uniqueness`.

---

## TL;DR

Today (v4), every entity table in `src/db.ts` uses a TEXT primary
key — `workstreams.name`, `agents.name`, `tasks.local_id`,
`approvals.slug`, `vcs_workspaces.agent`. Foreign keys cascade
through TEXT columns. The most-used "local" identifier
(`tasks.local_id`) is **globally** unique despite its name, which
forces operators into a global namespace for what is conceptually a
per-workstream concept.

v5 flips every entity table to a **surrogate INTEGER PK** with a
UNIQUE-per-scope constraint on the operator-facing TEXT name. FKs
become INTEGER. Renames become single-row UPDATEs. `mu task add
design -w wsA` then `mu task add design -w wsB` just works.

The CLI surface does NOT change. Operators still type
`mu task claim design`. The CLI resolves operator-facing names to
surrogate ids at the verb boundary; the SDK takes the resolved id
internally.

---

## The 6-line pattern (restated)

EVERY persistent entity table in mu's schema gets:

    (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,   -- surrogate, internal
      <scope_id>    INTEGER NOT NULL REFERENCES <parent>(id) ON DELETE CASCADE,
      <name>        TEXT NOT NULL,                        -- operator-facing, mutable
      -- ... domain attributes
      UNIQUE (<scope_id>, <name>)                         -- per-scope unique
    )

EVERY foreign key references `<child>.<parent>_id` (INTEGER), never
the TEXT name. The TEXT name is JUST an operator-facing attribute —
searchable, displayable, renamable cheaply. The surrogate id is the
identity.

---

## Why now (the gap, restated for the design record)

1. **The name lies.** `tasks.local_id` is named "local" but is a
   global PK. Operators reuse `design`, `cleanup`, `review`, etc.
   across workstreams and hit `TaskExistsError`.
2. **Long-lived DBs accumulate.** This very mu DB has 50+ closed
   tasks in `mufeedback` alone. Auto-snapshot keeps them around
   even after destroy + undo, so the global namespace fills up
   permanently.
3. **`idFromTitle`'s slugify+collision-loop**
   (`review_code_slugify_collision_truncates`) is a workaround for
   this schema decision.
4. **The reserved `mu_` prefix gymnastics** in `TaskIdInvalidError`
   (sanitises a leading `mu_` → `t_mu_`) is a workaround for the
   same global-namespace concern.
5. **Renames are expensive.** Today `UPDATE workstreams SET name =
   'new'` works only because every child table has a TEXT cascade
   that fires. v5 renames are single-row UPDATEs.
6. **Cross-workstream task move** (`nit_no_task_move_verb`,
   deferred) is impossible to implement cleanly today; v5 makes it
   trivial.
7. **`cross_workstream_claim_for` pre-check** (just shipped) is
   needed only because `agents.name` is a global TEXT PK; v5's
   composite UNIQUE on `(workstream_id, name)` plus the FK from
   `tasks.owner_id → agents.id` makes the cross-ws case naturally
   impossible.

---

## Per-table v4 → v5 transformation

### `workstreams`

**v4:**

```sql
CREATE TABLE workstreams (
  name        TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);
```

**v5:**

```sql
CREATE TABLE workstreams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,             -- still globally unique (tmux)
  created_at  TEXT NOT NULL
);
```

`name` stays globally unique — see "What stays TEXT and why" below
for the tmux-session-name rationale. No `<scope_id>` because
workstreams are the top of the hierarchy.

### `agents`

**v4:**

```sql
CREATE TABLE agents (
  name        TEXT PRIMARY KEY,
  workstream  TEXT NOT NULL REFERENCES workstreams (name) ...,
  cli         TEXT NOT NULL DEFAULT 'pi',
  pane_id     TEXT NOT NULL,
  status      TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'full-access',
  tab         TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  ...
);
```

**v5:**

```sql
CREATE TABLE agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,                   -- per-workstream unique
  cli           TEXT NOT NULL DEFAULT 'pi',
  pane_id       TEXT NOT NULL,
  status        TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'full-access',
  tab           TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (workstream_id, name),
  CHECK (status IN ('spawning', 'busy', 'needs_input', 'needs_permission',
                    'free', 'unreachable', 'terminated')),
  CHECK (role IN ('full-access', 'read-only'))
);

CREATE INDEX idx_agents_workstream ON agents (workstream_id);
CREATE INDEX idx_agents_status     ON agents (status);
```

### `tasks`

**v4:**

```sql
CREATE TABLE tasks (
  local_id    TEXT PRIMARY KEY,                  -- "local" in name only
  workstream  TEXT NOT NULL REFERENCES workstreams (name) ...,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'OPEN',
  impact      INTEGER NOT NULL,
  effort_days REAL NOT NULL,
  owner       TEXT REFERENCES agents (name) ON DELETE SET NULL ...,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

**v5:**

```sql
CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  local_id      TEXT NOT NULL,                   -- TRULY local now
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
  CHECK (status IN ('OPEN', 'IN_PROGRESS', 'CLOSED', 'REJECTED', 'DEFERRED'))
);

CREATE INDEX idx_tasks_workstream ON tasks (workstream_id);
CREATE INDEX idx_tasks_status     ON tasks (status);
CREATE INDEX idx_tasks_owner      ON tasks (owner_id);
```

The cross-workstream-edges check in `addTask` becomes a query on
`workstream_id` rather than `workstream` (TEXT) — same logic, just
cheaper joins.

### `task_edges`

**v4:**

```sql
CREATE TABLE task_edges (
  from_task   TEXT NOT NULL REFERENCES tasks (local_id) ...,
  to_task     TEXT NOT NULL REFERENCES tasks (local_id) ...,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (from_task, to_task),
  CHECK (from_task <> to_task)
);
```

**v5:**

```sql
CREATE TABLE task_edges (
  from_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  to_task_id   INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (from_task_id, to_task_id),
  CHECK (from_task_id <> to_task_id)
);

CREATE INDEX idx_task_edges_to ON task_edges (to_task_id);
```

The composite PK stays; an edge's identity is the pair, not a
surrogate.

### `task_notes`

**v4:**

```sql
CREATE TABLE task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- already correct
  task_id    TEXT NOT NULL REFERENCES tasks (local_id) ...,
  author     TEXT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

**v5:**

```sql
CREATE TABLE task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  author     TEXT,                               -- free-text; see below
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_task_notes_task ON task_notes (task_id);
```

`author` stays TEXT — it's a free-text actor label (could be
`"orchestrator"`, `"user"`, `"π - mu"`, `"system"`), not always a
registered agent.

### `agent_logs`

**v4:**

```sql
CREATE TABLE agent_logs (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- already correct
  workstream TEXT REFERENCES workstreams (name) ...,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'message',
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

**v5:**

```sql
CREATE TABLE agent_logs (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER REFERENCES workstreams (id) ON DELETE CASCADE,
  source        TEXT NOT NULL,                   -- free-text; see below
  kind          TEXT NOT NULL DEFAULT 'message',
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_agent_logs_seq    ON agent_logs (seq);
CREATE INDEX idx_agent_logs_ws_seq ON agent_logs (workstream_id, seq);
CREATE INDEX idx_agent_logs_source ON agent_logs (source);
```

`source` stays TEXT — same rationale as `task_notes.author`. The
logger is a publish-side concern, not a registered-agent concern.

### `vcs_workspaces`

**v4:**

```sql
CREATE TABLE vcs_workspaces (
  agent       TEXT PRIMARY KEY REFERENCES agents (name) ...,
  workstream  TEXT NOT NULL REFERENCES workstreams (name) ...,
  backend     TEXT NOT NULL CHECK (backend IN ('jj', 'sl', 'git', 'none')),
  path        TEXT NOT NULL UNIQUE,
  parent_ref  TEXT,
  created_at  TEXT NOT NULL
);
```

**v5:**

```sql
CREATE TABLE vcs_workspaces (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL UNIQUE REFERENCES agents (id) ON DELETE CASCADE,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  backend       TEXT NOT NULL CHECK (backend IN ('jj', 'sl', 'git', 'none')),
  path          TEXT NOT NULL UNIQUE,
  parent_ref    TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_vcs_workspaces_workstream ON vcs_workspaces (workstream_id);
```

`UNIQUE (agent_id)` enforces the 1:1 invariant that the v4 PK
encoded implicitly. `workstream_id` is denormalised for query
convenience (matches v4); a CHECK trigger could enforce
`workstream_id == (SELECT workstream_id FROM agents WHERE id =
agent_id)` but the application already ensures it.

### `approvals`

**v4:**

```sql
CREATE TABLE approvals (
  slug         TEXT PRIMARY KEY,                 -- globally unique today
  workstream   TEXT REFERENCES workstreams (name) ...,
  reason       TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  decided_by   TEXT,
  decided_at   TEXT,
  created_at   TEXT NOT NULL
);
```

**v5:**

```sql
CREATE TABLE approvals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,                   -- per-workstream unique
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
```

Note the `workstream_id NOT NULL` change: today the column is
nullable (no FK enforcement of NOT NULL). v5 makes workstream
required, matching the actual usage — every CLI emit has a
workstream.

### `snapshots`

**Unchanged shape**, but FK-style columns updated for consistency.
Snapshots have NO FK on workstream by design (a workstream-destroy
snapshot must outlive the workstream). The column stays TEXT (the
workstream name as recorded at snapshot time) so the snapshot
remains readable even after every reference to that workstream is
gone:

```sql
CREATE TABLE snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workstream      TEXT,                          -- NO FK, intentional
  label           TEXT NOT NULL,
  db_path         TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);
```

This is the one entity table that does NOT follow the surrogate-id
+ FK pattern, because its lifecycle is intentionally orthogonal to
the workstream lifecycle. Document the exception in
`ARCHITECTURE.md` alongside the load-bearing pattern.

### `schema_version`

Unchanged. Single-row meta table. Bumps to `5` in the migration.

---

## Views

`ready`, `blocked`, `goals` reference `tasks` columns. They get
DROPped + CREATEd against the v5 shape. The view bodies stay
near-identical (`status` columns are unchanged); only the JOIN
condition switches:

```sql
-- v4
JOIN tasks b ON e.from_task = b.local_id
WHERE e.to_task = t.local_id

-- v5
JOIN tasks b ON e.from_task_id = b.id
WHERE e.to_task_id = t.id
```

---

## What stays TEXT and why

A short list, because skipping the surrogate-id pattern always
deserves a justification:

| Column | Why TEXT |
|---|---|
| `workstreams.name` | Globally unique because it IS a tmux session name. No surrogate parent exists. |
| `task_notes.author` | Free-text actor label (`"orchestrator"`, `"user"`, `"π - mu"`, `"system"`). Not always a registered agent. |
| `agent_logs.source` | Same as `task_notes.author`. The logger is publish-side; not an FK relation. |
| `agent_logs.kind` | Open enum (`"message"`, `"event"`, `"broadcast"`, ...). Future kinds need no migration. |
| `agents.cli` | Free-text by design — adding a new CLI must not need a schema change. |
| `agents.tab` | Window name override; cosmetic. |
| `vcs_workspaces.path` | Filesystem path. Naturally TEXT. |
| `vcs_workspaces.parent_ref` | VCS revision identifier (commit hash, branch name). Backend-specific. |
| `snapshots.workstream` | Intentionally NOT an FK — the snapshot must outlive its workstream. |
| `snapshots.label` | Free-text human description. |

Everything else that names an entity becomes:
`<scope_id> INTEGER + <name> TEXT + UNIQUE (scope_id, name)`.

---

## Boundary discipline for the SDK surface

This is a load-bearing pattern, not a stylistic preference. It
goes in `docs/ARCHITECTURE.md` as a top-level seam.

> **Public SDK functions take operator-facing names.**
> **Internal helpers take surrogate ids.**
> **Resolution happens at the public-function entry, exactly once.**

Same boundary discipline as REST: external API uses business
identifiers, internal layer uses primary keys.

```ts
// PUBLIC: takes operator-facing names
export function claimTask(
  db: Db,
  workstream: string,         // operator name
  localId: string,            // operator name
  opts?: ClaimOptions,
): ClaimResult {
  const wsId = resolveWorkstreamId(db, workstream);
  const taskId = resolveTaskId(db, wsId, localId);
  const agentId = resolveCurrentAgentId(db, wsId);
  return claimTaskById(db, taskId, agentId, opts);
}

// INTERNAL: takes surrogate ids; never re-resolves
function claimTaskById(
  db: Db,
  taskId: number,
  agentId: number | null,
  opts: ClaimOptions,
): ClaimResult {
  // pure CAS against tasks.id
}
```

Why exactly once at the boundary:

1. **No double-resolution.** Cheap, but more importantly avoids
   two queries against `workstreams` for the same work.
2. **No mid-function ambiguity.** Once the surrogate ids exist,
   internal helpers don't need to thread the workstream context;
   the FKs make scope implicit.
3. **One place to do error mapping.** `WorkstreamNotFoundError`,
   `TaskNotFoundError`, `AgentNotFoundError` all originate at
   resolve-time, with the operator's input string in the error
   payload. Internal helpers throw on invalid surrogate ids, but
   that's a programmer bug, not an operator-facing condition.

The CLI follows the same pattern at the verb-handler entry: parse
operator input → resolve to ids → call SDK with NAMES (not ids)
because the SDK boundary is the next resolution point. CLI does NOT
short-circuit to internal id-taking helpers. Two layers of
resolution, deliberately, because the CLI runs in a process the
SDK doesn't trust to have already resolved.

---

## Migration strategy: ONE-OFF script + loud-fail hook

**Decision: do NOT extend `src/migrations.ts` with a polished
v4→v5 migrator.** The aggressive plan ships in two pieces:

### Piece 1: `scripts/migrate-v4-to-v5.ts` (NEW)

A one-off script, NOT shipped in `dist/`, NOT imported by any SDK
code. ~80 LOC of straightforward node + better-sqlite3:

1. Open the v4 `mu.db` read-only.
2. Create a fresh `mu.db.new` with the v5 schema (the v5 shape from
   `src/db.ts`).
3. For each entity table in **dependency order** (see
   "Migration table ordering" below for the pinned sequence):
   - `SELECT *` from v4.
   - `INSERT` into v5; capture the new surrogate id.
   - Maintain an in-memory `Map<oldTextPk, newIntId>` for the FK
     rewrites that follow.
4. For each child / FK-bearing table: `INSERT` translating old
   TEXT FKs through the maps.
5. Recreate views (`ready`, `blocked`, `goals`).
6. Bump `schema_version` to 5.
7. `VACUUM`.
8. Verify row counts pre/post per table; abort on mismatch.
9. Rename: `mu.db` → `mu.db.v4-backup-<timestamp>`,
   `mu.db.new` → `mu.db`.

The script must run **without mu being installed** (or with mu
pinned to the pre-v5 version). Pure `node:better-sqlite3` +
`node:fs`, no SDK imports. Self-contained ~150 LOC tops.

Operator runs it once, manually:

```bash
npx tsx scripts/migrate-v4-to-v5.ts            # default: $MU_DB_PATH
npx tsx scripts/migrate-v4-to-v5.ts /path/db   # explicit target
```

After all known operator DBs are migrated, the script can be
deleted in a follow-up commit.

#### Migration table ordering (pinned)

The order matters: child tables MUST come after their parents
because we need the parent's surrogate-id map populated before we
can rewrite the child's TEXT FK. Pin this exact sequence in the
script, with a one-line rationale comment per step:

1. **`workstreams`** — no parents; root of the hierarchy.
2. **`agents`** — parent: `workstreams` (needs the
   `workstream.name → workstream_id` map).
3. **`tasks`** — parents: `workstreams` + `agents` (needs both
   maps; `tasks.owner_id → agents.id` is the second lookup).
4. **`task_edges`** — parent: `tasks` (rewrites
   `from_task` / `to_task` through the `local_id → tasks.id` map;
   composite keying is per-pair, not surrogate).
5. **`task_notes`** — parent: `tasks`.
6. **`agent_logs`** — parent: `workstreams` only (the `source`
   column stays free-text; not an FK).
7. **`vcs_workspaces`** — parents: `agents` + `workstreams` (same
   reasoning as `tasks`).
8. **`approvals`** — parent: `workstreams`.
9. **`snapshots`** — no FK; copy verbatim (the `workstream`
   column stays TEXT by design — see "What stays TEXT and why").
10. **`schema_version`** — single-row meta table; bump to `5` as
    the final step, AFTER every entity table is fully populated
    and verified, so a crashed migration leaves a still-v4 DB
    rather than a half-migrated one labelled v5.

### Piece 2: loud-fail hook in `openDb`

In `src/db.ts`, after `detectExistingSchemaVersion(db)`:

```ts
if (detectedVersion !== null && detectedVersion < 5) {
  throw new SchemaTooOldError(
    `Detected v${detectedVersion} schema; v5 is required.\n` +
    `Run: npx tsx scripts/migrate-v4-to-v5.ts\n` +
    `Then retry your command.`,
  );
}
```

Typed error → exit code 4 (mapped in `cli.ts`'s `classifyError`).
Operators get a clear, single-line instruction; no implicit
data-shape mutation.

### Piece 3 (optional cleanup): drop `src/migrations.ts`

Once v5 is the only live shape, `src/migrations.ts` is dead code:

- The v1→v2 and v2→v3 (and v3→v4) migrations exist only to bring
  long-dormant DBs forward. With the loud-fail hook in place, any
  DB at version < 5 errors out before any migration would run.
- Net delete: ~300 LOC of migration code + ~150 LOC of tests for
  paths that can no longer be reached.

This is filed as `schema_v5_drop_migrations_ts` (optional, ship
when comfortable).

### Why aggressive?

- mu is pre-1.0. There is no third-party operator base; the user
  count is "this developer + a small handful". A polished
  migrator built into `src/` would be over-engineering.
- `migrations.ts` exists because schema_version was an additive
  v3→v4 polish. The infrastructure is overkill for a one-time
  invasive shape change.
- A one-off script can be aggressive: drop tables, recreate views,
  take 10 seconds, never need to handle "what if v4 row count
  exceeds memory" because the operator's DB is small enough to
  fit.
- `scripts/` is already a convention for one-off ops in many
  projects; `src/` stays clean of v4-specific code.

---

## SDK consumer impact

The operator-facing CLI surface does NOT change — `mu task add
design -w wsA` still works verbatim. But the **public SDK
signatures DO change** for every consumer that imports from
`src/index.ts`:

- Every public SDK function that takes an entity name (`addTask`,
  `claimTask`, `getTask`, `closeTask`, `addNote`, `spawnAgent`,
  `getAgent`, ...) gains `workstream: string` as the first
  positional arg (or as part of an opts bag — exact shape lives in
  `schema_v5_sdk_signatures`).
- This is **breaking** for any external SDK consumer. mu's own
  CLI is the only known consumer today, so practical blast radius
  is contained to `schema_v5_cli_boundary` updates. The change is
  called out under **Breaking** in `CHANGELOG.md` when v5 lands.
- `--json` output shape is **preserved**: the CLI emits
  operator-facing names (`workstream`, `local_id`, `agent`, `slug`).
  Surrogate ids stay strictly internal — they never leak into
  `--json`, error payloads, log lines, or markdown exports. Anyone
  scripting against `mu --json` sees zero churn.
- The "could expose `internalId` someday" mention earlier in this
  doc is hereby explicitly downgraded to **never without a real
  consumer asking**. Anti-feature pledge applies: surrogate ids
  are an implementation detail; promoting them to the public
  shape would re-introduce a global namespace through the back
  door.

---

## Snapshot interaction during migration

The migration script renames the v4 DB to `mu.db.v4-backup-<ts>`
before swapping in the v5 file. That backup is the migration's
**escape hatch only** — it is NOT entered into the v5 `snapshots`
table, and `mu undo` / `mu snapshot list` will not see it.

Rationale (the simpler path; the alternative was tracking the
backup as a real snapshot row):

- A v4 snapshot can't be "restored" by the v5 `mu undo` machinery
  in any meaningful sense — the schema differs at the FK level.
  Surfacing it in the snapshot list would only let an operator
  click on something that then errors with a typed
  "v4-snapshot-not-restorable" exception. Cleaner not to surface
  it at all.
- The migration is a one-off script, not a recurring verb.
  Operators run it once per machine; the backup is a safety net
  for the few minutes between "script started" and "first v5
  command worked". After that, the operator deletes the backup
  manually.
- Restore semantics are deliberately manual:

  ```bash
  # If the v5 DB looks broken after migration:
  mv ~/.local/state/mu/mu.db ~/.local/state/mu/mu.db.v5-broken
  mv ~/.local/state/mu/mu.db.v4-backup-<ts> ~/.local/state/mu/mu.db
  # Re-pin mu to the pre-v5 version and continue using v4.
  ```

- The `mu undo` machinery's auto-snapshot hook is NOT triggered
  by `scripts/migrate-v4-to-v5.ts` — the script does not import
  the SDK, so it doesn't go through the destructive-verb hook in
  the first place. Symmetry is preserved: the script is fully
  self-contained, and the snapshot table stays a v5-only concept.

The migration script's README header (top-of-file comment) MUST
spell out the manual-restore procedure verbatim, so an operator
debugging at 2am doesn't have to grep this design doc.

---

## Migration test plan

A single `test/migrate-v4-to-v5.integration.test.ts` (~30 LOC of
fixture + ~80 LOC of assertions). Coverage:

1. **Round-trip every table.** Seed a v4 DB with 1+ row in every
   table (workstreams×2, agents×3 across both, tasks×4, task_edges
   forming a small DAG, task_notes×3, agent_logs×5, vcs_workspaces
   ×2, approvals×2, snapshots×1). Run the script. Assert post-row
   counts match per table.
2. **Cascade behaviour preserved.** Delete a workstream from the
   migrated v5 DB; assert all child rows (agents, tasks, edges,
   notes, logs, workspaces, approvals) cascade. Snapshots row
   intentionally survives.
3. **`SET NULL` on owner.** Migrate a task with an `owner` set;
   delete the agent in the v5 DB; assert `tasks.owner_id` is NULL.
4. **`(workstream_id, name)` uniqueness.** In the v5 DB, attempt to
   `INSERT` a second `agents` row with the same `(workstream_id,
   name)` pair; assert UNIQUE violation.
5. **`(workstream_id, local_id)` uniqueness.** Same shape for tasks.
6. **Cross-workstream `local_id` reuse works.** `INSERT INTO tasks
   (workstream_id, local_id, ...)` with the same `local_id` in two
   different workstreams; assert success.
7. **View bodies still produce correct rows.** `SELECT * FROM
   ready` and `SELECT * FROM blocked` return the same logical
   tasks before-vs-after the migration (compare by
   `(workstream.name, local_id)` since surrogate ids are not
   stable).
8. **`schema_version` ends at 5.**
9. **Loud-fail hook fires.** Open a v4 DB via `openDb()`; assert
   `SchemaTooOldError` thrown; assert exit-code mapping in
   `cli.ts` returns 4.
10. **Production-shape fixture migrates cleanly.** The mu repo's
    own `~/.local/state/mu/mu.db` at the time of writing has 50+
    closed tasks across 5 workstreams (`mufeedback`,
    `roadmap-v0-2`, `infer-rs`, `dogfood-snap`, `ws`). The
    migration script must handle it without crashing.

    Implementation: copy a sanitised export of the operator's
    actual `mu.db` into `test/fixtures/v4-real.db` (sanitisation
    = strip `task_notes.content` bodies and `agent_logs.payload`
    bodies to a fixed placeholder; row counts and FK shape are
    what we care about). Run the script; assert pre/post row
    counts match per table. **CI-skip when the fixture is
    missing** — some contributors won't have it locally, and the
    fixture is too large to commit raw.

    Document the fixture-generation command in the test file
    header so it's reproducible:

    ```bash
    # Regenerate test/fixtures/v4-real.db from the live DB:
    sqlite3 ~/.local/state/mu/mu.db ".backup test/fixtures/v4-real.db"
    sqlite3 test/fixtures/v4-real.db \
      "UPDATE task_notes SET content = '<sanitised>'; \
       UPDATE agent_logs SET payload = '<sanitised>';"
    ```

The test creates the v4 fixture by hand-crafting `CREATE TABLE`
statements (don't import the v4 `CURRENT_SCHEMA` constant — it
will be deleted by the v5 PR). Embed the v4 DDL inline in the test
file as a string constant.

---

## Obsoleted workarounds

The following workarounds become defunct on the v5 landing and
get deleted in `schema_v5_cleanups`:

| Workaround | What goes away |
|---|---|
| `idFromTitle` slugify+collision-loop (`review_code_slugify_collision_truncates`) | No global namespace; collision-loop becomes a 1-line "uniquify within workstream" check. |
| `mu_` reserved-prefix gymnastics in `TaskIdInvalidError` | No global namespace; `mu_foo` is a fine `local_id`. |
| `cross_workstream_claim_for` pre-check in `src/tasks/claim.ts` | The FK from `tasks.owner_id → agents.id` plus per-workstream unique on `(workstream_id, name)` makes cross-ws ownership naturally impossible. The check simplifies back to the FK. |
| `nit_no_task_move_verb` (deferred) | Becomes a typed verb: `mu task move <local_id> --to-workstream <ws>` is `UPDATE tasks SET workstream_id = ?, local_id = ? WHERE id = ?`. Atomic. |
| `lastClaimActor` brittle prefix-match (`review_code_last_claim_actor_brittle`) | Today does prefix-matching against free-text event payloads using `local_id` strings. v5 surrogate-id lookup is exact. |
| Workstream rename via `mu sql "UPDATE workstreams SET name='new' ..."` | Still works, but is now a single-row update with no cascade chain. (Could be promoted to a typed `mu workstream rename` verb in a follow-up.) |
| Long-DB naming-clash hell | Defunct — `local_id` is per-workstream. |

---

## Promotion criteria (from ROADMAP)

| Criterion | Status |
|---|---|
| ≥2 real-user hits | YES — this task itself, `review_code_slugify_collision_truncates`, the reserved-`mu_` gymnastics, `nit_no_task_move_verb`, the brittle `lastClaimActor`, and the `cross_workstream_claim_for` pre-check all stem from this gap. |
| Substrate ready | YES — `schema_version` exists; loud-fail hook is one if-statement; `cross_workstream_claim_for` already taught the codebase to think in `(workstream, name)` tuples. |
| Fits in <300 LOC | NO as a single change, BUT the work decomposes cleanly into 5 follow-up tasks each in scope. The migration script alone is ~80 LOC of new code + ~300 LOC of OLD code to delete (`migrations.ts`). |

→ **Promote for design** (this doc). **Implement in stages** via
the follow-ups below.

---

## Follow-up tasks (filed alongside this doc)

| Task id | Scope | Approx LOC |
|---|---|---|
| `schema_v5_migration_script` | `scripts/migrate-v4-to-v5.ts` + `SchemaTooOldError` + the loud-fail hook in `openDb` + the integration test plan above. | +~80 LOC code, +~110 LOC test |
| `schema_v5_drop_migrations_ts` | Delete `src/migrations.ts` and its tests. Verify no remaining callers. Optional cleanup; ship when comfortable. | -~300 LOC code, -~150 LOC test |
| `schema_v5_sdk_signatures` | Every public SDK function takes `workstream` context (operator name); internal helpers take surrogate ids. ~30 functions, mostly mechanical 1-line changes plus the resolve-at-entry plumbing. | +~50 LOC, +~50 LOC test churn |
| `schema_v5_cli_boundary` | CLI verb handlers resolve operator name → surrogate id at entry (where helpful) but otherwise pass operator names through to the SDK boundary, which does the real resolution. ~30 verbs. | +~10 LOC per verb (mostly imports + error mapping) |
| `schema_v5_cleanups` | Delete `slugify_collision_truncates` workaround, `mu_` prefix gymnastics, `cross_workstream_claim_for` pre-check, brittle `lastClaimActor` prefix-match. Update `docs/ROADMAP.md` and `docs/USAGE_GUIDE.md` workaround table. | net -~80 LOC |

Each follow-up ships under typecheck + lint + test + build green.

---

## Out of scope for this design doc

- The actual migration code (lives in `schema_v5_migration_script`).
- The SDK signature change (lives in `schema_v5_sdk_signatures`).
- The CLI boundary change (lives in `schema_v5_cli_boundary`).
- The workaround cleanups (lives in `schema_v5_cleanups`).
- Any new typed verb that this unblocks (`mu task move`,
  `mu workstream rename`) — they file separately once the
  substrate lands.
- Public --json shape additions (e.g. exposing `internalId`) —
  deferred until a real consumer asks for it.
