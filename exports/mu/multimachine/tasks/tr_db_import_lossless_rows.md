---
id: "tr_db_import_lossless_rows"
workstream: "multimachine"
status: CLOSED
impact: 75
effort_days: 0.4
roi: 187.50
owner: null
created_at: "2026-05-14T09:51:19.986Z"
updated_at: "2026-05-14T10:08:27.912Z"
blocked_by: []
blocks: ["umbrella"]
---

# Test review: db import lacks lossless row-property assertions

## Notes (2)

### #1 by "worker-2", 2026-05-14T09:51:20.275Z

```
FILE: test/db-sync-import.test.ts: importDb data movement / planning tests
WHAT'S MISSING/WRONG: The import tests mostly assert task counts/titles and one edge count. They seed notes in a few places but never assert imported task_notes content/authors/timestamps, and they do not assert task status/impact/effort_days/created_at/updated_at survive IMPORT/FAST_FORWARD/CONFLICT replacement.
WHY IT MATTERS: The feature goal is lossless DB shipping. A regression that drops notes, resets CLOSED/DEFERRED tasks to OPEN, rewrites effort/impact, or loses timestamps could still leave task counts/titles green and escape review.
SUGGESTED FIX: Add a db import round-trip/property test that seeds varied task statuses, impact/effort, notes with NULL and non-NULL authors, edges, and timestamps; apply an IMPORT or FAST_FORWARD; then compare the destination rows by local_id against source for tasks/edges/notes (owners intentionally NULL if that is the contract).
SEVERITY: high
```

### #2 by "worker-1", 2026-05-14T10:08:27.912Z

```
CLOSE: 7bcccee content fidelity round-trip test added (status/impact/effort/timestamps/notes/edges)
```
