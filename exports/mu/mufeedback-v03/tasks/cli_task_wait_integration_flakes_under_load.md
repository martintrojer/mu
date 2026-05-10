---
id: "cli_task_wait_integration_flakes_under_load"
workstream: "mufeedback-v03"
status: REJECTED
impact: 40
effort_days: 0.3
roi: 133.33
owner: null
created_at: "2026-05-10T11:40:13.578Z"
updated_at: "2026-05-10T11:42:18.646Z"
blocked_by: []
blocks: []
---

# fix: cli-task-wait integration tests flake under full-suite load (cross-ws reaper test most affected); single-file run is green

## Notes (1)

### #1 by π - mu, 2026-05-10T11:40:47.242Z

```
cli-task-wait integration test flakes under full-suite parallelism.

═══ THE OBSERVED FLAKE (this session, 3+ hits) ═══

Single-file: `npm run test test/cli-task-wait.integration.test.ts` → all 6 pass, ~4s.
Full-suite:  `npm run test` → the cross-ws reaper-isolation test sometimes fails:
  ❯ test/cli-task-wait.integration.test.ts (6 tests | 1 failed) 10036ms
  FAIL  ... > mu task wait — cross-workstream reaper isolation > cross-ws qualified refs: reaper on a watched ref in B fires exit 6

Same test passes in isolation; same test fails under full-suite load. Classic timing-sensitive integration-test flake.

reviewer-2 also independently filed this as testreview_wait_5s_default_timeout_flake (ROI 325 — top hit) so two evidence sources point at the same root cause:
> "vitest test default timeout is 5s; under full-suite load (~1000 tests, real tmux + git interaction) the cross-ws integration test exceeds 5s; passes in <2s isolated."

═══ ROOT CAUSE HYPOTHESIS ═══

The cross-ws test:
  1. Spawns 2 short-lived tmux panes (slow under parallel-tmux contention).
  2. Spawns 2 mu agents in 2 different workstreams.
  3. Runs `mu task wait` with cross-ws qualified refs.
  4. Kills one pane mid-wait.
  5. Asserts wait returns exit 6 within ~poll-interval seconds.

Under full-suite load, steps 1-2's tmux spawns block on tmux's session-lock contention (every other integration test is creating + tearing down `mu-test-<random>` sessions concurrently). The 5s vitest timeout fires before mu's reconciler has had a chance to detect the killed pane and flip the task.

═══ FIX OPTIONS ═══

Option A (cheapest): bump vitest timeout for this specific test (or the whole file) via `it("...", { timeout: 30000 }, ...)` or `describe("...", { timeout: 30000 })`.
  + 1-line change.
  - Hides the underlying contention; future flakes will still surface.

Option B: serialize the integration tests via vitest's `--no-parallel` for *.integration.test.ts files (config in vitest.config.ts test.fileParallelism or pool option).
  + Removes the contention root cause for ALL integration tests.
  - Slows full-suite by ~30s (integration tests run sequentially).

Option C: shorter mu poll interval inside the wait verb (env override) so the test doesn't need wide timeout headroom.
  + Architecturally cleaner (faster wait by default would help every consumer).
  - Touches production code for a test concern; risky.

  RECOMMEND OPTION B + A combined: vitest.config.ts pools integration tests sequentially (option B); the cross-ws test gains an explicit 30s timeout (option A) as belt-and-suspenders. Net cost: ~30s added to full-suite runtime; flake gone.

═══ ALTERNATIVE: SUITE-LEVEL DECISION ═══

Worth asking: do we WANT integration tests in the full-suite run at all, or should `npm run test` skip *.integration.test.ts and `npm run test:integration` be the dedicated invocation? The integration tests ARE valuable but their flake risk grows with every new tmux-touching test. Today's 47 tests + ~1000 unit tests + a real tmux server = exactly the contention this surfaces.

Operator decision needed: ship the fix (A+B), OR also split the suites?

═══ DELIVERABLE ═══

  vitest.config.ts: configure integration-file pool to sequential.
  test/cli-task-wait.integration.test.ts: add `{ timeout: 30000 }` to the cross-ws describe.
  CHANGELOG.md (v0.3 unreleased): one line.
  (Optionally: package.json adds test:integration / test:unit scripts; README + AGENTS.md note the split.)

═══ ANTI-FEATURES ═══

  - DON'T mock tmux to "fix" the flake. The integration tests exist to catch real tmux interactions; mocking defeats the purpose.
  - DON'T retry on flake (test.retry(N)). Hides the signal.
  - DON'T raise vitest's default timeout globally. Only the affected file.

═══ PROMOTION ═══

  - Real-user friction: 3+ flake hits in one session; reviewer-2 also filed.
  - Substrate: vitest config + one timeout annotation; trivial.
  - Fits in <300 LOC: yes (~30).

PROMOTE for v0.3 (release-blocker — flaky tests erode confidence).

═══ FINAL ACTION REMINDER ═══

⚠️ git commit -am '...' THEN mu task close cli_task_wait_integration_flakes_under_load -w mufeedback-v03 --evidence 'integration tests serialised + 30s timeout on cross-ws test; flake gone in 5 consecutive full-suite runs'
```
