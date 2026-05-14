---
id: "schema_v8"
workstream: "multimachine"
status: CLOSED
impact: 60
effort_days: 0.5
roi: 120.00
owner: null
created_at: "2026-05-14T08:05:03.471Z"
updated_at: "2026-05-14T08:30:10.491Z"
blocked_by: ["roadmap_entry"]
blocks: ["db_export"]
---

# Schema v8: machine_identity + workstream_sync tables

## Notes (4)

### #1 by "π - mu", 2026-05-14T08:06:14.321Z

```
TASK
====
Bump schema to v8. Add two tables that enable cross-machine drift detection.

NEW TABLES
==========
1. machine_identity (singleton-ish; one row gets seeded on first openDb after upgrade):
     id          INTEGER PRIMARY KEY CHECK (id = 1)   -- enforces single row
     machine_id  TEXT NOT NULL                        -- random uuid (crypto.randomUUID)
     hostname    TEXT                                 -- os.hostname() at seed time, advisory only
     created_at  TEXT NOT NULL

2. workstream_sync (per-workstream sync state):
     workstream_id        INTEGER PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE
     last_known_peer_seqs TEXT NOT NULL DEFAULT '{}'  -- JSON: {machine_id: seq_at_last_sync}

WORK
====
- Bump CURRENT_SCHEMA_VERSION in src/db.ts from 7 to 8.
- Add CREATE TABLE IF NOT EXISTS blocks for both new tables (idempotent, additive — same shape as v5→v6).
- Mirror the new shape in CURRENT_SCHEMA constant.
- Seed machine_identity row in openDb() AFTER applySchema runs IF table is empty. Use crypto.randomUUID() and os.hostname().
- workstream_sync rows are created on-demand by db sync code, NOT pre-seeded.
- No migration script needed (purely additive).

TEST COVERAGE
=============
- test/db.test.ts:
  - openDb on fresh DB at v8 seeds exactly one machine_identity row with valid uuid.
  - openDb is idempotent: opening twice does not create a second row.
  - Pre-v8 DBs are still rejected with SchemaTooOldError (existing behaviour).
  - workstream_sync starts empty.
- A new test/db-sync-schema.test.ts is OK if cleaner.

FILES
=====
- src/db.ts                 (schema + openDb seed)
- test/db.test.ts           (extend existing tests)

OUT OF SCOPE
============
- Any export/import logic.
- Any new SDK functions other than the seed.

CONSTRAINTS
===========
- LOC cap +50 in src/db.ts is comfortable.
- ESM, no `any`, no non-null assertions.
- Run `npx biome check --write src test` before committing.

VERIFY
======
- npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build

⚠️ FINAL ACTION
==============
git commit -am 'schema: v8 — machine_identity + workstream_sync (multi-machine sync substrate)' THEN
mu task close schema_v8 -w multimachine --evidence '<sha> src/db.ts +N lines, tests pass'
```

### #2 by "π - mu", 2026-05-14T08:10:23.871Z

```
CLARIFICATION: workstream PK is NOT cross-machine
=================================================
workstreams.id stays local-autoincrement. The UNIQUE constraint on workstreams.name is the cross-machine identity. Don't add a globally-unique workstream uuid — it would be a new vocab term for a problem we don't have.

machine_identity SEED REQUIREMENT
=================================
Seed the row in openDb() AFTER applySchema returns, gated on `(SELECT COUNT(*) FROM machine_identity) = 0`. Use crypto.randomUUID() and os.hostname(). This must run on every openDb() call (not just freshly-created DBs) because a DB created on schema v7 and upgraded in-place to v8 must also pick up an identity.
```

### #3 by "π - mu", 2026-05-14T08:22:10.077Z

```
You are worker-1 in workstream `multimachine`. Claim is set on you.

YOUR TASK: schema_v8

STEP 1 — read the design context end-to-end before touching any code:
  mu task notes umbrella -w multimachine
  mu task notes schema_v8 -w multimachine

The schema_v8 task note is the spec. The umbrella note has the broader design (why we need machine_identity + workstream_sync, how clean-machine import works, etc).

STEP 2 — read the existing schema and `openDb()`:
  Read src/db.ts end to end. Note the `applySchema(db)` block, `CURRENT_SCHEMA_VERSION`, and `CURRENT_SCHEMA`. Note the v6 → v7 bump as a recent example.

STEP 3 — implement per the task note. Summary:
  - Bump CURRENT_SCHEMA_VERSION 7 → 8.
  - Add CREATE TABLE IF NOT EXISTS for `machine_identity` (single-row CHECK id=1; uuid + hostname + created_at) and `workstream_sync` (workstream_id PK FK CASCADE; last_known_peer_seqs TEXT NOT NULL DEFAULT '{}').
  - Mirror in CURRENT_SCHEMA.
  - In openDb(), AFTER applySchema runs, seed machine_identity if (SELECT COUNT(*) FROM machine_identity) = 0. Use crypto.randomUUID() and os.hostname().
  - workstream_sync rows are NOT pre-seeded; they're created on-demand by db_import later.

STEP 4 — tests in test/db.test.ts (extend existing):
  - openDb on fresh DB at v8 seeds exactly one machine_identity row with valid uuid (regex test).
  - openDb is idempotent: opening twice does not insert a 2nd row.
  - Pre-v8 DBs still rejected with SchemaTooOldError (existing behaviour stays green).
  - workstream_sync starts empty after openDb.
  - A v7 DB upgraded in-place to v8 (simulate by writing v7 schema, then opening) DOES seed machine_identity.

STEP 5 — clean up:
  npx biome check --write src test

STEP 6 — verify ALL FOUR GREENS + bundle smoke:
  npm run typecheck
  npm run lint
  npm run test:fast
  npm run test
  npm run build
  node dist/cli.js --help    # bundle smoke; silent stderr = top-level await deadlock; see HANDOVER Gotcha 1

STEP 7 — commit (single commit):
  cd /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1
  git add -A
  git commit -m 'schema: v8 — machine_identity + workstream_sync (multi-machine sync substrate)'

⚠️ FINAL ACTION
==============
After commit + 4-green verify clean, run EXACTLY:

  mu task close schema_v8 -w multimachine --evidence '<sha> src/db.ts +N lines, all four greens, bundle smoke ok'

CONSTRAINTS
- Workspace: /Users/mtrojer/.local/state/mu/workspaces/multimachine/worker-1 (just refreshed; HEAD is fresh main with the ROADMAP entry on it)
- ESM, strict types, no `any`, no non-null assertions.
- LOC: aim < 50 net added in src/db.ts.
- Single commit. No CHANGELOG (deferred to docs_pass).
- Biome auto-fix is fine (`npx biome check --write`); never `--write --unsafe`.
- DO NOT touch any other file beyond src/db.ts and test/db.test.ts (or a new test/db-sync-schema.test.ts if cleaner).

COORDINATION WARNING
- worker-2 is in parallel on `archive_restore`. They are touching DIFFERENT files (src/archives*, src/cli/archive.ts). No file overlap; no merge conflict expected. CHANGELOG.md is NOT touched in this task.
```

### #4 by "worker-1", 2026-05-14T08:30:10.491Z

```
CLOSE: 22b56d3 src/db.ts +36 net lines, all four greens, bundle smoke ok
```
