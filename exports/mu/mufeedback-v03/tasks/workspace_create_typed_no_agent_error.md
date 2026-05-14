---
id: "workspace_create_typed_no_agent_error"
workstream: "mufeedback-v03"
status: CLOSED
impact: 35
effort_days: 0.15
roi: 233.33
owner: null
created_at: "2026-05-10T08:05:34.628Z"
updated_at: "2026-05-10T08:13:37.601Z"
blocked_by: []
blocks: []
---

# fix: mu workspace create errors as AgentNotFoundError (not raw FK violation) when no agent row exists

## Notes (1)

### #1 by "π - mu", 2026-05-10T08:06:15.088Z

```
mu workspace create errors as AgentNotFoundError (not raw FK violation) when no agent row exists.

═══ THE BUG (hit today during the parallel-fan-out spawn) ═══

  $ mu workspace create worker-1 -w mufeedback-v03
  error: NOT NULL constraint failed: vcs_workspaces.agent_id

The worker-1 agent doesn't exist in mufeedback-v03 (it lives in roadmap-v0-3). The error is leaking a SQLite constraint name to the operator instead of saying "no such agent: worker-1 in workstream mufeedback-v03".

═══ ROOT CAUSE ═══

src/workspace.ts createWorkspace probably calls resolveAgentId() and trusts a NULL return path that propagates into the INSERT. Either resolveAgentId returns null without throwing, or the call site doesn't pre-check. Either way: the typed AgentNotFoundError exists (from src/agents.ts errors) and should fire here.

═══ FIX ═══

In src/workspace.ts createWorkspace (or whatever CRUD surface backs `mu workspace create`):
  1. resolveAgentId(db, workstreamId, agentName) — already throws AgentNotFoundError on miss per the canonical pattern.
  2. Use the throw'd error; let cli.ts handle() map it to its existing exit code.
  3. If the SDK was using tryResolveAgentId() (no-throw), replace with the throwing variant — the create operation has no business proceeding without a real agent.

═══ TESTS ═══

  test/workspace.test.ts (extend; ~30 LOC): mu workspace create on a nonexistent agent → AgentNotFoundError; exit 3 (or whichever the canonical code is); error message includes the agent name + workstream context. NO raw "NOT NULL constraint" leak.

═══ FILES ═══

  src/workspace.ts: ~5 LOC fix.
  src/cli/workspace.ts: nothing (the typed error propagates through handle()).
  test/workspace.test.ts: ~30 LOC.
  CHANGELOG.md (v0.3 unreleased): one line under "Fixed".

═══ SCOPE ═══

Tiny. ~40 LOC total.

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close workspace_create_typed_no_agent_error -w mufeedback-v03 --evidence 'AgentNotFoundError replaces FK leak; test'
```
