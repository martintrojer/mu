---
id: "nextsteps_audit_sql_db_flag_does_not_exist"
workstream: "mufeedback-v03"
status: CLOSED
impact: 50
effort_days: 0.1
roi: 500.00
owner: "worker-5"
created_at: "2026-05-10T13:34:19.679Z"
updated_at: "2026-05-10T13:41:07.498Z"
blocked_by: []
blocks: []
---

# nextsteps-audit: SnapshotVersionMismatchError suggests `mu sql --db <path>` — flag does not exist

## Notes (1)

### #1 by worker-5, 2026-05-10T13:34:31.206Z

```
FILES: src/snapshots.ts:158-161 (SnapshotVersionMismatchError.errorNextSteps)
FINDING: Hint suggests a `--db` flag on `mu sql` that the CLI does not accept.
CURRENT-HINT:
  intent: "Inspect the stale snapshot read-only"
  command: mu sql --db <snapshot-path> "SELECT * FROM tasks"
STALE-BECAUSE: src/cli/sql.ts:294-302 wireSqlCommand only registers `--json` and `--confirm-rows`; there is no `--db` option. Running this verbatim throws `error: unknown option '--db'` (commander, exit 1) — not a useful hint when the operator is already in a confused state about a version-mismatched snapshot.
FIX-SKETCH: Two reasonable fixes:
  (a) Drop this hint and replace with a direct sqlite3 call:
        sqlite3 <snapshot-path> "SELECT * FROM tasks"
      (Acceptable here because the snapshot is forensic / out-of-band, not the live mu DB; the "no raw sqlite3 in nextSteps" preference applies to the LIVE DB.)
  (b) Promote --db to a real flag on `mu sql` (small SDK change to openDb, ~30 LOC); useful for snapshot inspection generally. Tracked in roadmap criteria.
  Pick (a) for the small fix; (b) requires its own task.
```
