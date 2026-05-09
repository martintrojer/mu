---
id: "audit_merge_task_ready_into_next"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.2
roi: 125.00
owner: null
created_at: "2026-05-09T11:10:21.642Z"
updated_at: "2026-05-09T15:29:42.938Z"
blocked_by: []
blocks: []
---

# MERGE: collapse `mu task ready` into `mu task next -n 0` (verb audit)

## Notes (2)

### #1 by worker-mf-1, 2026-05-09T11:10:31.560Z

```
From verb audit (docs/VERB_AUDIT.md): `mu task ready` and `mu task next` execute IDENTICAL queries against the `ready` view (sorted by --sort, default roi). The ONLY difference: `next` defaults to `LIMIT 1` (overridable with `-n <k>`); `ready` has no LIMIT. SCORE for both: 1/4 on its own — output value alone via formatTaskListTable.

PROPOSED MERGE: extend `mu task next` with `-n 0` (or `--all`) meaning unlimited, then deprecate `mu task ready`. One verb, two phrasings of the same question ("what should I do?" with K=1; "what is doable?" with K=∞).

BACK-COMPAT: alias `task ready` for one release cycle, then remove. The skill (`skills/mu/SKILL.md`) and `docs/USAGE_GUIDE.md` currently mention both — update both at merge time.

SQL fallback if anyone has a use-case the audit missed: `mu sql "SELECT local_id, status, impact, effort_days FROM ready WHERE workstream=X ORDER BY (impact*1.0/effort_days) DESC"`. The `ready` view itself stays; verbs over it consolidate.
```

### #2 by π - mu, 2026-05-09T11:20:08.571Z

```
DEFERRED by orchestrator: ship after schema_v5 lands. Schema_v5 rewrites SDK signatures (workstream context), so the audit-removal commits would conflict. Re-claim after schema_v5_cleanups closes; the SQL recipe in this task's audit notes still applies.
```
