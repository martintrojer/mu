---
id: "cr_doctor_ghost_wording"
workstream: "mubugs"
status: CLOSED
impact: 50
effort_days: 0.1
roi: 500.00
owner: null
created_at: "2026-05-15T11:38:03.198Z"
updated_at: "2026-05-15T11:51:48.505Z"
blocked_by: []
blocks: ["umbrella"]
---

# Code review: doctor reports ghost count as pruned in report-only mode

## Notes (2)

### #1 by "worker-1", 2026-05-15T11:38:04.886Z

```
FILE/LINE: src/cli/doctor.ts:139, src/doctor-summary.ts:189
WHAT'S WRONG: report-only reconcile still only counts would-be prunes, but the textual doctor labels the count as 'pruned N during this check', and the TUI doctor summary still tells the user to run 'mu agent list'. After the collapse, normal read surfaces such as mu state already reap; report-only doctor does not.
WHY IT MATTERS: This is misleading operator guidance around the exact behavior being changed. A user seeing this after a crash may think doctor already cleaned the rows, or may run mu agent list even though mu state is now the advertised reap surface.
SUGGESTED FIX: In report-only surfaces, phrase the count as 'N ghost pane(s) would be pruned/reaped by mu state or mu agent list' (or similar). Keep 'pruned' only for full-mode reports that actually deleted rows.
SEVERITY: low
```

### #2 by "worker-2", 2026-05-15T11:51:48.505Z

```
CLOSE: 5298d59 doctor + doctor-summary wording corrected for post-collapse reaping reality
```
