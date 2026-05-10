---
id: "schema_surrogate_pks_for_global_uniqueness"
workstream: "mufeedback"
status: CLOSED
impact: 75
effort_days: 2
roi: 37.50
owner: null
created_at: "2026-05-09T08:36:41.605Z"
updated_at: "2026-05-09T10:41:39.080Z"
blocked_by: []
blocks: ["audit_verbs_typed_vs_sql", "docs_staleness_review_capstone", "review_code_last_claim_actor_brittle", "schema_v5_migration_script"]
---

# schema: surrogate INTEGER ids as the universal PK pattern across all tables; TEXT names become per-scope-unique attributes

## Notes (3)

### #1 by π - mu, 2026-05-09T08:37:58.041Z

```
═══ THE GAP ═══

Current schema (src/db.ts):

  tasks       PK = local_id TEXT                    ← GLOBAL, not local
  agents      PK = name TEXT
  workstreams PK = name TEXT
  task_edges  FK = (from_task, to_task) TEXT TEXT
  task_notes  FK = task_id TEXT
  vcs_workspaces FK = agent TEXT
  approvals   FK = workstream TEXT

`tasks.local_id` is named "local" but is actually a GLOBAL primary key. Same misnaming pressure for agents.name (one mu DB → one global agents namespace) and workstreams.name (already genuinely global, but the cross-coupling is what hurts).

═══ WHY THIS BITES ═══

1. **The name lies.** Operators see `local_id` and assume it's scoped to the workstream — pick the same id `design` in two different workstreams, mu rejects with `TaskExistsError`. We've seen this (snap_design + snap_dogfood etc. all had to be globally-unique-prefixed).

2. **Long-lived DB across many workstreams = naming clash hell.** This very DB is now pushing 50+ closed tasks in mufeedback, 40+ in roadmap-v0-2. As the operator runs more workstreams over time, the global namespace fills with task ids that have to remain unique forever (auto-snapshot keeps them around even after destroy + undo). idFromTitle's slugify+collision-loop (review_code_slugify_collision_truncates) tries to cope, but it's a workaround for a schema decision.

3. **`mu task add design -w wsA` then `mu task add design -w wsB` should just work** — they're different tasks in different scopes. Today the second one collides.

4. **Renames are painful.** `mu sql "UPDATE workstreams SET name='new' WHERE name='old'"` works because of ON UPDATE CASCADE — but EVERY child table has a TEXT cascade that has to fire. With surrogate IDs, the rename is a single workstreams.name UPDATE, no cascade needed.

5. **The `mu_` reserved-prefix gymnastics** (TaskIdInvalidError sanitises a leading `mu_` → `t_mu_`) is also a workaround for a global namespace concern that wouldn't exist if local_id were truly local.

6. **Cross-workstream task move/copy** (nit_no_task_move_verb, deferred): impossible to implement cleanly today because moving `design` from wsA to wsB might collide with a `design` already in wsB. With surrogates, move = UPDATE tasks SET workstream = ?, local_id = ? WHERE id = ?. Atomic.

7. **Agent re-spawn under the same name** (currently allowed AFTER close) preserves history attribution by accident — agents.name is FK'd everywhere. With surrogate ids, the same operator-facing name can re-occur cleanly across time without confusion ("which 'reviewer-1' was this note from?").

═══ THE PROPOSED SCHEMA SHAPE ═══

  workstreams (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE NOT NULL,        -- operator-facing, mutable
    created_at  TEXT NOT NULL,
    -- ... existing cols
  )
  
  tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,    -- surrogate, internal
    workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
    local_id     TEXT NOT NULL,                         -- TRULY local now
    title        TEXT NOT NULL,
    -- ... existing cols
    UNIQUE (workstream_id, local_id)                    -- per-workstream uniqueness
  )
  
  agents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE,
    name          TEXT NOT NULL,                         -- per-workstream unique
    -- ... existing cols
    UNIQUE (workstream_id, name)
  )
  
  task_edges (
    from_task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    to_task_id   INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    -- ... existing
  )
  
  task_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    -- ...
  )
  
  vcs_workspaces (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     INTEGER NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    -- ...
  )
  
  approvals, agent_logs ... same shape

═══ THE COST ═══

1. **Forward-only migration**, the FIRST non-additive one. v4 → v5 (schema_version table already exists; precedent set by snap_undo work).

   Migration shape:
     - Add new INTEGER id columns + UNIQUE indexes.
     - Backfill ids from existing rows (deterministic order).
     - Add new FK columns alongside the old TEXT FKs.
     - Backfill new FKs by joining against the TEXT FKs.
     - Drop old TEXT-FK columns.
     - Drop & recreate views (ready/blocked/goals reference task PKs).
     - Migrate task_edges in-place.
   
   ~200-300 LOC of migration + a careful test that verifies the v4→v5 transition preserves every row.

2. **CLI surface MUST NOT CHANGE.** Operators still `mu task claim design`. The CLI resolves `design` → tasks.id at the boundary; the SDK takes the resolved id. Public --json shape preserves localId; surrogate id stays internal (or surfaces optionally as `internalId`).

3. **Every SDK function** that takes `(localId: string)` becomes `(workstreamName: string, localId: string)` OR resolves via context. All ~30 SDK functions. The `local_id` resolution becomes the FIRST step of every verb. This is real surface pressure but mostly mechanical.

4. **lastClaimActor** (review_code_last_claim_actor_brittle) does prefix-matching against free-text event payloads using local_id strings — would need rethinking against surrogate ids OR the (workstream, local_id) tuple.

5. **Tests touch a LOT of insert helpers** that use insertAgent / addTask with name/local_id args. Mostly mechanical updates.

6. **The cross_workstream_claim_for fix** (just shipped) is INVALIDATED by this schema — agents.name no longer needs the workstream pre-check because (workstream_id, name) is unique-per-ws and the FK from tasks.owner_id → agents.id naturally restricts. The check in src/tasks/claim.ts can simplify back to just the FK.

═══ ALTERNATIVES CONSIDERED ═══

A. **Composite PK `(workstream, local_id)`** — keep TEXT PKs but make them composite. Pro: smaller migration, no surrogates. Con: every FK becomes 2-column too; FK from agent_logs.task → tasks needs both columns; readability drops; sqlite handles composite PK FK fine but the boilerplate climbs. **Reject** — surrogates are cleaner and more idiomatic SQLite.

B. **Status quo + better validation** — keep TEXT PK, add a CHECK or trigger that rejects `mu_` etc. **Reject** — the underlying problem (global namespace forced on per-workstream concept) doesn't go away.

C. **Sharded DBs per workstream** — one mu.db per workstream. **Reject** — kills cross-workstream queries (mu agent owned-by, mu sql joins, mu workstream list); destroys the snapshot story.

D. **Name workspaces uniquely via prefixing convention** (current de-facto state) — operator says "I'll just prefix every task with the workstream name". **Reject** — operators forget; tooling shouldn't punt to convention.

═══ PROMOTION CRITERIA ═══

  ≥2 real-user hits: 
    - This task itself, surfaced live.
    - review_code_slugify_collision_truncates (still open in deferred) — collision-loop is a workaround for global namespace.
    - The reserved `mu_` prefix gymnastics in TaskIdInvalidError (just shipped).
    - nit_no_task_move_verb (still deferred) — blocked by exactly this gap.
  YES, ≥2 hits.

  Substrate ready: schema_version table exists; migrations.ts has 2 prior migrations as precedent; the cross_workstream_claim_for fix already taught the codebase to think in (workstream, name) tuples.
  YES.

  Fits in <300 LOC: NO. This is a multi-day, multi-commit refactor. The migration alone is ~150-200 LOC + 100 LOC of tests; SDK signature updates are ~50 LOC across ~30 functions but each is a 1-line change; CLI boundary resolution is ~10 LOC at the entry of each verb.

  But the breakage is contained — schema migration is forward-only and well-scoped; SDK changes are mechanical; CLI doesn't change for users.

  → PROMOTE FOR DESIGN, IMPLEMENT IN STAGES. This task is the design-anchor; smaller follow-ups land the schema migration, then the SDK surface change, then the CLI boundary, then the cleanups (review_code_slugify_collision_truncates becomes obsolete, nit_no_task_move_verb becomes shippable).

═══ OUT OF SCOPE / FOLLOW-UPS THIS BLOCKS ═══

Once the surrogate-id schema lands:
  - nit_no_task_move_verb → typed `mu task move <id> --to-workstream <ws>` becomes safe (no id collision risk).
  - review_code_slugify_collision_truncates → defunct (no global collision concern).
  - cross_workstream_claim_for pre-check → simplifies to just the FK (composite UNIQUE makes the cross-ws case naturally impossible).
  - lastClaimActor brittle prefix-match → revisit; the surrogate id lookup is exact.
  - agent re-spawn semantics → cleaner (each spawn is a new agents row with new id; old name can re-occur safely).

═══ PLAN OF ATTACK (next-actions) ═══

Phase 1: write the design doc. Output: docs/SCHEMA_v5_DESIGN.md committed; this task transitions to "design done" not "shipped".
Phase 2: file 4 follow-up tasks (one each):
  - schema_v5_migration_impl  (the migrations.ts work + db.ts schema)
  - schema_v5_sdk_signatures  (all SDK functions take workstream context)
  - schema_v5_cli_boundary    (CLI resolves localId → surrogate at entry)
  - schema_v5_cleanups        (delete now-defunct workarounds)
  Each phase ships under typecheck+lint+test+build green.

═══ THIS TASK ═══

Lands the design doc (Phase 1) only. Implementation lives in the follow-ups. ~0.5 days of design writing + the 4 follow-ups filed; the bulk implementation effort (~2 days) sits in the children.

DELIBERATE OVER-ESTIMATION ABOVE: marked effort-days=2 for THIS task to reflect total expected work including phase children, since the orchestrator's ROI comparison should account for the real cost. If it lands as design-only the closer can update effort to 0.5.

═══ NEXT ═══
Operator decides: ship the design? defer? reject?
```

