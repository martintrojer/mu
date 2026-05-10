---
id: "schema_v5_migration_script"
workstream: "mufeedback"
status: CLOSED
impact: 80
effort_days: 1
roi: 80.00
owner: null
created_at: "2026-05-09T10:40:13.177Z"
updated_at: "2026-05-09T11:38:12.703Z"
blocked_by: ["schema_surrogate_pks_for_global_uniqueness", "schema_v5_design_amendments"]
blocks: ["docs_staleness_review_capstone", "schema_v5_drop_migrations_ts", "schema_v5_sdk_signatures"]
---

# schema v5: one-off migration script + loud-fail hook in openDb

## Notes (1)

### #1 by worker-mf-3, 2026-05-09T10:40:29.177Z

```
Per docs/SCHEMA_v5_DESIGN.md "Migration strategy" section.

Deliverable:
  - scripts/migrate-v4-to-v5.ts (NEW, ~80 LOC, NOT shipped in dist/).
    Pure node:better-sqlite3 + node:fs; no SDK imports so it runs against
    a v4 DB without mu being installed at v5.
    Steps: open v4 read-only, create mu.db.new with v5 schema, walk
    entity tables in dep order (workstreams -> agents -> tasks ->
    task_edges -> task_notes -> agent_logs -> vcs_workspaces -> approvals
    -> snapshots), maintain in-memory Map<oldTextPk, newIntId> for FK
    rewrites, recreate views, bump schema_version=5, VACUUM, verify row
    counts, rename mu.db -> mu.db.v4-backup-<ts> and mu.db.new -> mu.db.

  - SchemaTooOldError typed class + classifyError mapping to exit code 4.

  - Loud-fail hook in src/db.ts openDb(): after detectExistingSchemaVersion,
    if (detectedVersion !== null && detectedVersion < 5) throw
    SchemaTooOldError with the run-the-script instruction.

  - test/migrate-v4-to-v5.integration.test.ts (~110 LOC, see Migration test
    plan in design doc): seed a v4 fixture (DDL inline as string constant
    so v4 schema is not imported), round-trip every table, assert row
    counts + cascade behaviour + SET NULL on owner + per-scope UNIQUE +
    cross-workstream local_id reuse + view bodies + loud-fail hook fires.

Scope: ~0.5-1 day. Blocked by the design landing (this task already
references docs/SCHEMA_v5_DESIGN.md by path). Blocks
schema_v5_drop_migrations_ts, schema_v5_sdk_signatures,
schema_v5_cli_boundary, schema_v5_cleanups.

Gate: typecheck + lint + test + build green; the new integration test
must pass.
```
