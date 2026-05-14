---
id: "audit_merge_self_verbs_into_mu_me"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.5
roi: 60.00
owner: null
created_at: "2026-05-09T11:11:19.081Z"
updated_at: "2026-05-09T15:29:43.046Z"
blocked_by: []
blocks: []
---

# MERGE: collapse `whoami` / `my-tasks` / `my-next` into `mu me [tasks|next]` (verb audit)

## Notes (2)

### #1 by "worker-mf-1", 2026-05-09T11:11:19.191Z

```
From verb audit (docs/VERB_AUDIT.md). The three top-level "self" verbs (`whoami`, `my-tasks`, `my-next`) score 2/4, 1/4, 1/4 respectively. They are obviously a cluster — three doors into the same agent-self room.

PROPOSED SHAPE:

  mu me              # whoami: identity block + owned-tasks (current behaviour)
  mu me tasks        # my-tasks: just the owned-tasks table
  mu me next [-n K]  # my-next: top-K ready tasks in agent`s workstream

Implementation: src/cli/agents.ts already has cmdWhoami / cmdMyTasks / cmdMyNext and a wireSelfCommands that registers all three top-level. The merge is mostly wire-time:
  - rename `whoami` to `me` (top-level), default action = current `cmdWhoami`
  - add `me tasks` subcommand → cmdMyTasks
  - add `me next` subcommand → cmdMyNext

BACK-COMPAT: keep `whoami`, `my-tasks`, `my-next` as aliases for one release cycle (commander supports `.alias()`). After that, remove.

DOCS: docs/USAGE_GUIDE.md lists the three verbs; consolidate. SKILL.md verb list; consolidate. VOCABULARY: define "me" (or document the rename of "whoami").

CALIBRATION: this matches operator priors in audit_verbs_typed_vs_sql note #398.

OPERATOR: may reject in favour of keeping the three verbs for in-pane brevity (`mu my-next` IS shorter than `mu me next`). Audit recommendation: merge, because 3 top-level entries crowd `mu --help` and the three verbs sharing the same `resolveSelf(db)` logic + identical render shape is the smell.
```

### #2 by "π - mu", 2026-05-09T11:20:08.355Z

```
DEFERRED by orchestrator: ship after schema_v5 lands. Schema_v5 rewrites SDK signatures (workstream context), so the audit-removal commits would conflict. Re-claim after schema_v5_cleanups closes; the SQL recipe in this task's audit notes still applies.
```
