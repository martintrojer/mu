---
id: "bug_test_suite_flakes_audit_and_remediate"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.5
roi: 130.00
owner: "worker-3"
created_at: "2026-05-13T06:11:50.538Z"
updated_at: "2026-05-13T07:56:02.570Z"
blocked_by: []
blocks: []
---

# BUG: test suite has intermittent failures (1-2 of ~2290 tests fail per run, different tests each time, all pass on individual re-run); audit, classify, and remediate the flake population

## Notes (4)

### #1 by "π - mu", 2026-05-13T06:13:49.452Z

```
MOTIVATION (verbatim user)
--------------------------
"add a task to ananlzye the flakey test and come up with remedies."
"please add tot the notes here that there are often multiple agetns running in same test suite concurrently on the same machine."

⚠️ CRITICAL CONTEXT — MULTI-AGENT CONCURRENT TEST RUNS ⚠️
-----------------------------------------------------------
This repo's typical workflow runs **multiple pi worker agents concurrently on the SAME machine, EACH running `npm run test` in their own workspace at the same time**. Two workers cherry-pick + verify in parallel during a wave; on a busy session there can be 3+ vitest processes running simultaneously, each spawning sub-processes (tmux integration tests, real git worktrees, sl/jj fixtures).

This is the BIGGEST hidden source of flake. Tests that work fine in isolation can fail under concurrent load because of:
  - **Shared /tmp directories**: fixtures race on directory creation/cleanup. We've already seen `vcs-commits-show.test.ts` flake with `ENOTEMPTY: Directory not empty` during cleanup — exactly this race.
  - **Default tmux socket collisions**: even though the test suite uses MU_TMUX_SOCKET (per `_global-teardown.ts`), any test that bypasses the env var (or that the agents started before the env was set) will collide.
  - **tmux session-name space**: `mu-test-<pid>-<ts>-<rand>` should be unique enough, but races on the random suffix can collide if the rand source is seeded or if the suffix is short.
  - **Port collisions**: any HTTP server / socket binding (less of an issue here; mu doesn't bind ports, but worth checking).
  - **Process tree pollution**: a parent test that forks a long-running subprocess can leak it; a sibling test (in a different worker's vitest run) sees the leaked process.
  - **better-sqlite3 native binary**: the handoff notes this can drop on node version changes; concurrent `npm install` on different agents amplifies the risk.

Any audit of flakes MUST factor this in. A flake that "passes in isolation" but fails under load is a CONCURRENCY bug, not a test logic bug. Fixes typically: stronger fixture isolation (per-pid tmpdirs), opt-in serial execution for FS/process-level tests, retry-with-backoff on cleanup races.

KNOWN FLAKES (THIS SESSION)
---------------------------
Recurring failures observed during cherry-pick verification:
  1. `test/vcs-commits-show.test.ts > slBackend recentCommits + showCommit > lists commits and shows a commit`
     - Symptom: ENOTEMPTY on rmSync in afterEach.
     - Pattern: test creates a temp dir, runs `sl` subprocess, tries to clean up while sl background processes still hold file handles.
     - Already noted as flaky in this session's wave 11 verify.
  2. Various TUI-state hook tests: occasionally fail with timing-sensitive assertions (a "tick" expected to have fired hasn't).
  3. Acceptance test (test/acceptance.test.ts): the integration-shaped "everything works" test sometimes fails on an unrelated assertion when the system is under load.
  4. (Anecdotal) various tests fail once per ~5 full runs; passes on retry.

THE AUDIT (SCOPE)
-----------------
Three deliverables:

A. **Flake INVENTORY**: run `npm run test` 30+ times in a row (script + log). Capture every test that fails AT LEAST ONCE. Bucket by:
   - File-system race (fixture cleanup, temp dir reuse).
   - Subprocess race (tmux/git/jj/sl child not waited).
   - Async race (setTimeout/poll-loop assumes a tick fired but didn't).
   - Concurrent-agent race (only fails when 2+ vitest workers run in parallel).
   - Test-logic bug (stale-reference / rule-of-hooks / etc — would fail every time, currently masked).

B. **Per-flake remedies** (file as separate child tasks if needed):
   - FS races: per-pid tmpdir + retry-on-ENOTEMPTY + explicit subprocess wait.
   - Subprocess races: explicit `await spawnSync({ stdio: 'pipe' })` + check exit; never fire-and-forget.
   - Async races: replace fixed sleep() with pollUntil() or vi.waitFor() (prior session shipped this for tmux integration; sweep for any leftovers).
   - Concurrency: gate flaky test files via vitest.config.ts `test: { isolate: true, fileParallelism: false }` for a specific concurrent-incompatible bucket. Or move to a separate `*.serial.test.ts` suffix that vitest runs in a serial worker pool.
   - Test logic: fix the bug.

C. **Multi-agent concurrent test gate**: add a Makefile / script `npm run test:stress` that runs `npm run test` N times back-to-back AND simulates multi-agent load (e.g. 2 parallel `npm run test` instances). Flag any test that fails under this stress. Make this part of the pre-release ritual.

ADDITIONAL CONTEXT
------------------
- Tests use `test/_setup.ts` (vitest setupFiles) to scrub MU_* env vars per fork.
- `_global-teardown.ts` sets MU_TMUX_SOCKET at MODULE LOAD TIME (per its header — the comment notes this is BEFORE vitest spawns the worker pool, for Layer-3 isolation).
- `_runCli.ts` sets MU_DB_PATH per test → per-test temp DB.
- Each integration test gets a unique tmux session: `mu-test-<pid>-<ts>-<rand>`.
- Default-socket sweep at start AND end via `_global-teardown.ts` (allowlist-based; reads workstreams from REAL DB).

The infrastructure for isolation is GOOD. The remaining flake population is in the long tail (subprocess waits, fixture cleanup races, occasionally a ref bug).

⚠️ COORDINATION ⚠️
This task is INDEPENDENT of every in-flight feature/bug. It's pure test-suite hygiene. Can be dispatched any time.

⚠️ BUNDLE CYCLE WARNING ⚠️
This task probably doesn't touch src/ much (mostly test/ and root scripts), so cycle risk is low. After build (the audit will likely add a script + maybe a setup helper):
  npm run build && node dist/cli.js --help && node dist/cli.js --version

HOW TO START
------------
1. Write a small script `tools/test-stress.sh` (or shell loop) that runs `npm run test` 30 times, captures stdout to a file per run, and greps for "Failed Tests" / "× " / "FAIL " markers. Tally per-test failure counts.

2. Identify the top-10 flakiest tests. For each, classify by the bucket above.

3. For each flake, file a remediation child-task (or fix inline if trivial — e.g. wrapping rmSync in a try-loop with a 50ms backoff is one-line).

4. Add a `npm run test:stress` script (alias for the loop above) so future audits are one command.

5. Update CHANGELOG with the flake-audit summary + per-flake fix references.

DELIVERABLES (LOCKED)
---------------------
- A markdown report file: docs/test-flakes-audit.md (or similar). Lists each flaky test, classification, remediation.
- 1 or more remediation commits.
- A `npm run test:stress` script.
- CHANGELOG entry under "Tests" or "Reliability".

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
  npm run test:stress  (NEW; should pass 30/30 after remediations)

CONSTRAINTS
-----------
- 1500 LOC hard cap (audit + per-fix). Each remediation small.
- Conventional commit prefix: `tests:` (multiple commits per remediation; one umbrella docs commit).
- Suggested umbrella commit:
    tests: audit + remediate flake population (multi-agent concurrent test runs are the dominant root cause)
- Four greens before each fix commit + the umbrella audit doc commit.

DOCS
----
- CHANGELOG.md [Unreleased] under "Tests":
  * "Test suite flake population audited and remediated. The previously intermittent ~1/run failure rate (different test each time, passes on isolated re-run) was driven primarily by multi-agent concurrent test runs (the repo's standard dev workflow runs multiple pi workers' `npm run test` in parallel on the same machine). Per-fix details in `docs/test-flakes-audit.md`. New `npm run test:stress` runs the full suite 30× back-to-back; CI gate."
- docs/test-flakes-audit.md (NEW): the inventory + remediation log.
- AGENTS.md "Tests" section: brief mention of the multi-agent concurrent context + the test:stress gate.

OUT OF SCOPE
------------
- Don't overhaul vitest.config.ts globally (just add per-test-file `isolate` opts where needed).
- Don't add ink-testing-library (was rejected this session).
- Don't add a CI-only retry wrapper (mask-the-bug; we want to FIX the flakes).
- Don't strip or skip flaky tests (the goal is to FIX them, not silence).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>.

⚠️ FINAL ACTION ⚠️
After committing all remediations + the audit doc + four greens green + 30/30 test:stress, close YOUR task with:
  mu task close bug_test_suite_flakes_audit_and_remediate -w tui-impl --evidence "<sha>: <one-line summary including 'audit doc + N remediation commits + test:stress 30/30'>"
```

