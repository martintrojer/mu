---
id: "nextsteps_audit_snapshot_show_raw_sqlite3"
workstream: "mufeedback-v03"
status: CLOSED
impact: 25
effort_days: 0.1
roi: 250.00
owner: "worker-4"
created_at: "2026-05-10T13:34:49.301Z"
updated_at: "2026-05-10T13:45:13.140Z"
blocked_by: []
blocks: []
---

# nextsteps-audit: SnapshotShow + SnapshotVersionMismatchError suggest raw sqlite3 against the SAME live DB shape — drift / abstraction violation

## Notes (1)

### #1 by worker-5, 2026-05-10T13:35:01.133Z

```
FILES: src/cli/snapshot.ts:289-292 (cmdSnapshotShow nextSteps)
FINDING: Style finding (low priority): cmdSnapshotShow suggests raw sqlite3 to inspect a snapshot file. The audit framing flags "raw sqlite3 instead of mu sql" as a deprecated pattern.
CURRENT-HINT:
  intent: "Inspect the snapshot data without restoring"
  command: sqlite3 ${row.dbPath} "SELECT * FROM tasks"
STALE-BECAUSE: Lukewarm — the snapshot file IS a separate sqlite db so this hint actually works (unlike the cousin `mu sql --db ...` hint in SnapshotVersionMismatchError which is BROKEN — see nextsteps_audit_sql_db_flag_does_not_exist). But it directly contradicts the convention "use mu sql, not sqlite3". The rationale is: `mu sql` opens the LIVE DB only; the snapshot path is by definition a different DB.
FIX-SKETCH: Either:
  (a) Leave it as-is and add a comment that the raw-sqlite3 escape is intentional for snapshots (out-of-band data).
  (b) Add `mu sql --db <path>` (couples to nextsteps_audit_sql_db_flag_does_not_exist) and migrate this hint to it.
  Both pre-snapshot inspection hints (this + SnapshotVersionMismatchError) want the same treatment; consider as one unit.
```
