---
id: "review_test_migration_rollback_stub"
workstream: "mufeedback"
status: CLOSED
impact: 75
effort_days: 0.5
roi: 150.00
owner: null
created_at: "2026-05-08T11:22:26.702Z"
updated_at: "2026-05-08T11:57:30.355Z"
blocked_by: []
blocks: []
---

# REVIEW: db.test.ts schema-rollback test is empty (asserts nothing)

## Notes (1)

### #1 by test-reviewer-1, 2026-05-08T11:22:40.588Z

```
FILES: test/db.test.ts:710-737 ; src/db.ts:155-170 (openDb migration loop) ; src/migrations.ts (runMigrations + transaction)
WHAT THE TEST CLAIMS: it("rolls back the schema_version bump when the migration body throws (regression test)", ...)
WHAT IT ACTUALLY VERIFIES: nothing. The test body is a 22-line comment ending in "Skipping." with zero `expect()` calls. Vitest treats it as a PASSING test.
GAP: A regression where a failed migration commits the schema_version bump anyway (leaving a corrupt DB stamped at the new version) would not be caught. The test is named like a guarantee but provides none.
WHY IT MATTERS: This is exactly the kind of "false confidence" the test-reviewer skill flags first. Schema migrations are the highest-blast-radius change class in mu (a half-applied v2->v3 leaves users unable to open the DB at all). The "regression test" label in the it() title makes a future maintainer trust this guard exists when it does not.
SUGGESTED FIX: Either delete the stub (with a TODO in src/migrations.ts), or actually exercise rollback. The latter is cheap: export an internal-only `runMigrationsWithExtra(db, [{ from, to, up: () => { throw }}])` test seam, fabricate a v2 DB, and assert that after the throw `SELECT version FROM schema_version` is still 2 AND none of the migration's intermediate writes (e.g. a CREATE TABLE the bad migration began with) are visible. Concretely: register a migration that creates table `_canary` then throws — afterwards assert (a) schema_version unchanged AND (b) sqlite_master has no `_canary` row (transaction rolled back).
```
