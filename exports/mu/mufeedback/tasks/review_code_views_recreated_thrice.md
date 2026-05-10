---
id: "review_code_views_recreated_thrice"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 0.3
roi: 166.67
owner: null
created_at: "2026-05-08T11:30:38.186Z"
updated_at: "2026-05-09T08:26:18.271Z"
blocked_by: []
blocks: []
---

# REVIEW: ready/blocked/goals view DDL duplicated 3x across db.ts + 2 migrations

## Notes (3)

### #1 by code-reviewer-1, 2026-05-08T11:30:38.300Z

```
FILES:
  src/db.ts:407-455 (CURRENT_SCHEMA — ready, blocked, goals views)
  src/migrations.ts:331-365 (v1->v2 inline view recreation)
  src/migrations.ts:425-459 (v2->v3 inline view recreation)

FINDINGS: the three views (ready, blocked, goals) have THREE SQL copies in the codebase: CURRENT_SCHEMA in db.ts plus inlined CREATE VIEW blocks at the end of both migrations. The v2->v3 migration's comment correctly notes "ready/blocked unchanged from v2" — yet the v2 inlined SQL was copy-pasted again. This is the exact 'lock-step with src/db.ts' contract that the migrations file warns about ("CREATE TABLE bodies below MUST stay in lock-step with CURRENT_SCHEMA").

The justification in migrate v1->v2 ("Recreate views inline so the DB is fully usable the moment the migration commits") is real BUT applySchema runs AFTER runMigrations on every openDb (db.ts:97-105). So the post-migration views are immediately overwritten by applySchema's DROP VIEW + CREATE VIEW from CURRENT_SCHEMA. The inline copies are belt-and-suspenders, but they're the wrong belt: they encode a definition that next migration must remember to update independently.

When the next view-touching migration lands (say `goals` adds a CTE), THREE places need editing in lockstep, only one of which (db.ts) is exercised by `mu doctor` / fresh-DB tests.

WHY IT MATTERS: real maintainability hazard. Drift between the three would be silent (since applySchema overwrites at the end), but spotting "hey, migration v3's `goals` view differs from db.ts's" requires diffing SQL by eye. Future migration authors WILL forget one.

SUGGESTED FIX (~30 LOC):
  1. Extract a single `VIEW_DEFINITIONS` constant (or a function returning SQL string) in src/db.ts.
  2. applySchema executes `VIEW_DEFINITIONS`.
  3. Each migration that drops views can call the same constant at the end (`db.exec(VIEW_DEFINITIONS)`) — or simpler still: REMOVE the inline view recreations from migrations entirely. applySchema runs after runMigrations and re-creates them anyway. The "fully usable the moment the migration commits" justification doesn't survive: nothing reads the views between migration COMMIT and applySchema's view-recreation in the same openDb call.
  4. Document the order: applySchema is responsible for view DDL; migrations only touch tables.

ALTERNATIVES CONSIDERED:
  - "stay defensive — keep inline recreates in case applySchema's order ever changes": adds 60 LOC of copy-paste to defend against a hypothetical reorder. Pin the order with a comment + test instead.
  - "extract to per-view named consts": same outcome, slightly more granular; either fine.

EVIDENCE: src/db.ts:96 calls applySchema BEFORE runMigrations on existing DBs, so the post-migration views are shortly replaced. The migration file's own comment at line 331 admits "applySchema also recreates them on every open, but we shouldn't depend on that order" — that "shouldn't" is exactly where 0.1.0 hard-codes that exact order in db.ts:96-105.
```

### #2 by code-reviewer-1, 2026-05-08T11:31:04.491Z

```
CORRECTION to "SUGGESTED FIX" point 3 above: I misread openDb's order. applySchema runs BEFORE runMigrations (db.ts:99-105) and is NOT re-called after. So a migration that drops views to rebuild a table MUST recreate them inline — without that, the views would be gone after openDb returns.

So the legitimate fix is just point 1+2: extract a single VIEW_DEFINITIONS string constant exported from src/db.ts; applySchema runs it; both migrations call `db.exec(VIEW_DEFINITIONS)` at the end of their dance instead of inlining ~25 lines of CREATE VIEW SQL each.

The SQL is still triplicated today (db.ts + v1->v2 + v2->v3), so the maintainability hazard is real — adding a fourth migration that drops views means a fourth copy unless this is fixed first. Just smaller scope (~15 LOC, not 30) than I originally claimed.
```

