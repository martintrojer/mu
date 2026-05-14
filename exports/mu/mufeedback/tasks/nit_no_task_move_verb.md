---
id: "nit_no_task_move_verb"
workstream: "mufeedback"
status: DEFERRED
impact: 20
effort_days: 0.3
roi: 66.67
owner: null
created_at: "2026-05-08T08:59:21.336Z"
updated_at: "2026-05-08T10:09:12.494Z"
blocked_by: []
blocks: []
---

# NIT: no typed task move/copy verb between workstreams

## Notes (1)

### #1 by null, 2026-05-08T08:59:21.429Z

```
FILES: mu CLI behavior.
COMMANDS: Moved tasks between roadmap-v0-2 and mufeedback using mu sql UPDATE tasks SET workstream='mufeedback'.
FINDINGS: There is no typed 'mu task move <id> -w old --to-workstream new' verb, so moving feedback tasks requires raw SQL. SQL works but is higher-risk and less discoverable.
DECISION: Track as low-priority UX nit.
NEXT: Consider adding a typed move/copy verb that validates destination workstream, checks duplicate IDs, and preserves notes/edges.
VERIFIED: Successfully moved nit_spawn_custom_command_display, nit_agent_note_author_identity, and bug_workspace_orphaned_after_agent_close via SQL.
ODDITIES: Current schema makes simple moves possible because task IDs are globally primary-keyed, but edges/notes are not workstream-scoped so a typed verb should still validate cross-workstream DAG expectations.
```
