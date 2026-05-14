---
id: "nit_table_no_truncation"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 50
effort_days: 0.3
roi: 166.67
owner: null
created_at: "2026-05-07T17:52:34.742Z"
updated_at: "2026-05-07T18:21:55.641Z"
blocked_by: []
blocks: []
---

# NIT: mu task ready/goals/list don't truncate the title column; rows balloon to 200+ chars

## Notes (1)

### #1 by null, 2026-05-07T17:52:34.839Z

```
Use cli-table3's wordWrap option, or truncate to e.g. 60 chars with ellipsis. Bare `mu` mission control likely has the same issue. Compare against `mu agent list` which I haven't tested yet — see if it truncates differently.
```