### #3 by worker-mf-2, 2026-05-09T08:25:55.227Z

```
DONE.

DIFF AUDIT FIRST: byte-compared the three view-DDL sites.
  - ready: identical across all three (db.ts, migrateV1ToV2, migrateV2ToV3).
  - blocked: identical across all three.
  - goals: db.ts == migrateV2ToV3 (v3 shape: status NOT IN ('CLOSED','REJECTED','DEFERRED')); migrateV1ToV2 differs (v2 shape: status <> 'CLOSED'). The v1->v2 inline goals body really IS historical — represents the v2 schema shape before REJECTED + DEFERRED existed.

FIX (extract w/ historical-faithfulness):
  src/db.ts now exports three constants:
    READY_VIEW_SQL, BLOCKED_VIEW_SQL, GOALS_VIEW_SQL
  Each is a "DROP VIEW IF EXISTS … ; CREATE VIEW … AS …;" string. CURRENT_SCHEMA's "-- ─── Views ─── " block is now ${READY_VIEW_SQL}
${BLOCKED_VIEW_SQL}
${GOALS_VIEW_SQL} — single source of truth.

  migrations.ts:
    - migrateV2ToV3: imports + db.execs all three constants. v3 IS the current shape so this is safe and historically correct.
    - migrateV1ToV2: imports + db.execs READY_VIEW_SQL + BLOCKED_VIEW_SQL (those view shapes are stable across versions), but KEEPS its inline CREATE VIEW goals AS … status <> 'CLOSED' … body. Rewriting it to use GOALS_VIEW_SQL would retroactively change what v2 looked like — exactly the "don't rewrite history" trap the task notes warned about.

  The legitimate concern from notes#309 ("when the next view-touching migration lands, three places need editing in lockstep") is now: when goals' shape evolves, you bump GOALS_VIEW_SQL once in db.ts; the new migration db.exec(GOALS_VIEW_SQL) automatically picks it up; migrateV1ToV2 / migrateV2ToV3 keep emitting their respective historical shapes (correct).

WHAT I DIDN'T DO:
  - No new file (src/views.ts) — three exports in db.ts is sufficient, and the constants live next to CURRENT_SCHEMA where the comment context is.
  - No versioned migration registry / no per-version constants snapshot. Per anti-feature pledges + ROADMAP guidance.
  - No ALTER to applySchema's order, no merge of migration steps, no removal of the inline view rebuilds (they're load-bearing — applySchema runs BEFORE runMigrations per db.ts:99-105, as notes#310 corrects).

EVIDENCE / GATES:
  - typecheck: clean
  - lint: clean (biome check passed, no fixes applied)
  - tests: 765 pass / 2 fail. The 2 fails (claimTask --self resolves actor from \$TMUX_PANE / \$USER in test/tasks.test.ts) are PRE-EXISTING on a4febdd HEAD — confirmed via 'git stash && npm run test test/tasks.test.ts' → same 2 fails. They're env-dependent (test env runs inside a mu-spawned tmux pane where TMUX_PANE/USER stubs collide with the real values). Unrelated to view DDL.
  - build: clean (ESM + DTS green)
  - live verify: fresh DB at /tmp/mu-views-smoke.db → mu doctor reports schema OK, schema_version 4, 10 tables. sqlite3 .schema ready/blocked/goals shows all three views present with correct SQL bodies (ready = CLOSED-only, blocked = CLOSED-only, goals = CLOSED+REJECTED+DEFERRED — matching the v3 shape).
  - existing test/db.test.ts (32 tests, all passing) covers v1->v2 + v2->v3 migrate paths from a fabricated v1 DB through to current.

CHANGELOG: entry added under [Unreleased] → Changed.

DIFFSTAT: CHANGELOG.md +24, src/db.ts net +44 (mostly comment block explaining the three-constant + historical-faithfulness pattern), src/migrations.ts net -36 (the two ~25-line inline view blocks collapse to db.exec calls). Net ~24 net new SLOC in production code, well under the 30 LOC suggestion in notes#309 and even closer to the 15 LOC revised in notes#310.
```