### #2 by π - mu, 2026-05-09T08:39:03.567Z

```
ESCALATION (per operator): this is a SCHEMA-WIDE PATTERN, not a one-table fix.

═══ THE PATTERN, RESTATED ═══

EVERY persistent entity table in mu's schema gets:

  (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,   -- surrogate, internal
    <scope_id>    INTEGER NOT NULL REFERENCES <parent>(id) ON DELETE CASCADE,
    <name>        TEXT NOT NULL,                        -- operator-facing, mutable
    -- ... domain attributes
    UNIQUE (<scope_id>, <name>)                         -- per-scope unique
  )

EVERY foreign key references <child>.<parent>_id (INTEGER), never the TEXT name.

The TEXT name is now JUST an operator-facing attribute — searchable, displayable, renamable cheaply. The surrogate id is the identity.

═══ FULL TABLE ROSTER (current schema; what each becomes) ═══

  workstreams       PK = id INTEGER (was: name TEXT). 
                    UNIQUE (name) — workstream names stay globally unique because they're tmux session names.
                    No <scope_id> — workstreams are top-level.

  agents            PK = id INTEGER (was: name TEXT).
                    workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE.
                    UNIQUE (workstream_id, name) — agent name unique PER WORKSTREAM.

  tasks             PK = id INTEGER (was: local_id TEXT — finally honest).
                    workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE.
                    owner_id INTEGER REFERENCES agents (id) ON DELETE SET NULL.
                    UNIQUE (workstream_id, local_id).

  task_edges        PK = (from_task_id, to_task_id) — both INTEGER FKs to tasks (id).
                    No surrogate id needed (the composite pair IS the identity for an edge).

  task_notes        PK = id INTEGER (already had AUTOINCREMENT — pattern is already correct).
                    task_id INTEGER NOT NULL REFERENCES tasks (id) ON DELETE CASCADE.
                    Currently task_id is TEXT FK; becomes INTEGER FK.

  agent_logs        PK = seq INTEGER PRIMARY KEY AUTOINCREMENT (already correct).
                    workstream column TEXT becomes workstream_id INTEGER REFERENCES workstreams (id).
                    source TEXT (free-text actor) STAYS TEXT — it's not always a registered agent name (could be "orchestrator", "system", "user", "π - infer-rs").

  vcs_workspaces    PK = id INTEGER AUTOINCREMENT (today: agent TEXT PK).
                    agent_id INTEGER NOT NULL REFERENCES agents (id) ON DELETE CASCADE.
                    UNIQUE (agent_id) — at most one workspace per agent today (1:1).

  approvals         PK = id INTEGER (today: slug TEXT PK).
                    workstream_id INTEGER NOT NULL REFERENCES workstreams (id) ON DELETE CASCADE.
                    UNIQUE (workstream_id, slug) — slug becomes per-workstream unique (today is global).
                    Operators reference approvals by slug, not by id; CLI resolves slug → id at boundary.

  schema_version    Stays as-is (single-row config table; no FK relevance).

═══ THE CONSEQUENCES, AS A PATTERN ═══

1. **Mutable names are cheap.** Renaming a workstream is a single workstreams.name UPDATE, no cascade chain firing. Renaming an agent is one row update. Renaming a task's local_id is a single tasks.local_id UPDATE.

2. **Per-scope namespaces are honest.** `local_id`, `agent.name`, `approval.slug` all mean what they say: unique within their scope, not globally.

3. **CLI surface unchanged.** Operators still type `mu task claim design`, `mu approve grant feature_x`, `mu agent send worker-1 "..."`. The CLI resolves the operator-facing name to the surrogate id at the verb's entry; the SDK takes the resolved id. Public --json shape preserves the operator-facing name (no `internalId` exposed unless explicitly opted into via a future flag).

4. **Cross-scope queries become trivial.** `mu sql` joins on integer FKs are clean; the recursive CTE for tree-walking blockers becomes simpler (no compound key gymnastics).

5. **History across destroy+undo is preserved cleanly.** Snapshots already preserve everything; surrogate ids preserve identity across the round-trip without the "but the workstream name was reused..." worry.

═══ THE UNIFIED MIGRATION PLAN (v4 → v5) ═══

ONE migration file (the FIRST non-additive one), executed in a single transaction:

Step 1 — for each entity table:
  a. Create new table with surrogate id schema (`tasks_v5`, etc).
  b. INSERT INTO new SELECT FROM old, generating ids. Order by created_at to keep monotonic.
  c. Build a (old_text_pk → new_int_id) lookup table in temp memory (or a temp SQLite table) for the FK rewrites.

Step 2 — for each child table (FK side):
  a. Create new table with INTEGER FKs.
  b. INSERT joining against the lookup tables to translate old text FKs → new integer FKs.
  
Step 3 — drop all old tables; rename new tables to canonical names.

Step 4 — recreate views (ready, blocked, goals) against the new tasks shape.

Step 5 — bump schema_version. Verify row counts pre/post.

Total migration code: ~250-350 LOC. Tested with a real seed-then-migrate-then-assert-roundtrip integration test.

═══ THE SDK SURFACE CHANGE, AS A PATTERN ═══

Every SDK read/write that today takes a TEXT id becomes one of:
  - takes the operator-facing name + workstream context → resolves at function entry (the "boundary" pattern).
  - takes a surrogate id directly (for internal callers that already have it).

Recommend: ALL public SDK functions take operator-facing names; INTERNAL helpers take surrogate ids. Document this in ARCHITECTURE.md as a load-bearing pattern.

  // PUBLIC: takes operator names
  export function claimTask(db: Db, workstream: string, localId: string, opts?): ClaimResult
  
  // INTERNAL helper, used by claimTask after id resolution:
  function claimTaskById(db: Db, taskId: number, agentId: number | null, opts): ClaimResult

This is the same boundary discipline as REST: external API uses business identifiers, internal layer uses primary keys.

═══ THE OBSOLETE-MADE-BY-THIS-LANDING (concrete debt repaid) ═══

  - review_code_slugify_collision_truncates → defunct (no global namespace).
  - nit_no_task_move_verb → unblocked (move = update workstream_id; uniqueness checked on (ws_id, local_id)).
  - cross_workstream_claim_for pre-check (just shipped) → simplifies: the FK from tasks.owner_id → agents.id naturally restricts because agents.workstream_id is in scope.
  - The "reserved mu_ prefix" gymnastics → defunct (no global namespace concerns).
  - Long-DB naming-clash hell → defunct.
  - Renames-are-painful → defunct (single-row UPDATEs; no cascade chains).

═══ PROMOTION, AS A PATTERN ═══

Promoting "every entity gets a surrogate id" buys MORE than promoting "tasks get a surrogate id":
  - Consistency: operators learn one mental model, not "tasks have local_id, agents have name, approvals have slug, workspaces are keyed by agent name".
  - Refactor cost is higher upfront but lower per-table; doing them all together avoids two rounds of migration + two rounds of SDK churn.
  - Schema review surface is one pattern, not seven.

═══ REVISED EFFORT ═══

Was 2 days for the tasks-only migration; the all-tables migration is ~3-4 days realistic (the migration code itself, all-FK rewrites, ~40 SDK function signatures, CLI boundary in ~30 verbs, test updates, docs updates). Still fits the v0.2 promotion criterion (substrate is ready; pillar refactor IS the substrate change; pattern locks consistency).

═══ DELIVERABLE OF THIS TASK ═══

A schema design doc at docs/SCHEMA_v5_DESIGN.md (NOT just the migration spec — the PATTERN spec). Includes:
  - The 6-line pattern restatement (above)
  - One section per current table showing the v4 → v5 transformation
  - The boundary discipline for the SDK surface
  - The migration plan
  - The list of obsoleted workarounds
  - A "what stays TEXT and why" subsection (workstreams.name globally unique because tmux; agent_logs.source free-text; etc)
  - A migration test plan (round-trip every table; sample data covers cascade + SET NULL behaviour)

Then 4 follow-up tasks filed (schema_v5_migration_impl, schema_v5_sdk_signatures, schema_v5_cli_boundary, schema_v5_cleanups) each ~0.5-1 day.

═══ NEXT ═══

Operator approves the pattern? File the design phase as the work. Or defer the whole stack and live with TEXT keys until the namespace pain forces it (the staleness-of-this-bug clock is now ticking — mufeedback alone has 50+ task ids in the global namespace).
```

