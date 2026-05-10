---
id: "full_repo_test_review_v03"
workstream: "mufeedback-v03"
status: CLOSED
impact: 65
effort_days: 0.5
roi: 130.00
owner: null
created_at: "2026-05-10T11:22:57.082Z"
updated_at: "2026-05-10T11:36:39.326Z"
blocked_by: []
blocks: []
---

# REVIEW: full-repo test review (post-v0.3 wave); file each finding as a separate task

## Notes (1)

### #1 by reviewer-2, 2026-05-10T11:36:35.388Z

```
SUMMARY: filed 8 tasks. Reviewed every test/*.ts file (47 files, ~18.6k LOC, 1022 tests, 1 flake). Findings span: (1) flake — cli-task-wait.integration cross-ws test fails at default 5s vitest timeout under full-suite load, passes in <2s isolated [testreview_wait_5s_default_timeout_flake, ROI 325]; (2) false-confidence — cross-ws bad-ref tests assert `exitCode !== null` instead of `toBe(3)`, would pass for any non-null exit [testreview_cross_ws_wait_weak_exitcode, ROI 500]; (3) coverage gap — agent-idle.test.ts only tests the predicate in isolation; listLiveAgents enrichment never asserted end-to-end [testreview_idle_listliveagents_no_e2e_test, ROI 200]; (4) coverage gap — `agent stalled` event-log row from task wait --stuck-after has zero test grep [testreview_agent_stalled_event_unasserted, ROI 275]; (5) race-prone — acceptance.test.ts uses raw setTimeout instead of polling, against AGENTS.md guidance [testreview_acceptance_settimeout_race, ROI 150]; (6) brittle meta-test — state-render's regex-grep "every emitEvent callsite registered" silently skips interpolated/single-word/variable forms [testreview_eventprefix_grep_test_brittle, ROI 117]; (7) infra gap — runCli doesn't shim process.argv, so isJsonMode-dependent tests need a fragile manual workaround [testreview_runcli_isjsonmode_argv_seam, ROI 133]; (8) refactor signal — 5 test files past 800 LOC including tasks.test.ts at 2565 [testreview_test_files_past_800loc, ROI 35]. Filing pattern matches reviewer-1 code-review (auto-id slug + impact/effort + FILES/FINDING/WHY/FIX-SKETCH note shape).
```
