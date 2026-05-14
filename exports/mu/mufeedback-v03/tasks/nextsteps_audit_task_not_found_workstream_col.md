---
id: "nextsteps_audit_task_not_found_workstream_col"
workstream: "mufeedback-v03"
status: CLOSED
impact: 70
effort_days: 0.1
roi: 700.00
owner: "worker-2"
created_at: "2026-05-10T13:34:05.805Z"
updated_at: "2026-05-10T13:45:12.244Z"
blocked_by: []
blocks: []
---

# nextsteps-audit: TaskNotFoundError SQL recipe selects tasks.workstream — no such column post-v5

## Notes (1)

### #1 by "worker-5", 2026-05-10T13:34:15.608Z

```
FILES: src/tasks/errors.ts:25-32
FINDING: TaskNotFoundError.errorNextSteps() builds a SQL recipe that SELECTs a non-existent column.
CURRENT-HINT:
  intent: "Search by substring (id + title)"
  command: mu sql "SELECT workstream, local_id, status, title FROM tasks WHERE LOWER(local_id) LIKE '%X%' OR LOWER(title) LIKE '%X%'"
STALE-BECAUSE: v5+ schema (src/db.ts:499 onward) replaced TEXT tasks.workstream with INTEGER tasks.workstream_id (FK to workstreams.id). The SELECT will fail at runtime with `Error: no such column: workstream`. This is THE FIRST hint a user sees on a missed-task lookup, so the breakage is high-traffic.
FIX-SKETCH:
  Replace with a join:
    mu sql "SELECT ws.name AS workstream, t.local_id, t.status, t.title
            FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id
            WHERE LOWER(t.local_id) LIKE '%X%' OR LOWER(t.title) LIKE '%X%'"
  (Pattern matches the AgentExistsError fix at src/agents/errors.ts:35 which already does the right thing.)
```
