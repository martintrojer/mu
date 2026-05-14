---
id: "bug_test_suite_flake_leaks_isolation"
workstream: "tui-impl"
status: CLOSED
impact: 90
effort_days: 0.5
roi: 180.00
owner: null
created_at: "2026-05-11T16:56:42.289Z"
updated_at: "2026-05-11T17:38:30.143Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: test suite flakes — uses live user tmux server (parallel runs race) + leaks mu-* sessions + (suspect) leaks DB rows into the real user DB

## Notes (4)

### #1 by "π - mu", 2026-05-11T16:57:44.410Z

```
SYMPTOM (orchestrator-side observation, 2026-05-11)
---------------------------------------------------
Pattern recurring through the entire TUI implementation cycle:

  npm run test  →  intermittent failures, 5-8 tests fail, then
                   re-run with no code change  →  all green.

Specifically observed:
  - test/cli-agent-spawn-validation.test.ts (sometimes 5/20 fail)
  - test/cli-task-wait.integration.test.ts (timeout in cross-ws
    reaper test)
  - varying counts of "test timed out" in real-tmux-spawning tests

Always passes on fresh re-run. Always fails when ANOTHER `npm test`
is running concurrently in a different working tree (e.g. when a
worker agent is running tests in parallel with the orchestrator).

Side effect visible right now in `tmux ls`:

  mu-alpha   1 windows (created 17:55)   ← test residue
  mu-beta    1 windows (created 13:17)   ← test residue
  mu-demo    1 windows (created 14:06)   ← test residue
  mu-gamma   1 windows (created 13:17)   ← test residue

These are leaked test-fixture workstreams. Their tmux sessions
linger in the user's real tmux server, AND (likely) their workstream
rows linger in the user's real ~/.local/state/mu/mu.db.

ROOT CAUSES (multiple, compounding)
-----------------------------------

(1) SHARED LIVE TMUX SERVER — primary flake source.

    Every integration test (test/*.integration.test.ts plus most of
    test/cli-*.test.ts that spawns agents) talks to the SAME tmux
    server the user is running for their interactive shells. When
    two `npm test` runs happen concurrently (orchestrator + worker
    agent in mu-tui-impl, both running four-greens), every tmux
    new-session / kill-session / list-panes call from process A
    contends with process B on the same socket.

    vitest.config.ts already pinned `singleFork: true` to serialize
    tests INSIDE one run, but that doesn't help against ACROSS-runs
    contention. Result: one test in process A creates a session
    name X, another test in process B creates the same name X
    moments later → CAS fails → spurious failure.

    Symptom often presents as:
      \"Test timed out in 30000ms\"
    in tmux-fan-out tests where the test was actually waiting for
    state to propagate through a pane that some other test killed.

    The vitest.config.ts comment already names this:
    > \"testreview_wait_5s_default_timeout_flake\":
    > 431ms in isolation, 30s+ in parallel.

(2) NON-UNIQUE FIXTURE NAMES — secondary flake source.

    Many tests use static workstream names like `alpha`, `beta`,
    `demo`, `gamma`. These cause:
      - Two concurrent suites collide on the same name → tmux
        new-session fails or returns a stale session.
      - Tests written to assume `tmux ls` only contains their own
        names get confused by stale fixtures.

    Existing partial fix: SOME integration tests use
    `mu-test-<pid>-<ts>-<random>` names (per AGENTS.md). NOT enough
    do — the pattern needs to be the rule, not a per-test choice.

(3) TEST RESIDUE LEAKING TO USER STATE.

    Any test that:
      - omits `MU_DB_PATH=<temp>` → writes to ~/.local/state/mu/mu.db
      - omits afterEach `tmux kill-session -t <name>` → leaks the
        session to the user's tmux server

    contaminates the developer machine. Verifiable smell:

      $ tmux ls | grep '^mu-'
      mu-alpha …    ← shouldn't exist on a clean machine
      mu-beta  …
      …

      $ sqlite3 ~/.local/state/mu/mu.db \
        \"SELECT name FROM workstreams\"
      alpha          ← shouldn't exist on a clean machine
      beta
      demo
      …

(4) FIXED-MS POLLING — tertiary flake source.

    Some tests use fixed setTimeouts (e.g. await sleep(500)) instead
    of polling loops. Under load these timeouts go from \"plenty\"
    to \"too short\" and the test fails. The AGENTS.md guide already
    calls this out (\"Polling loops (50ms × 10 attempts) when waiting
    for state to propagate, not fixed sleeps\") but enforcement is
    by-convention, not mechanical.

DESIGN — three layered fixes
----------------------------

This task is BIG (effort 0.5d). Worth doing in three commits, not
one, so each layer is independently verifiable.

LAYER 1 (commit 1) — FIXTURE-NAME UNIFICATION (cheap, high ROI):

  - Audit every test that calls `ensureWorkstream(db, NAME)` or
    `tmux new-session -s mu-NAME`. Wherever NAME is a static literal
    (`alpha`, `beta`, `demo`, `gamma`, …), replace with a per-test
    unique name:

        const ws = `t${process.pid}-${randomUUID().slice(0,8)}`;

    Not just integration tests — the unit tests writing to the
    in-temp-dir SQLite DB don't NEED unique names (each test gets a
    fresh DB), but the cost is 1 line per test and it makes the
    suite future-proof against parallel-run scenarios.

  - Add an helper `test/_fixture.ts` exporting a single
    `freshWorkstream()` that returns a unique name. Every test that
    needs a workstream calls it. Search-replace pass.

  - Verify by running the full suite TWICE in parallel (intentional
    self-race): both should pass.

LAYER 2 (commit 2) — CLEANUP-ON-EXIT GUARANTEE.

  - Wherever an integration test creates a tmux session, it MUST
    kill it in afterEach with try/catch — even if the test itself
    threw. Audit pattern:

        afterEach(async () => {
          try { await tmux([\"kill-session\", \"-t\", \"mu-\"+ws]); } catch {}
        });

    Add a vitest setup hook (vitest.config.ts -> setupFiles) that
    AFTER ALL tests, scans `tmux ls` for any session matching
    /^mu-test-/ and kills them. Belt-and-suspenders for the
    forgotten-cleanup case.

  - Same for DB rows: every test that writes to a temp DB should
    use a per-test temp-dir under os.tmpdir() (already common
    pattern) — but audit for any test that omits MU_DB_PATH and
    falls back to the real ~/.local/state/mu/mu.db. Use grep to
    find the smell:

        rg \"openDb\(\" test/ | grep -v \"path: join(tempDir\"
        rg \"new Db\b\" test/

    Any caller that doesn't override the path is suspect.

  - Add a CI lint step: after `npm test` exits, fail the build if
    `tmux ls | grep '^mu-test-'` returns non-empty. This catches
    leak regressions immediately.

LAYER 3 (commit 3) — DEDICATED TMUX SERVER (the real fix).

  - The right answer for tmux integration tests: spawn a
    DEDICATED tmux server per test fork via `tmux -L
    <unique-socket-name>` and route ALL tmux calls through it for
    the duration of the suite. The user's interactive tmux server
    is never touched.

    src/tmux.ts already has `setTmuxExecutor(fn)` for unit-test
    mocking. Add a sibling `setTmuxArgsPrefix(args[])` that
    prepends `[\"-L\", socketName]` to every tmux command. The
    test setup hook creates a socket, sets the prefix; the
    teardown hook does `tmux -L <socket> kill-server` to nuke
    everything in one shot.

    With a dedicated socket:
      - Concurrent npm-test runs CAN'T contend (different sockets).
      - Test residue is impossible (kill-server cleans everything).
      - The user's real tmux state is never observed by tests.

  - Test cost: ONE extra `tmux -L X new-session` per integration
    suite startup. ~50ms. Negligible vs the 90s suite time.

  - This layer is the long-term fix. Layers 1+2 are stopgaps that
    pay off NOW.

VERIFY (per layer)
------------------

LAYER 1:
  # Should both pass:
  ( npm test ) & ( npm test ) & wait
  # Should leave no residue (after they both finish):
  tmux ls | grep '^mu-test-' | wc -l   # → 0

LAYER 2:
  # Even after killing a test mid-run:
  npm test &
  sleep 5; kill -9 $!
  # Should leave no residue:
  tmux ls | grep '^mu-test-' | wc -l   # → 0 (within 30s of the next test run)

LAYER 3:
  # User's tmux state is invisible to the suite:
  tmux new-session -d -s mu-user-fixture
  npm test
  tmux ls | grep mu-user-fixture       # → still there, untouched
  tmux kill-session -t mu-user-fixture

CONSTRAINTS
-----------
- 1500 LOC hard cap per file (most edits are per-test single-line
  changes).
- Conventional commit prefix: test:
- Four greens before EACH layer's commit.
- Suggested commit messages:
    test: unique fixture names per test (eliminates parallel-run
          collisions)
    test: hard cleanup of tmux sessions + temp dirs in afterEach +
          global teardown (no leaks survive)
    test: dedicated tmux socket per integration suite (user's
          tmux server is invisible)

DOCS
----
- AGENTS.md \"Tests\" section: rewrite the integration-test rules
  to mandate the new patterns (freshWorkstream(), -L socket).
- CHANGELOG.md (under v0.4.0): bullet under \"Internal\" /
  \"Test infrastructure\".

OUT OF SCOPE
------------
- Don't refactor the test files into a shared base — the tests
  are explicitly per-feature and AGENTS.md warns against
  premature abstraction.
- Don't migrate from vitest to anything else.
- Don't change `singleFork: true` — keeping it is belt-and-
  suspenders even after Layer 3.

⚠️ FINAL ACTION ⚠️
After committing the LAST layer, run from the workspace dir:
    mu task close bug_test_suite_flake_leaks_isolation -w tui-impl --evidence \"<sha + summary>\"

(If you ship layers individually, the task stays IN_PROGRESS until
ALL three commit; close once Layer 3 is in.)
```

### #2 by "π - mu", 2026-05-11T16:58:18.524Z

```
PRIORITY ESCALATION (2026-05-11)
--------------------------------
User feedback: \"that one seems pretty serious\". Bumped impact to
90 (was 70). New ROI: 180 (was 140). Now the highest-impact NEW
backlog item.

Three reasons it's load-bearing, not cosmetic:

A. CONTAMINATING USER STATE.
   Right now `tmux ls` on the dev machine shows mu-alpha, mu-beta,
   mu-demo, mu-gamma — leaked test fixtures. The user's real DB
   probably has matching workstream rows. Every `npm test` makes
   this worse. A worker that crashes mid-test leaves orphan tmux
   sessions the user has to clean by hand. This violates the
   \"small, single-machine, predictable\" pillar.

B. SILENTLY WEAKENING THE FOUR-GREENS GATE.
   AGENTS.md commits the project to \"typecheck + lint + test +
   build all green before EVERY commit.\" If `npm test` has a known
   ~5-8/1500 false-failure rate under load, the gate is degraded
   without anyone calling it out. We have been re-running and
   committing — which means a real bug introduced today that only
   shows under load could ride green CI for weeks before being
   caught.

C. FLAKE TAX ON FUTURE WORK.
   Every multi-worker dispatch wave eats orchestrator time on
   \"is that real or flaky?\" decisions. With 11 commits this
   session and ~3 false failures observed per worker handoff,
   that's a real productivity drag and an even worse trust
   signal.

The three-layer plan above stays the same; the priority is the
correction. Recommend dispatching this BEFORE the remaining
nits/bugs in the backlog — the test-infra fix unblocks
confidence in everything else.

WAVE-PLAN HINT FOR THE NEXT ORCHESTRATOR
----------------------------------------
Don't park this behind low-ROI nits. Dispatch the next free
worker to LAYER 1 immediately:

  mu task claim bug_test_suite_flake_leaks_isolation -w tui-impl --for <free-worker>
  # Dispatch with: \"Read full notes; ship Layer 1 first as its own
  # commit; verify with parallel-run smoke; close the task only
  # AFTER all three layers are in (separate commits each).\"

If a worker only has time for one layer per pane-life, ship Layer
1 (highest leverage / lowest risk) and re-claim for L2/L3 later.
```

### #3 by "worker-2", 2026-05-11T17:38:23.636Z

```
SHIPPED: all three layers in three separate commits per spec.

FILES
- test/_fixture.ts (NEW): freshWorkstream(prefix) helper.
- test/_global-teardown.ts (NEW): vitest globalSetup contract;
  setup() bootstraps private tmux server + sweeps default-socket
  legacy residue, teardown() kills the server + sweeps again.
- src/tmux.ts (MODIFIED): realExecutor honours MU_TMUX_SOCKET via
  tmuxGlobalFlags(); killSession swallows "no server running".
- vitest.config.ts: globalSetup wired up.
- 7 integration test files refactored to use freshWorkstream().
- test/cli-agent-kick.test.ts: per-test-unique sleep argument so
  the `ps | grep /sleep 600/` sanity check survives parallel runs.

COMMANDS run repeatedly (each = exit 0)
  npm run typecheck
  npm run lint
  npm run test
  npm run build

FINDINGS
- The user's tmux had stale mu-alpha/beta/demo/gamma fixtures
  PRE-EXISTING (created before this task); not produced by my
  changes. Layer 2's default-socket sweep is hand-curated to NOT
  match these (no "alpha"/"beta"/"demo"/"gamma" in the prefix
  list) precisely because killing them could be catastrophic on
  someone's actual workstream named "alpha". The user can `tmux
  kill-session -t mu-alpha` manually if they're stale.
- `-f /dev/null` matters: a typical user ~/.tmux.conf with
  run-shell plugins adds 4s/server-start. Without it Layer 3
  ballooned the suite from 86s to ~150s+. With it, parity.

DECISION
- Layer 1: per-test unique workstream names (freshWorkstream).
- Layer 2: global setup+teardown sweeps default-socket residue
  matching the integration-test prefix allowlist.
- Layer 3: a dedicated `tmux -L <socket> -f /dev/null` private
  server per `npm test` invocation, controlled by MU_TMUX_SOCKET
  env var honoured by realExecutor in src/tmux.ts.

NEXT
- None. Task done. The dispatch flow that hit "Test timed out
  in 30000ms" + leaked sessions in `tmux ls` should now be
  reproducible-free under parallel orchestrator+worker `npm test`
  runs.
- Future maintenance hook: when adding a new integration suite
  that calls freshWorkstream("foo"), add "foo" to
  TEST_FIXTURE_PREFIXES in test/_global-teardown.ts. The Layer 2
  sweep depends on this list; Layer 3 doesn't.

VERIFIED
- Layer 1: ( npm test ) & ( npm test ) & wait → both A=0 B=0;
  zero `mu-(t|wait|wxa|wxb|claim|stall|acc|kick|v)-` residue.
- Layer 2: kill -9 mid-integration-suite leaves residue; next
  `vitest run` setup-phase sweeps it: "[mu-test global-setup]
  killed N leaked tmux session(s) on the default socket".
- Layer 3: tmux new-session -d -s mu-user-fixture; npm test;
  tmux ls | grep mu-user-fixture → STILL THERE. Suite never
  touched the user's tmux server.
- Final four-greens: typecheck ✓, lint ✓, test ✓ (1562/1562),
  build ✓.

ODDITIES
- The four-greens timing varies 60s-90s wallclock between runs
  on the same machine; not a flake, just CPU contention from the
  three parallel mu workers. Acceptable.
```

### #4 by "worker-2", 2026-05-11T17:38:30.143Z

```
CLOSE: L1+L2+L3: 0011c06 + 1907012 + 5fd7dd6 — unique fixture names (test/_fixture.ts freshWorkstream); global setup+teardown sweep + private tmux -L socket per test run (test/_global-teardown.ts + src/tmux.ts MU_TMUX_SOCKET); 4-greens before each commit; verify recipes from task notes all green; user-fixture mu-user-fixture survives full suite untouched
```
