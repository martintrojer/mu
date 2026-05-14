---
id: "review_test_listtasksbyowner_xws_owner_state_unreachable"
workstream: "mufeedback"
status: CLOSED
impact: 40
effort_days: 0.2
roi: 200.00
owner: null
created_at: "2026-05-09T08:35:51.915Z"
updated_at: "2026-05-09T10:23:27.301Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone"]
---

# REVIEW: listTasksByOwner cross-workstream test fabricates a state the new guard prevents (no live regression coverage)

## Notes (1)

### #1 by "test-reviewer-1", 2026-05-09T08:36:16.317Z

```
FILES: test/tasks.test.ts:1061-1090 ("returns tasks owned by an agent across workstreams"); src/tasks.ts (listTasksByOwner SQL).

WHAT THE TESTS CLAIM: The test pins the contract that listTasksByOwner CROSSES workstream boundaries — owner='worker-1' should surface task 'c' even when 'c' lives in workstream 'billing' but worker-1 was created in workstream 'auth'. The legitimate scenarios for this contract: (a) re-spawning an agent in a new workstream after it claimed in the old one, (b) operator hand-edits via mu sql.

WHAT THEY ACTUALLY VERIFY: The test deliberately uses raw SQL `UPDATE tasks SET owner = ?, status = 'IN_PROGRESS' WHERE local_id = ?` to fabricate the cross-workstream owner state, BECAUSE the verb path now rejects it (post-cross_workstream_claim_for, claimTask --for raises AgentNotInWorkstreamError). The comment at line 1068-1075 explicitly acknowledges this.

GAP: The test covers the contract on a state that ONLY operator hand-edits or post-respawn migration can produce. Two concerns:
  1. The "re-spawn an agent in a new workstream" scenario would require deleting the agent (cascading owner→NULL via FK ON DELETE SET NULL on tasks.owner) and re-inserting it. So that scenario can't actually produce the cross-workstream owner state — the FK CASCADE wipes the owner column. The only scenario left is operator hand-edits via mu sql.
  2. Therefore the test is pinning a contract that, in normal operation, should never arise. If the contract changes — e.g. someone adds a guard to listTasksByOwner that filters `WHERE workstream = ?` — the test fails, but the failure is "you broke a contract that only operator-SQL hand-edits exercise". The test cost doesn't match the bug-prevention value.

The deeper question: should listTasksByOwner cross workstream boundaries at all, given the FK CASCADE makes it nearly impossible to legitimately produce that state? If the answer is "yes, for forensics on sql-edited DBs", the test is correct but should EXPLICITLY say "this is forensics-only behaviour; do not expand the contract". If the answer is "no, this is a residual leak from before cross_workstream_claim_for", the test should be rewritten to assert `listTasksByOwner` filters by workstream.

WHY IT MATTERS: 40. Not a regression-guard for any production path. It's a test that exists to defend a non-load-bearing behavior. Risk: future refactor that adds the workstream filter would fail this test, then someone adds back the cross-workstream logic to make the test pass — and the cross_workstream_claim_for guard's spirit erodes by accretion.

SUGGESTED FIX: Decide intent. Either:
  (a) Keep the test, BUT rename it to `forensics: listTasksByOwner surfaces sql-hand-edited cross-workstream owners (mu sql migration aid)` and add a comment line: "Do NOT add a verb that creates this state — the only legitimate producer is operator SQL." ~3 LOC comment.
  (b) Delete the test and tighten listTasksByOwner with a workstream filter. ~10 LOC removed + ~5 LOC added.
  My read: (a) preserves the audit trail, captures the intent, lowers the test's apparent importance.

EVIDENCE: test/tasks.test.ts:1067-1075 — the comment honestly acknowledges the test fabricates state the verb rejects. test/tasks.test.ts:1080-1083 — `setOwner.run("worker-1", "c")` raw SQL update. src/tasks.ts (FK on tasks.owner): `ON DELETE SET NULL` — re-spawning the agent (delete + re-insert) wipes ownership.
```
