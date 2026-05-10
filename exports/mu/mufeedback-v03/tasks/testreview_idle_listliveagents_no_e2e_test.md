---
id: "testreview_idle_listliveagents_no_e2e_test"
workstream: "mufeedback-v03"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: null
created_at: "2026-05-10T11:32:26.131Z"
updated_at: "2026-05-10T12:16:36.981Z"
blocked_by: []
blocks: []
---

# test-review: agent-idle has no end-to-end test that listLiveAgents enriches idle:true on a real row

## Notes (1)

### #1 by reviewer-2, 2026-05-10T11:32:40.955Z

```
FILES: test/agent-idle.test.ts (lines 71-130 predicate tests; 135-169 JSON shape); compare against test/verbs.test.ts listLiveAgents block (810-967), which never exercises the idle field; src/agents.ts:733 (listLiveAgents enrichment site)
FINDING: agent-idle.test.ts covers only the pure computeAgentIdle predicate AND the post-enrichment JSON/render path (using a hand-crafted { ...row, idle: true } AgentRow). There is no test that drives listLiveAgents end-to-end and asserts that the returned rows have idle:true / idle absent for the matching cases. A regression where listLiveAgents simply forgets to call computeAgentIdle (or only calls it under a particular mode, e.g. mode:full) would silently pass every existing test in agent-idle.test.ts AND every existing test in verbs.test.ts.

WHY: The CHANGELOG calls idle "the third agent lifecycle state"; this is the load-bearing surface for v0.3 idle detection. The whole point of the predicate is its enrichment side-effect at listLiveAgents. Asserting only on the predicate is the classic "test the helper, not the wiring" smell from the test-reviewer skill.

FIX-SKETCH: Add 2-3 tests in agent-idle.test.ts (or test/verbs.test.ts listLiveAgents describe block):
  it("listLiveAgents enriches idle:true on a stale-needs_input + IN_PROGRESS-owning agent")
  it("listLiveAgents leaves idle absent on a fresh-needs_input row")
  it("listLiveAgents enriches idle on every applicable mode (full / status-only / report-only)")
Each test:  insertAgent + addTask + setTaskStatus IN_PROGRESS + back-date updated_at; mock tmux executor returning the pane as alive; assert (await listLiveAgents(...)).agents[0].idle === true (or undefined).
```
