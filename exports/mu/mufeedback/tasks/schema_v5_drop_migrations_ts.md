---
id: "schema_v5_drop_migrations_ts"
workstream: "mufeedback"
status: CLOSED
impact: 35
effort_days: 0.5
roi: 70.00
owner: null
created_at: "2026-05-09T10:40:40.311Z"
updated_at: "2026-05-09T13:07:40.939Z"
blocked_by: ["schema_v5_migration_script"]
blocks: ["docs_staleness_review_capstone"]
---

# schema v5: delete src/migrations.ts (optional cleanup, ~-300 LOC)

## Notes (1)

### #1 by worker-mf-3, 2026-05-09T10:40:40.414Z

```
Per docs/SCHEMA_v5_DESIGN.md "Piece 3 (optional cleanup)".

Once schema_v5_migration_script ships, src/migrations.ts is dead code:
  - The v1->v2, v2->v3, v3->v4 migrations only forward long-dormant DBs.
  - With the loud-fail hook in openDb, any DB at version < 5 errors out
    before any migration would run.

Deliverable:
  - rm src/migrations.ts and its callers (the runMigrations call in
    src/db.ts openDb).
  - rm test/migrations.test.ts and any other migration-specific tests.
  - Verify EXPECTED_TABLES, READY/BLOCKED/GOALS_VIEW_SQL exports stay
    (still used by db.ts applySchema).
  - Update src/db.ts header comment ("Migrations are versioned via..."
    block) to remove the migrations narrative.
  - Update docs/ARCHITECTURE.md if migrations.ts is mentioned.

Net delta: ~-300 LOC src + ~-150 LOC tests.

Optional in the sense that the loud-fail hook already prevents stale DBs
from running; this is pure debt cleanup. Ship when comfortable.

Scope: ~0.5 days. Blocked by schema_v5_migration_script.
Gate: typecheck + lint + test + build green.
```
