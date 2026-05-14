---
id: "testreview_wait_5s_default_timeout_flake"
workstream: "mufeedback-v03"
status: CLOSED
impact: 65
effort_days: 0.2
roi: 325.00
owner: null
created_at: "2026-05-10T11:32:04.883Z"
updated_at: "2026-05-10T12:05:20.886Z"
blocked_by: []
blocks: []
---

# test-review: cli-task-wait.integration last test flakes at default 5s vitest timeout under full-suite load

## Notes (3)

### #1 by "reviewer-2", 2026-05-10T11:32:21.257Z

```
FILES: test/cli-task-wait.integration.test.ts (line 247-267, the cross-ws qualified-refs test)
FINDING: This test relies on tmux fan-out (kill pane mid-wait, then poll until reaper-flip + exit-6) and runs in <2s in isolation but TIMES OUT at the default vitest 5000ms when the full suite runs (full-suite shows 1 fail today; isolation passes 6/6 in 3.4s). Other tests in the same file have generous --timeout 30/60 SECOND args to mu task wait, but the vitest test wrapper has no per-test timeout, so the suite-wide default applies.

Reproduction: this run, npm run test → "Test timed out in 5000ms" on the cross-ws qualified-refs test. npx vitest run test/cli-task-wait.integration.test.ts → all 6 pass.

WHY: The flake masks real signal. CI gates mention 4-green-before-commit; a recurring flake here makes the suite "noisy" and trains operators to retry rather than investigate. The other reaper tests in the same file (4 of them) are equally tmux-dependent but pass reliably in <2s because they assert sooner (single ws, single pane death), so the cross-ws variant is the canonical victim.

FIX-SKETCH: Add per-test timeout: it("cross-ws qualified refs: ...", { timeout: 15000 }, async () => { ... }) — the canonical it(name, opts, fn) form. 15s gives 7x headroom over the observed isolation time without making the suite noticeably slower. Same treatment for the sister "reaper-flip on UNWATCHED workstream B" test (1.9s isolation; one tmux + 2 panes; same risk).
```

### #2 by "π - mu", 2026-05-10T11:42:18.761Z

```
OPERATOR: rejected my own duplicate cli_task_wait_integration_flakes_under_load (filed minutes apart; same bug; same root cause; same recommended fix). reviewer-2 got there first via the test-review path. THIS task remains the canonical filing; consult my rejected task for additional spec details (vitest config sequential pool + 30s timeout belt-and-suspenders + suite-split open question). Worker on this task should also defer the suite-split decision back to operator.
```

### #3 by "worker-5", 2026-05-10T12:05:05.902Z

```
DEFER TO OPERATOR (suite-split): operator's rejected duplicate raised the suite-split open question. Not addressed here — current fix (singleFork + 30s testTimeout) keeps test/ flat and lands all 1032 tests green in ~58s. Suite-split (unit/ vs integration/) is a layout decision that touches CI scripts + AGENTS.md test docs; worth its own task if someone hits the wall-clock cost in CI.
```
