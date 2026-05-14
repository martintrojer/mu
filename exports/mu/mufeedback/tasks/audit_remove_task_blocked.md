---
id: "audit_remove_task_blocked"
workstream: "mufeedback"
status: CLOSED
impact: 20
effort_days: 0.2
roi: 100.00
owner: null
created_at: "2026-05-09T11:10:45.020Z"
updated_at: "2026-05-09T15:24:43.552Z"
blocked_by: []
blocks: []
---

# REMOVE: drop `mu task blocked` in favour of `mu sql … FROM blocked` (verb audit)

## Notes (2)

### #1 by "worker-mf-1", 2026-05-09T11:10:45.134Z

```
From verb audit (docs/VERB_AUDIT.md). SCORE 1/4: 0 atomicity, 0 side-effect, 0 typed errors, 1 output value (cli-table format).

The `blocked` view in src/db.ts is the actual abstraction; the verb is one-line sugar over it. An LLM (or a human) can compose:

  mu sql "SELECT local_id, status, title FROM blocked WHERE workstream=X"

…and get the same data minus the status emoji. The skill should document the recipe in the "what is in 0.1.0 — SQL escape hatch" table after the verb is removed.

CHECKLIST AT REMOVAL TIME (from AGENTS.md "Add a new CLI verb" inverted):
  - delete the cmd in src/cli/tasks/queries.ts (cmdTaskBlocked)
  - delete the wire entry in src/cli/tasks/wire.ts
  - delete the SDK helper `listBlocked` IF no other caller (mu state uses it — likely keep listBlocked, drop only the verb)
  - update docs/USAGE_GUIDE.md verb tables
  - update docs/VOCABULARY.md if it mentions the verb
  - update skills/mu/SKILL.md verb list + add SQL recipe to escape-hatch table
  - CHANGELOG entry under Removed (or Changed if back-compat aliasing)

The verb is an ergonomic loss for interactive humans (one extra word `sql` and quoting), so the operator may prefer to keep it; the audit is advisory.
```

### #2 by "π - mu", 2026-05-09T11:20:08.786Z

```
DEFERRED by orchestrator: ship after schema_v5 lands. Schema_v5 rewrites SDK signatures (workstream context), so the audit-removal commits would conflict. Re-claim after schema_v5_cleanups closes; the SQL recipe in this task's audit notes still applies.
```
