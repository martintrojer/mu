---
id: "review_agent_exists_message_stale"
workstream: "mufeedback-v03"
status: CLOSED
impact: 40
effort_days: 0.05
roi: 800.00
owner: null
created_at: "2026-05-10T11:38:06.625Z"
updated_at: "2026-05-10T11:49:58.016Z"
blocked_by: []
blocks: []
---

# review: AgentExistsError message + nextStep contradict v5 per-workstream uniqueness

## Notes (1)

### #1 by "reviewer-1", 2026-05-10T11:38:06.735Z

```
FILES: src/agents/errors.ts:18-32 (AgentExistsError)

FINDING: The error message asserts "agent names are globally unique across workstreams", but per the v5 schema (src/db.ts:478, src/agents.ts:249, AGENTS.md, CHANGELOG schema_v5) `agents.name` is per-workstream UNIQUE — the same name CAN exist in two workstreams. The first nextStep also reads `SELECT name, workstream FROM agents WHERE name=...` — `agents` no longer has a `workstream` column (it has `workstream_id` joining to workstreams.name); that SQL would fail on a v5 DB.

WHY: This error fires when an operator tries to spawn `worker-1` in a workstream that already has one. The v5 reality (per-workstream unique) is the ergonomic pillar — the misleading message tells the operator the wrong recovery (close it globally) when the actual fix is `-w <other-ws>`. The broken SQL nextStep is even worse: it crashes the recovery hint.

FIX-SKETCH: 1) Change message to "agent already exists in this workstream: ${agentName}". 2) Replace the SELECT with a join: `SELECT a.name, ws.name AS workstream FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.name = ?`. 3) Optionally mention -w <other> as the second resolution.

DONT-FIX: Don't add a workstream column on the AgentExistsError class — the constructor signature is fine; just fix the message + recovery hint.
```
