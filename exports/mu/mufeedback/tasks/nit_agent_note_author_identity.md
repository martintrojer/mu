---
id: "nit_agent_note_author_identity"
workstream: "mufeedback"
status: CLOSED
impact: 30
effort_days: 0.3
roi: 100.00
owner: null
created_at: "2026-05-08T08:57:26.525Z"
updated_at: "2026-05-08T09:30:41.639Z"
blocked_by: []
blocks: []
---

# NIT: task notes from spawned agents should preserve agent identity

## Notes (2)

### #1 by null, 2026-05-08T08:57:26.621Z

```
FILES: mu CLI/runtime behavior observed in infer-rs workstream.
COMMANDS: Spawned code-reviewer-1/test-reviewer-1 with custom command 'pi-meta --no-solo'; agents ran 'mu task note ... -w infer-rs' and 'mu task close ... -w infer-rs'.
FINDINGS: Review notes #161 and #164 display author <orchestrator> even though the corresponding tasks were owned by code-reviewer-1/test-reviewer-1 and the commands were issued from those panes. This makes the durable audit trail less clear.
DECISION: Track as a mu identity/UX nit.
NEXT: Ensure spawned panes export enough identity for task note/close to attribute actions to the agent, including when --command overrides the CLI. Alternatively document that agents must pass --as/--actor.
VERIFIED: infer-rs events #602/#606 notes and task close events #603/#607 after the review-agent run.
ODDITIES: May be specific to custom --command 'pi-meta --no-solo' or commands launched from pi shell tool; spawned agent registry rows existed.
```

### #2 by null, 2026-05-08T08:59:00.555Z

```
FILES: mu task metadata.
COMMANDS: mu sql UPDATE tasks SET workstream='mufeedback' ...
FINDINGS: Moved from roadmap-v0-2 to mufeedback per user request.
DECISION: Keep this as mufeedback item.
NEXT: Triage with other mu feedback tasks.
VERIFIED: task show/list in mufeedback after move.
ODDITIES: Moved via mu sql because mu has no typed task-move verb.
```