### #2 by "worker-3", 2026-05-13T06:17:14.999Z

```
FILES: pending
COMMANDS: mu task note bug_test_suite_flakes_audit_and_remediate -w tui-impl ...
FINDINGS: Added the user-specified flake-audit context to the durable task notes. Critical audit constraint: typical mu dogfood workflow runs multiple pi worker agents concurrently on the SAME machine, each running npm run test in isolated workspaces at the same time. Flakes that pass in isolation but fail under this load should be treated as concurrency bugs first (shared /tmp cleanup, tmux socket/session collisions, leaked subprocess/process tree pollution, native install races).
DECISION: Factor concurrent-agent stress into the audit doc, AGENTS.md testing guidance, and npm run test:stress implementation.
NEXT: inspect known flaky tests, add stress script, remediate small cleanup races, document inventory.
VERIFIED: note command exit 0
ODDITIES: none
```

### #3 by "worker-3", 2026-05-13T07:55:57.494Z

```
FILES: docs/test-flakes-audit.md; tools/test-stress.sh; package.json; AGENTS.md; CHANGELOG.md; test/_fs.ts; test/_ink-render.ts; test/{vcs-commits-show,vcs-detect,state-helpers,tui-titled-box-render,cli-task-wait.integration}.test.ts
COMMANDS: npm run typecheck (0); npm run lint (0); npm run test (0); npm run build (0); node dist/cli.js --help (0); node dist/cli.js --version (0); targeted stress smoke for vcs commits (0); timeout smoke for stress runner (expected timeout path, script exit 1); full test:stress attempted but operator stopped it after 2 consecutive full-suite passes because 30x is too slow for an agent turn.
FINDINGS: Confirmed the known sl cleanup flake with 5/10 targeted failures before remediation. Full stress found an additional task-wait reaper fixed-timer race at serial-24 and serial-30 before remediation. Multi-agent concurrent test runs remain the key audit lens.
DECISION: Added bounded test:stress with per-run timeout instead of unbounded loops; documented full inventory and pragmatic verification status.
NEXT: Do not claim 30/30 in the close evidence; if release requires it, run test:stress outside an agent turn or lower MU_TEST_STRESS_RUNS for normal development.
VERIFIED: commit 059807a; four greens pass; build help/version pass; targeted stress and timeout smoke pass.
ODDITIES: test:stress 30x was intentionally not completed after user called out runtime/timeout concerns.
```

### #4 by "worker-3", 2026-05-13T07:56:02.570Z

```
CLOSE: 059807a: audit doc + 3 remediation clusters + bounded test:stress; four greens pass; targeted stress passes (30/30 intentionally not run in agent turn)
```
