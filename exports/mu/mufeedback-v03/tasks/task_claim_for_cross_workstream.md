---
id: "task_claim_for_cross_workstream"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.2
roi: 150.00
owner: null
created_at: "2026-05-10T08:05:34.426Z"
updated_at: "2026-05-10T10:57:46.864Z"
blocked_by: ["task_wait_cross_workstream"]
blocks: []
---

# feat: mu task claim --for accepts cross-workstream qualified ref (mirrors task_wait_cross_workstream)

## Notes (1)

### #1 by π - mu, 2026-05-10T08:06:14.963Z

```
mu task claim --for accepts cross-workstream qualified ref.

═══ THE FRICTION (hit today) ═══

I tried `mu task claim X -w mufeedback-v03 --for roadmap-v0-3/worker-1` to dispatch a task in mufeedback-v03 to a worker living in roadmap-v0-3. It errored with:

  error: Work directly (anonymous) : mu task claim <id> --self
         Dispatch to a worker      : mu task claim <id> --for <worker>
         Register a pane           : mu adopt <pane-id>  (must be in mu-<workstream> tmux session)

The --for resolution doesn't understand the qualified-ref form.

═══ WHY IT MATTERS ═══

Per-workstream pools of free workers exist; orchestrator routinely has worker-1 free in roadmap-v0-3 and a task queued in mufeedback-v03. Today the only options are:
  - close worker-1, spawn a new agent in the target ws (slow; loses LLM context)
  - hand-write SQL via mu sql (escape hatch, ugly)

Cross-ws --for lets the orchestrator just say `--for roadmap-v0-3/worker-1` from anywhere.

═══ THE TARGET SHAPE ═══

  mu task claim X -w mufeedback-v03 --for worker-1                 # today: worker-1 must be in mufeedback-v03
  mu task claim X -w mufeedback-v03 --for roadmap-v0-3/worker-1    # NEW: cross-ws claim

The qualified-ref parsing for --for mirrors task_wait_cross_workstream's qualified-ref handling (and the existing one for task IDs). One resolveEntityRef helper, applied here.

═══ INTERACTION WITH AGENTS' WORKSTREAM SCOPE ═══

Agents are per-workstream (v5 surrogate-PK; agents.workstream_id FK). The cross-ws claim doesn't move the agent; it just records the claim from a different workstream's task. The agent's own ws stays unchanged.

The owner_id on tasks is an INTEGER FK to agents.id; that already crosses workstream boundaries (no agents.workstream_id is checked when setting owner_id). So the SQL substrate already supports this; the CLI is just refusing it at the resolution layer.

═══ DELIVERABLE ═══

  src/cli/tasks/claim.ts (or wherever cmdTaskClaim lives): teach the --for resolver to accept qualified refs (mirror existing task-id resolution).
  src/agents.ts: any helper that resolves agent name to id needs to accept (workstream, name) instead of just (workstream-from-context, name). resolveAgentId in src/db.ts already takes (workstreamId, name) so the CLI just needs to pre-resolve the workstream from the qualified ref.
  Tests: cross-ws --for; bare --for falls back to task's workstream (today's behavior); --for to non-existent worker errors.
  docs/USAGE_GUIDE.md: extend the claim section.
  skills/mu/SKILL.md: update the claim line + dispatch lessons.
  CHANGELOG.md: one line.

═══ SCOPE ═══

  ~40 LOC code + ~60 LOC tests. Symmetric to task_wait_cross_workstream.

═══ DEPENDENCY ═══

Blocked-by task_wait_cross_workstream so the qualified-ref resolution lands once + is reused. Sequential.

═══ ANTI-FEATURE ═══

  - Don't auto-resolve `--for worker-1` to "the only worker named worker-1 across all workstreams" when ambiguous. NameAmbiguousError today; keep its honesty.

═══ FINAL ACTION ═══

⚠️ git commit -am '...' THEN mu task close task_claim_for_cross_workstream -w mufeedback-v03 --evidence 'qualified-ref --for; tests; docs'
```