### #3 by π - mu, 2026-05-09T08:39:39.630Z

```
ADDENDUM: aggressive migration strategy.

Per operator: don't build sophisticated migration infrastructure. Write a ONE-OFF copy script and ship.

═══ THE AGGRESSIVE PLAN ═══

Recommend: do NOT extend src/migrations.ts with a polished v4→v5 migrator. Instead:

  scripts/migrate-v4-to-v5.ts (NEW, one-off, NOT shipped in dist/)
  
    - Opens the v4 mu.db (read-only).
    - Creates a fresh v5 mu.db.new (empty schema = the v5 shape, declared in src/db.ts).
    - For each entity table, in dependency order:
        SELECT every row from v4
        INSERT into v5 with surrogate id assignment
        Maintain (old_text_pk → new_int_id) map in memory.
    - For each child / FK table: INSERT translating FKs through the maps.
    - VACUUM the new DB.
    - Verify row counts match.
    - Rename: mu.db → mu.db.v4-backup, mu.db.new → mu.db.
  
  Then commit this script alongside the v5 schema in src/db.ts. Operator runs it once, manually:
    
    npm run migrate:v4-to-v5    # OR: npx tsx scripts/migrate-v4-to-v5.ts
  
  After all known operator DBs are migrated, the script can be deleted in a follow-up commit.

═══ WHY THIS IS BETTER (RIGHT NOW) ═══

  - mu is pre-1.0. There is no third-party operator base; the user count is "this developer + however many of you are reading this".
  - migrations.ts already only exists because schema_version was a v3→v4 polish. The infrastructure is overkill for a one-time invasive shape change.
  - A one-off script can be aggressive: drop tables, recreate views, take 10 seconds, and never need to handle "what if v4 row count exceeds memory" because the operator's DB is small enough to fit.
  - The script lives in scripts/ (already a convention for one-off ops in many projects); src/ stays clean of v4-specific code.
  - When the script ships and runs, src/migrations.ts can DROP its v3→v4 step entirely if convenient — the v4 shape no longer exists in any live DB. (Optional cleanup; see below.)

═══ THE VARIANT: GO ALL THE WAY AGGRESSIVE ═══

If we accept "any operator on a v4 DB MUST run the migration script before upgrading", we can:

  - DROP src/migrations.ts entirely. The src/db.ts CREATE-IF-NOT-EXISTS block ships only the v5 shape; on a fresh DB it just creates v5; on a v4 DB the openDb path errors loud with "v4 schema detected; run scripts/migrate-v4-to-v5.ts" (one line check, not a full migration framework).
  - This kills the migration debt on the spot. mu is back to a single-source-of-truth schema in src/db.ts.
  - Cost: anyone who skips the migration script gets a clear error. Acceptable for pre-1.0.

  Recommend the variant. Migration code is COMPLEXITY DEBT; one-off scripts plus a hard-fail loud error is THE simpler shape.

═══ DELIVERABLE UPDATE ═══

The design doc (docs/SCHEMA_v5_DESIGN.md) gains a "MIGRATION STRATEGY: one-off script + loud-fail" section that codifies this. The follow-up plan changes:

  Was:
    schema_v5_migration_impl     — extend migrations.ts (~200 LOC + tests)
    schema_v5_sdk_signatures
    schema_v5_cli_boundary
    schema_v5_cleanups
  
  Becomes:
    schema_v5_migration_script   — scripts/migrate-v4-to-v5.ts + the loud-fail hook in openDb (~80 LOC + a ~30 LOC integration test that creates a v4 DB, runs the script, asserts v5 shape + row counts).
    schema_v5_drop_migrations_ts — delete src/migrations.ts entirely (~ -300 LOC; verify v3→v4 callers no longer exist; one cleanup test). Optional, ship when comfortable.
    schema_v5_sdk_signatures     — unchanged
    schema_v5_cli_boundary       — unchanged
    schema_v5_cleanups           — unchanged (delete the now-defunct workarounds)

  Net: phase 1 (the migration) shrinks from ~250 LOC to ~80 LOC of NEW code + a delete of ~300 LOC of OLD code.

═══ CAVEATS ═══

  - The script has to be runnable WITHOUT mu being installed (or with mu pinned to the pre-v5 version). Recommend pure node:better-sqlite3 + node:fs, no SDK imports. Self-contained ~150 LOC tops.
  - The loud-fail hook in openDb is just: if (schema_version_row?.version < 5) throw new SchemaTooOldError("run scripts/migrate-v4-to-v5.ts then retry"). Typed error → exit 4.
  - We commit the v4 backup as mu.db.v4-backup automatically; operator can rm when comfortable.

═══ NEXT ═══

This addendum is aggressive enough that it changes the cost-benefit math for the whole task: the WHOLE schema-pattern landing is now closer to ~2 days realistic instead of ~3-4. Operator's call on whether to ship the design + script + cleanups in one push or sequence them.
```
