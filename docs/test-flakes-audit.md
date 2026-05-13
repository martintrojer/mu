# Test flake audit

This is the working inventory for `bug_test_suite_flakes_audit_and_remediate`.
The dominant hidden variable is mu's dogfood workflow: multiple pi
agents commonly run `npm run test` concurrently on the same machine,
each from its own workspace. A test that passes alone but fails when
another full vitest run is active is therefore treated as a
concurrency bug first, not as an unrelated one-off.

## Stress gate

`npm run test:stress` runs `tools/test-stress.sh`, which stores one log
per run under `.mu-test-stress/` by default and greps failed logs for
Vitest failure markers.

Useful invocations:

```bash
npm run test:stress
MU_TEST_STRESS_RUNS=5 npm run test:stress
MU_TEST_STRESS_MODE=parallel MU_TEST_STRESS_PARALLEL=2 npm run test:stress
npm run test:stress -- -- test/vcs-commits-show.test.ts
```

Defaults are intentionally boring: 30 serial full-suite runs, with a
600s per-run timeout so a wedged Vitest process tree fails loudly
instead of hanging the audit. The parallel mode simulates the
multi-agent workflow by running two full suites concurrently for each
wave.

## Inventory

| Test | Bucket | Evidence | Remediation | Status |
| --- | --- | --- | --- | --- |
| `test/vcs-commits-show.test.ts > slBackend recentCommits + showCommit > lists commits and shows a commit` | File-system/subprocess race | Baseline targeted loop: 5 failures in 10 runs. Failure was `ENOTEMPTY` from `afterEach` while removing the sl fixture directory; the leftover was `.hg/blackbox/v1/0`, consistent with Sapling background/log file activity racing cleanup. Logs copied to `.mu-test-stress/baseline-vcs-run-*.log`. | Added `test/_fs.ts` `rmFixtureDir()` using Node's built-in retry loop (`maxRetries: 10`, `retryDelay: 50`) and switched the VCS cleanup helpers to it. | Fixed; 10/10 targeted rerun passed after remediation. |
| `test/vcs-commits-show.test.ts > noneBackend recentCommits + showCommit > returns empty commits and graceful show error` | Cascaded cleanup failure | Appeared once in the same baseline targeted loop after the previous test's `afterEach` threw before clearing the shared `dirs` array. | Same `rmFixtureDir()` fix; no independent product-code failure. | Fixed by the sl cleanup remediation. |
| `test/vcs-detect.test.ts` sl-backed fixtures | File-system/subprocess race risk | Same pattern as `vcs-commits-show`: sl initializes `.hg`/`.sl` fixture state and the file used plain recursive `rmSync`. Not observed in the 10-run targeted sample but shares the same cleanup shape. | Switched shared fixture cleanup and the git-worktree pre-remove to `rmFixtureDir()`. | Preventive fix. |
| `test/state-helpers.test.ts > loadWorkstreamSnapshot > populates commitsBackend from the detected VCS` | File-system/subprocess race risk | Uses the same shared VCS temp-dir helper pattern; under concurrent-agent runs, VCS subprocess teardown can lag a plain recursive `rmSync`. | Switched shared cleanup to `rmFixtureDir()`. | Preventive fix. |
| `test/cli-task-wait.integration.test.ts > cross-ws qualified refs: reaper on a watched ref in B fires exit 6` | Async/subprocess race | Full `npm run test:stress` found 2 failures in 30 runs (serial-24 and serial-30). The fixed 100ms `setTimeout(killPane)` could fire before the CLI reached `waitForTasks()` and seeded the prior-state map under a loaded suite; then the reaper flip became the initial observed state and the wait timed out. | Replaced fixed timers in reaper wait tests with a test seam that performs the kill/close action during the first `waitForTasks` sleep, after the initial snapshot is known to exist. | Fixed; targeted `cli-task-wait.integration` 5/5 stress passed. A later full stress attempt was operator-aborted after 2 consecutive full-suite passes because 30× is too slow for an agent turn. |
| TUI Ink render tests (`test/tui-row-budget-overflow.test.ts`, `test/tui-titled-box-render.test.ts`) | Async render race | The known symptom is an assertion reading stdout before Ink has flushed the frame. Existing helpers waited a fixed 40ms, which is vulnerable on loaded machines. | Replaced the fixed 40ms helper with `waitForInkOutput()`, which polls until output is non-empty and stable for two samples (1s cap). `tui-titled-box-render` now uses the same helper. | Preventive fix; targeted TUI render tests passed. |
| `test/acceptance.test.ts` | Concurrent-agent/subprocess load | Anecdotal session flake: integration-shaped real tmux + DB workflow sometimes fails unrelated assertions under system load. The file already uses `pollUntil()` for tmux state propagation and unique `mu-test-<pid>-<ts>-<rand>` workstream names. | No inline change from this audit. Keep it in `test:stress`; if it recurs, inspect the stress log first for tmux socket fallback or slow pane teardown. | Watch. |
| Various TUI-state hook tests | Async race / test-logic risk | Anecdotal session flake: a tick expected to have fired has not. Current state-hook tests are mostly pure/static; any future hook-driving test should avoid fixed sleeps and use `vi.waitFor()` or a local poll. | This audit removed fixed sleeps from the Ink render helper; no broad hook rewrite was needed. | Watch. |

## Remediation notes

- `rmFixtureDir()` is intentionally small and test-only. It does not
  hide persistent leaks forever: after ~500ms of retries, Node still
  throws the real cleanup error.
- The cleanup retry targets the long tail of substrate races (sl/git/jj
  file activity) and is safe for concurrent-agent runs because every
  fixture still uses `mkdtempSync()` with a random suffix.
- No global Vitest parallelism overhaul was made. The existing
  `singleFork: true` remains the suite-level guard for tmux contention
  within one `npm run test`; the stress script covers contention
  between multiple full-suite processes.

## Commands run during this audit

```bash
npm test -- test/vcs-commits-show.test.ts
# baseline targeted loop: 5/10 failed before cleanup retry
npm test -- test/vcs-commits-show.test.ts test/vcs-detect.test.ts test/state-helpers.test.ts test/tui-row-budget-overflow.test.ts test/tui-titled-box-render.test.ts
# targeted post-fix loop: 10/10 passed for test/vcs-commits-show.test.ts
MU_TEST_STRESS_RUNS=2 MU_TEST_STRESS_OUT_DIR=/tmp/mu-stress-smoke npm run test:stress -- -- test/vcs-commits-show.test.ts
MU_TEST_STRESS_RUNS=1 MU_TEST_STRESS_PARALLEL=2 MU_TEST_STRESS_MODE=parallel MU_TEST_STRESS_OUT_DIR=/tmp/mu-stress-parallel-smoke npm run test:stress -- -- test/vcs-commits-show.test.ts
# full stress found the cli-task-wait race above before remediation
MU_TEST_STRESS_RUNS=5 MU_TEST_STRESS_OUT_DIR=/tmp/mu-wait-stress npm run test:stress -- -- test/cli-task-wait.integration.test.ts
```
