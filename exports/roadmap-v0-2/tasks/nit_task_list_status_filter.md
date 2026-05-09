---
id: "nit_task_list_status_filter"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 35
effort_days: 0.15
roi: 233.33
owner: null
created_at: "2026-05-07T18:01:34.388Z"
updated_at: "2026-05-07T18:21:55.546Z"
blocked_by: []
blocks: []
---

# NIT: `mu task list` has no --status filter; can't easily ask 'show me only OPEN tasks'

## Notes (1)

### #1 by system, 2026-05-07T18:01:34.481Z

```
Workaround: `mu task list --json | jq '.[] | select(.status == "OPEN")'` or `mu sql`. Easy add: --status <OPEN|IN_PROGRESS|CLOSED|RESOLVED> filter on the SQL WHERE clause.
```
