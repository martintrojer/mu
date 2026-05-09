---
id: "review_test_claim_integration_xws_rewrite"
workstream: "mufeedback"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: "worker-mf-1"
created_at: "2026-05-09T08:33:25.118Z"
updated_at: "2026-05-09T10:23:51.667Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: claim.integration.test.ts cross-workstream rewrite traded coverage for green

## Notes (1)

### #1 by test-reviewer-1, 2026-05-09T08:33:54.276Z

```
FILES: test/claim.integration.test.ts (3 fixtures); src/tasks/claim.ts:194-220 (cross-workstream guard).

WHAT THE TESTS CLAIM: Three integration tests verify the claim-from-pane-title protocol against real tmux: (1) zero-config claim derives owner from agent name, (2) two agents racing on the same task: one wins, (3) re-claim by the same agent is idempotent.

WHAT THEY ACTUALLY VERIFY: They DO verify the claim-from-pane-title protocol AGAINST same-workstream agents. The diff in commit 6d8a2a5 changed three task-add fixtures from `workstream: "test"` (a literal string with no agents in it pre-fix) to `workstream` (the dynamically-named workstream the agents were spawned into). The change was strictly necessary post-cross_workstream_claim_for — the old fixtures would now raise AgentNotInWorkstreamError before the claim CAS could fire. So the rewrite is correct AS A REPAIR. The gap is what was lost.

GAP: Pre-fix, the integration tests inadvertently exercised the BUG path: an agent in workstream A claiming a task in workstream B. The test pre-fix passed because the bug allowed it. Post-fix, the bug is fixed AND the integration test no longer exercises it. The unit tests in test/tasks.test.ts:805-841 pin AgentNotInWorkstreamError for the cross-workstream rejection — but with a MOCKED tmux executor, not with a real tmux pane title parsing path. So the precise scenario "real tmux pane title resolves to agent X in workstream A; task is in workstream B; expect AgentNotInWorkstreamError" is not integration-tested anywhere. If the unit test's mocked currentAgentName() and the real tmux display-message diverge in some subtle way (e.g. parseAgentNameFromTitle on a composed title with new STATUS_EMOJI bytes returns the wrong token, then the agents-table FK check resolves the wrong workstream), the bug re-emerges and only the unit test catches the rejection — at the wrong agent name.

Specifically: the cross-workstream case used to fire NATURALLY in claim.integration.test.ts whenever the harness happened to leave residual agents from a previous test run in workstream "test". Today every fixture lives in a unique-per-run workstream (good), so:
  - the unit-level reject is covered (test/tasks.test.ts: AgentNotInWorkstreamError);
  - the worker→worker SAME-workstream race is covered (claim.integration.test.ts test 2);
  - the cross-workstream reject through real tmux pane title parsing + real agents row lookup is NOT covered.

WHY IT MATTERS: 60. The fix landed; the unit test guards the SQL. But the integration test surface for "real-tmux pane title resolves and lands in cross-workstream guard" is absent. A refactor that breaks the agents-row workstream lookup (e.g. someone changes `SELECT workstream FROM agents WHERE name = ? LIMIT 1` to filter by `WHERE name = ? AND status != 'terminated'`) would let a freshly-terminated agent's prior workstream go silently — the unit test mocks the agents row directly, the integration test no longer probes this path.

SUGGESTED FIX: Add one new it() to claim.integration.test.ts (~25 LOC) — spawn alice in workstream A, spawn bob in workstream B (different sessions, different `mu workstream init`), addTask in workstream A, then run claimTask from bob's pane (via withPane(bob.paneId, () => claimTask(db, "design"))) and assert it rejects with AgentNotInWorkstreamError. This pins the real-tmux pane-title→agents-row→workstream-mismatch chain end-to-end.

EVIDENCE: git diff 6d8a2a5^ 6d8a2a5 -- test/claim.integration.test.ts shows the three `workstream: "test"` → `workstream` rewrites were necessary repairs. Commit body acknowledges "The --self (anonymous) path is untouched: no agent FK to check" — and the integration suite has no --self fixture either. test/tasks.test.ts:802-820 is the only AgentNotInWorkstreamError test; it uses `insertAgent(db, ...)` directly (no real tmux) and does NOT exercise the parseAgentNameFromTitle → currentAgentName chain.
```
