---
id: "skill_status_vocabulary_outdated"
workstream: "mufeedback"
status: CLOSED
impact: 20
effort_days: 0.1
roi: 200.00
owner: null
created_at: "2026-05-08T10:11:01.641Z"
updated_at: "2026-05-08T10:12:33.820Z"
blocked_by: []
blocks: []
---

# Skill vocabulary should mention REJECTED and DEFERRED task states

## Notes (1)

### #1 by π - infer-rs, 2026-05-08T10:11:01.745Z

```
FILES: /Users/mtrojer/.agents/skills/mu/SKILL.md
COMMANDS: read mu skill; mu state -w infer-rs; mu state -w mufeedback
FINDINGS: Skill vocabulary still says task status is OPEN → IN_PROGRESS → CLOSED, but the current CLI/task surface also includes REJECTED and DEFERRED via `mu task reject` and `mu task defer`. Live mufeedback state shows examples: git_workspaces_start_without_node is REJECTED and nit_no_task_move_verb is DEFERRED.
DECISION: Log this as a skill/docs nit so future orchestrators remember all five task states.
NEXT: Update the vocabulary line and any task-state summaries to include OPEN, IN_PROGRESS, CLOSED, REJECTED, DEFERRED. Clarify that REJECTED/DEFERRED still block downstream tasks unless cascaded/reparented/unblocked.
VERIFIED: Current `mu state -w mufeedback` Recent events include OPEN → REJECTED and OPEN → DEFERRED transitions.
ODDITIES: The CLI section is current; only the high-level vocabulary sentence is stale.
```
