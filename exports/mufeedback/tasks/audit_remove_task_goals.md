---
id: "audit_remove_task_goals"
workstream: "mufeedback"
status: CLOSED
impact: 20
effort_days: 0.2
roi: 100.00
owner: null
created_at: "2026-05-09T11:10:51.010Z"
updated_at: "2026-05-09T15:24:43.657Z"
blocked_by: []
blocks: []
---

# REMOVE: drop `mu task goals` in favour of `mu sql … FROM goals` (verb audit)

## Notes (2)

### #1 by worker-mf-1, 2026-05-09T11:10:51.126Z

```
From verb audit (docs/VERB_AUDIT.md). SCORE 1/4: same shape as audit_remove_task_blocked.

The `goals` view in src/db.ts is the abstraction. The verb is sugar:

  mu sql "SELECT local_id, status, title FROM goals WHERE workstream=X"

CHECKLIST AT REMOVAL TIME:
  - delete cmdTaskGoals in src/cli/tasks/queries.ts
  - delete wire entry in src/cli/tasks/wire.ts
  - decide whether to keep SDK helper `listGoals` (used internally? grep first)
  - update docs/USAGE_GUIDE.md / docs/VOCABULARY.md / skills/mu/SKILL.md
  - CHANGELOG entry under Removed/Changed

Same caveat as audit_remove_task_blocked: ergonomic loss for interactive humans; operator decides.
```

### #2 by π - mu, 2026-05-09T11:20:08.999Z

```
DEFERRED by orchestrator: ship after schema_v5 lands. Schema_v5 rewrites SDK signatures (workstream context), so the audit-removal commits would conflict. Re-claim after schema_v5_cleanups closes; the SQL recipe in this task's audit notes still applies.
```
