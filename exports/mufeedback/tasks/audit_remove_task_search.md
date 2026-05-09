---
id: "audit_remove_task_search"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.3
roi: 83.33
owner: null
created_at: "2026-05-09T11:11:04.337Z"
updated_at: "2026-05-09T15:24:43.761Z"
blocked_by: []
blocks: []
---

# REMOVE: drop `mu task search` in favour of `mu sql … LIKE` recipe (verb audit)

## Notes (2)

### #1 by worker-mf-1, 2026-05-09T11:11:04.448Z

```
From verb audit (docs/VERB_AUDIT.md). SCORE 1/4: 0 atomicity, 0 side-effect, 0 typed errors, 1 output value.

The `--in-notes` opt-in adds a UNION over `task_notes` — also one SQL line. The case-insensitive LIKE pattern wrap and the `--all` cross-workstream toggle are minor sugar.

SQL recipes (publish in docs/USAGE_GUIDE.md "SQL escape hatch" table):

  # title-only, current workstream
  mu sql "SELECT local_id, status, title FROM tasks
          WHERE workstream=X AND LOWER(title) LIKE %foo%"

  # title + notes, current workstream
  mu sql "SELECT t.local_id, t.status, t.title FROM tasks t
          LEFT JOIN task_notes n ON n.task_id=t.local_id
          WHERE t.workstream=X AND
                (LOWER(t.title) LIKE %foo% OR LOWER(n.content) LIKE %foo%)
          GROUP BY t.local_id"

  # cross-workstream (--all)
  mu sql "SELECT workstream, local_id, status, title FROM tasks
          WHERE LOWER(title) LIKE %foo%"

CHECKLIST: cmdTaskSearch in src/cli/tasks/queries.ts; wire entry; SDK searchTasks (likely keep — could be reused); USAGE_GUIDE / VOCABULARY / SKILL; CHANGELOG.

Operator may keep this verb for ergonomics — search-with-quoting is annoying via `mu sql`. Audit stands by REMOVE because the `mu sql` alternative is exactly the muscle-memory the operator already builds for ad-hoc questions.
```

### #2 by π - mu, 2026-05-09T11:20:09.226Z

```
DEFERRED by orchestrator: ship after schema_v5 lands. Schema_v5 rewrites SDK signatures (workstream context), so the audit-removal commits would conflict. Re-claim after schema_v5_cleanups closes; the SQL recipe in this task's audit notes still applies.
```
