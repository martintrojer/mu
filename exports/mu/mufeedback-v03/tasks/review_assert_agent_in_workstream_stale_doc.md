---
id: "review_assert_agent_in_workstream_stale_doc"
workstream: "mufeedback-v03"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-10T11:38:17.872Z"
updated_at: "2026-05-10T11:57:31.657Z"
blocked_by: []
blocks: []
---

# review: assertAgentInWorkstream docstring claims agent names globally unique (v4 carryover)

## Notes (1)

### #1 by reviewer-1, 2026-05-10T11:38:17.987Z

```
FILES: src/cli.ts:1042-1066 (assertAgentInWorkstream + comment)

FINDING: The docstring says "Agent names are globally unique today (PK on agents.name), so the -w flag is purely a scope check." This is false for v5+: `agents.name` is per-workstream UNIQUE (UNIQUE (workstream_id, name); see src/db.ts:485). The function still works correctly — it relies on the generic assertEntityInWorkstream — but the rationale paragraph is from the v4 era.

WHY: AGENTS.md mandates VOCABULARY/architecture docs stay in sync with code; stale rationale strings here mislead the next reader who tries to reason about why `-w` is a scope check vs a discriminator. (Counterintuitively the function still works for v5: when `worker-1` exists in two workstreams and the operator passes `-w foo`, the fast-path SELECT finds the foo row and returns; the slow path only triggers when not in expected ws.)

FIX-SKETCH: Replace the comment with: "Agent names are per-workstream unique (UNIQUE(workstream_id, name)); -w is the scope check that turns a wrong-target verb into a clear AgentNotInWorkstreamError instead of operating on a same-named agent in another workstream."

DONT-FIX: No code change needed — assertEntityInWorkstream already handles the per-workstream-unique case correctly.
```
