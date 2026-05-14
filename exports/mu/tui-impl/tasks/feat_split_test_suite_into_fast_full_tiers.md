---
id: "feat_split_test_suite_into_fast_full_tiers"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.4
roi: 137.50
owner: "worker-2"
created_at: "2026-05-13T06:11:50.840Z"
updated_at: "2026-05-13T08:21:09.071Z"
blocked_by: []
blocks: []
---

# FEAT: split test suite into 'fast' (unit / sub-second) and 'full' (current ~2min) tiers; pre-commit hook + dev loop runs fast; CI + commit-time runs full

## Notes (3)

### #1 by "π - mu", 2026-05-13T06:13:49.802Z

```
MOTIVATION (verbatim user)
--------------------------
"realted. consider additn 2 tier testing; fast and full."

⚠️ CRITICAL CONTEXT — MULTI-AGENT CONCURRENT TEST RUNS ⚠️
-----------------------------------------------------------
This repo's typical workflow runs **multiple pi worker agents concurrently on the SAME machine, each running `npm run test` in their own workspace at the same time**. The fast tier here is doubly valuable:
  - On the dev loop, faster iteration.
  - On a busy session with 3+ workers verifying in parallel, the slow integration tests are the things that race against each other (file system, subprocess, tmux). A FAST tier that doesn't touch external resources is also CONCURRENCY-SAFE — workers can run it freely without interfering. The FULL tier still needs careful isolation (handled by the related bug_test_suite_flakes_audit_and_remediate task).

CURRENT STATE
-------------
- `npm run test` runs the full vitest suite. ~2 minutes wall-clock for ~2290 tests. ~150 test files.
- Mix of pure-unit tests (sub-millisecond) and integration tests (vcs subprocess fixtures: 100ms-3s each; tmux integration: 100ms-2s each).
- Fast tests dominate the count; slow tests dominate the wall time.

LOCKED DESIGN
-------------
TWO TIERS (vitest convention via test:fast / test):

  **FAST TIER** (`npm run test:fast`):
  - All `*.test.ts` files NOT marked as integration / slow.
  - Pure unit tests, mocked tmux/vcs, in-memory or temp-dir SQLite.
  - Target: <10 seconds wall-clock.
  - Concurrency-safe (no external resource contention).
  - Suitable for: dev loop, pre-commit hook, every keystroke change.

  **FULL TIER** (`npm run test` — unchanged behaviour, alias kept for back-compat):
  - Everything in fast tier PLUS:
  - All `*.integration.test.ts` files (real tmux server).
  - All `*.smoke.test.ts` files if any (real subprocess fixtures: vcs-commits-show.test.ts spawns real git/jj/sl).
  - Target: current ~2min wall-clock.
  - Suitable for: pre-push, CI, before commit when touching VCS / tmux / cross-process logic.

CLASSIFICATION RULES
--------------------
A test file is FAST if all of:
  - No real subprocess spawn (tmux, git, jj, sl, etc).
  - No filesystem operations beyond the test's own temp DB.
  - No timing-dependent assertions (no fixed sleep > 50ms).
  - No tmux integration.

A test file is FULL-ONLY (slow) if any of:
  - Spawns real tmux server (look for `setTmuxExecutor` set to NULL / `process.env.TMUX` / `tmux new-session` calls).
  - Spawns real git / jj / sl in a fixture repo.
  - File suffix already `.integration.test.ts` (existing convention).

Audit each file in test/ and assign a tier. Most should be fast. The ~10-20 integration files become full-only.

IMPLEMENTATION
--------------
OPTION A — file-suffix routing:
  - `test/foo.test.ts` → fast.
  - `test/foo.integration.test.ts` → full-only.
  - vitest.config.ts gains a `test:fast` config that sets `include: ["test/**/*.test.ts"]` AND `exclude: ["test/**/*.integration.test.ts"]`.
  - `test:full` (or just `test`) keeps the current `include: ["test/**/*.test.ts"]` (matches both since `*.integration.test.ts` is also `*.test.ts`).
  - Add scripts to package.json:
      "test:fast": "vitest run --config vitest.fast.config.ts",
      "test": "vitest run",                  // existing, full
      "test:watch": "vitest",                // existing
  - Some tests may need RENAMING to gain the `.integration` suffix. Audit the test/ tree against the classification rules above and rename any slow tests that lack the suffix.

OPTION B — vitest tags (`vi.test.skipIf` / `describe.skipIf`):
  - Tag slow tests inline.
  - More flexible (file-level vs test-level tier).
  - More invasive (every slow test needs a tag).

PREFER OPTION A — file-suffix is the existing convention (`.integration.test.ts` already exists).

EXISTING USAGE OF .integration SUFFIX
-------------------------------------
Per AGENTS.md: tests with `.integration.test.ts` need `$TMUX` set; CI runs inside tmux. So the suffix is ALREADY a tier marker — just promote it to a script that filters on it.

WIRING
------
- vitest.fast.config.ts (NEW): extends the base config with `exclude: ["**/*.integration.test.ts", "**/*.smoke.test.ts"]`. Maybe also exclude any single-file slow tests not yet renamed.
- package.json scripts:
  "test:fast": "vitest run --config vitest.fast.config.ts",
  "test": "vitest run"  (unchanged)
  "test:watch:fast": "vitest --config vitest.fast.config.ts" (optional)
- If audit finds slow tests not using `.integration` suffix, RENAME them. Example candidates:
  * test/vcs-commits-show.test.ts (spawns real git/jj/sl) → test/vcs-commits-show.integration.test.ts
  * test/vcs-detect.test.ts (likely real git fixtures) → check.
  * test/cli-task-wait-nextsteps.integration.test.ts (already correctly named).
  * Any test/*.test.ts that imports `setVcsExecutor(null)` or doesn't set a mock tmux executor.

⚠️ COORDINATION ⚠️
- Bug bug_test_suite_flakes_audit_and_remediate (sibling task, independent).
- The two tasks COMPLEMENT each other: this task partitions tests into tiers; the flake task fixes flakes within each tier. Either order works; ideally land both in the same week.

⚠️ BUNDLE CYCLE WARNING ⚠️
This task touches package.json + vitest.config.ts + maybe renames test files. No src/ changes, no bundle risk. After:
  npm run typecheck && npm run lint && npm run build  (still required)
  npm run test:fast   (NEW; should pass <10s)
  npm run test        (unchanged; still ~2min)

VERIFY MANUALLY
---------------
After the change:
  cd /Users/mtrojer/hacking/mu
  npm run test:fast  →  passes in <10 seconds.
  npm run test       →  passes in ~2min (full suite).
  Touch a TUI file → run test:fast for the dev loop.
  Before commit (especially when touching VCS / tmux): npm run test.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build

CONSTRAINTS
-----------
- 1500 LOC hard cap (this is mostly config + renames).
- Conventional commit prefix: `tests:`
- Suggested commit:
    tests: split suite into fast (<10s) and full (~2min) tiers; npm run test:fast for the dev loop, npm run test stays the full gate

DOCS
----
- CHANGELOG.md [Unreleased] under "Tests" or "Tooling":
  * "Test suite split into two tiers: `npm run test:fast` runs only pure-unit tests in <10s (suitable for dev loop / pre-commit); `npm run test` runs the full suite (~2min) including integration tests that spawn real tmux/git/jj/sl. The `.integration.test.ts` suffix marks slow tests; the fast config excludes them. The four-greens-pre-commit gate still requires `npm run test` (full)."
- AGENTS.md "Build / test / lint" section: update to recommend `test:fast` for the dev loop and `test` (full) for the pre-commit gate.
- docs/USAGE_GUIDE.md if it references test commands.

OUT OF SCOPE
------------
- Don't ALSO change which tier is the pre-commit default (still full per existing AGENTS.md gate; fast is dev-only).
- Don't introduce a third tier (e.g. "smoke") — defer.
- Don't reorganize test/ directory layout.
- Don't migrate flake remediations into this task — that's the sibling task.

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>.

⚠️ FINAL ACTION ⚠️
After committing + four greens green + npm run test:fast under 10s, close YOUR task with:
  mu task close feat_split_test_suite_into_fast_full_tiers -w tui-impl --evidence "<sha>: test:fast <Xs / N tests; test full <Ys / M tests; .integration suffix promoted to tier marker"
```

### #2 by "worker-2", 2026-05-13T08:21:04.505Z

```
FILES: package.json; vitest.fast.config.ts; AGENTS.md; docs/ARCHITECTURE.md; docs/USAGE_GUIDE.md; CHANGELOG.md; test/*.integration.test.ts renames.
COMMANDS: npm run typecheck (0); npm run lint (0); npm run test:fast -- --reporter=dot (0, 4.24s / 84 files / 1284 tests); npm run test -- --reporter=dot (0, 94.64s / 154 files / 2313 tests); npm run build (0).
FINDINGS: Fast config excludes *.integration.test.ts and *.smoke.test.ts; npm run test remains full.
DECISION: Promoted .integration.test.ts suffix to full-only tier marker and renamed slow/substrate-heavy suites.
NEXT: None.
VERIFIED: Four-green gate plus fast tier passed locally.
ODDITIES: Fast target is under 10s in reporter duration (4.24s), while shell wall can include harness overhead/noisy hints.
```

### #3 by "worker-2", 2026-05-13T08:21:09.071Z

```
CLOSE: 51d2f1e: test:fast 4.24s / 1284 tests; test full 94.64s / 2313 tests; .integration suffix promoted to tier marker
```
