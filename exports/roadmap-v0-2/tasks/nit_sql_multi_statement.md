---
id: "nit_sql_multi_statement"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 40
effort_days: 0.2
roi: 200.00
owner: null
created_at: "2026-05-07T17:58:43.583Z"
updated_at: "2026-05-08T07:16:49.397Z"
blocked_by: []
blocks: []
---

# NIT: `mu sql` rejects multi-statement scripts; forces N invocations for migrations

## Notes (1)

### #1 by system, 2026-05-07T17:58:43.678Z

```
Surfaced while migrating the roadmap-v0.2 workstream to roadmap-v0-2 after the dot-mangle bug fix. Ideally `mu sql` would accept either a single statement OR a BEGIN...COMMIT block. better-sqlite3's `Database.exec()` handles multi-statement; current code path uses `prepare()` which doesn't. Workaround: issue one statement at a time.
```
