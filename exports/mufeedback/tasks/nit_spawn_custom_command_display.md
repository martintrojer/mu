---
id: "nit_spawn_custom_command_display"
workstream: "mufeedback"
status: CLOSED
impact: 25
effort_days: 0.25
roi: 100.00
owner: null
created_at: "2026-05-08T08:50:55.466Z"
updated_at: "2026-05-08T09:30:41.746Z"
blocked_by: []
blocks: []
---

# NIT: agent spawn should surface custom command overrides

## Notes (2)

### #1 by system, 2026-05-08T08:50:55.562Z

```
FILES: mu CLI/runtime behavior observed via agent spawn output.
COMMANDS: mu agent spawn code-reviewer-1 -w infer-rs --role read-only --command 'pi-meta --no-solo'; mu state -w infer-rs.
FINDINGS: Spawned agents with custom command 'pi-meta --no-solo', but spawn output/state show cli=pi / 'Spawned ... (pi)'. This is technically the cli key, but it hides the operator-important fact that a command override is running.
DECISION: Track as a mu UX nit.
NEXT: Consider displaying both cli key and command override in spawn output / agent show / agent list JSON.
VERIFIED: Observed in infer-rs workstream for code-reviewer-1 and test-reviewer-1.
ODDITIES: Not blocking; agents started correctly.
```

### #2 by system, 2026-05-08T08:59:00.457Z

```
FILES: mu task metadata.
COMMANDS: mu sql UPDATE tasks SET workstream='mufeedback' ...
FINDINGS: Moved from roadmap-v0-2 to mufeedback per user request.
DECISION: Keep this as mufeedback item.
NEXT: Triage with other mu feedback tasks.
VERIFIED: task show/list in mufeedback after move.
ODDITIES: Moved via mu sql because mu has no typed task-move verb.
```
