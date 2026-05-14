---
id: "bug_test_flake_round_2"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.3
roi: 266.67
owner: null
created_at: "2026-05-11T17:41:45.247Z"
updated_at: "2026-05-11T17:56:23.054Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: post-L1+L2+L3 follow-up — MU_PI_COMMAND env leaks into spawn-validation tests + 'demo'/'feedback' rows still in live DB

## Notes (3)

### #1 by "π - mu", 2026-05-11T17:42:56.345Z

```
SYMPTOM (post-Layer-1+2+3 verification, 2026-05-11)
---------------------------------------------------
After bug_test_suite_flake_leaks_isolation closed (3 commits:
0011c06 + 1907012 + 195eac2), the orchestrator ran `npm test` and
got 7 failures across 2 files DETERMINISTICALLY (not a load flake
this time):

  FAIL test/cli-agent-spawn-validation.test.ts (5 failed):
    > Part A > succeeds when the resolver reports the binary IS on
              PATH (--cli pi happy path)
    > Part B > detects shell error: zsh: command not found: pi-meta
    > Part B > detects shell error: bash: pi-meta: command not found
    > Part B > detects shell error: sh: pi-meta: No such file or directory
    > Part B > clean scrollback (no shell-error markers) does NOT
              trip the scanner

  All 5 fail with:
    AgentSpawnCliNotFoundError: --cli pi resolved to binary
    \"pi-meta\" which is not on PATH

ROOT CAUSE (1) — MU_PI_COMMAND ENV LEAK
---------------------------------------
The orchestrator's shell sets MU_PI_COMMAND=pi-meta (Meta-internal
pi wrapper). vitest inherits the parent env. When a test runs
`spawnAgent({ cli: \"pi\" })`, the SDK reads MU_PI_COMMAND, resolves
to `pi-meta`, then the pre-flight PATH check looks for `pi-meta` —
which is NOT on PATH outside Meta's wrapper environment, so it
throws AgentSpawnCliNotFoundError.

These tests assume `pi` is the resolved binary — they DON'T wrap
their assertions in withEnv(\"MU_PI_COMMAND\", undefined, ...).
The pattern IS in the file (line 409: `withEnv(\"MU_PI_COMMAND\",
undefined, ...)`), just not applied to lines 249 and 352.

FIX — line-precise:

  test/cli-agent-spawn-validation.test.ts

  (a) Wrap the failing test bodies in withEnv to clear/normalize
      MU_PI_COMMAND. The pattern already exists in this file at
      line 409:
          await withEnv(\"MU_PI_COMMAND\", undefined, async () => { ... });
      Apply it to ALL 5 failing tests.

  (b) Better: add a top-level beforeEach in the file (or the suite
      that owns these tests) that ALWAYS clears MU_PI_COMMAND before
      each test, then restores after. Scope is narrow (this file's
      assertions reason about CLI resolution, so the env MUST be a
      known constant). Pattern:

          beforeEach(() => {
            const k = \"MU_PI_COMMAND\";
            originalMuPi = process.env[k];
            delete process.env[k];
          });
          afterEach(() => {
            const k = \"MU_PI_COMMAND\";
            if (originalMuPi !== undefined) process.env[k] = originalMuPi;
            else delete process.env[k];
          });

      (Use the computed-key form per AGENTS.md; biome's --write
      --unsafe rewrites `delete process.env.X` badly.)

  (c) Audit the rest of test/ for the same smell: any test
      asserting a SPECIFIC --cli resolution should clear
      MU_PI_COMMAND first. Suggested grep:

          rg \"spawnAgent\b|--cli pi\b\" test/ | grep -v withEnv

GENERALIZE — global env scrub in vitest setup
---------------------------------------------
The orchestrator's env exposes MORE than MU_PI_COMMAND. Any
process.env.MU_* read by the SDK can flake tests when the dev
machine sets it. Add a `setupFiles` hook in vitest.config.ts that
clears EVERY MU_* env at startup:

    // test/_setup.ts (NEW)
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(\"MU_\")) {
        delete process.env[key];
      }
    }

…then in vitest.config.ts:

    setupFiles: [\"./test/_setup.ts\", ...existingSetup],

This is belt-and-suspenders: even if a test writer forgets to
withEnv, they're working from a known-clean env baseline. The
narrowly-scoped withEnv() calls then opt-IN to specific values.

ROOT CAUSE (2) — DB ROW LEAKS DESPITE LAYERED FIX
-------------------------------------------------
`sqlite3 ~/.local/state/mu/mu.db \"SELECT name FROM workstreams\"`
shows `demo` in the user's REAL DB. (User confirms `feedback` is
real — leave it; only `demo` is suspect residue.)

`demo` matches the literal at test/tui-acceptance.test.ts:36:
    await runCli([\"workstream\", \"init\", \"demo\"], dbPath);

That CALL passes a `dbPath` arg, AND test/_runCli.ts (line 60-78)
DOES set MU_DB_PATH for the duration. So the test path itself is
correct. The leak must come from one of:

  (a) An earlier (pre-Layer-1) test run that DID write to the user
      DB. Layer 1 fixed the future, not the past. → manual
      cleanup needed: `mu workstream destroy demo --yes` (or
      `mu sql \"DELETE FROM workstreams WHERE name='demo'\"`).

  (b) A test calling the SDK directly (not via runCli) that opens
      a DB without overriding the path. Audit:
          rg \"openDb\(\{\s*path:\" test/ | grep -v tempDir | grep -v dbPath
          rg \"new\s+Db\(\" test/

  (c) A test importing a CLI verb function directly (not via
      runCli) and not setting MU_DB_PATH first.

LAYER 4 — DB-SAFETY HARD GUARD (the real fix)
---------------------------------------------
src/db.ts openDb() should refuse to open the user's REAL DB during
tests. Add at the top of the function:

    const isTest = process.env.VITEST !== undefined
                || process.env.NODE_ENV === \"test\";
    if (isTest) {
      const home = process.env.HOME ?? \"\";
      const xdg = process.env.XDG_STATE_HOME ?? `${home}/.local/state`;
      const realDb = `${xdg}/mu/mu.db`;
      if (resolvedPath === realDb) {
        throw new Error(
          `openDb refused: tests must NEVER write to the user DB ` +
          `(${realDb}). Pass MU_DB_PATH or an explicit { path } ` +
          `argument pointing at a temp dir.`,
        );
      }
    }

…and runCli already sets MU_DB_PATH so it's safe; any test that
trips this guard is the leak source. Run the suite once with this
guard; the failing test points at the leak path.

VERIFY
------
1. After fixing the MU_PI_COMMAND leak (+ optional global scrub):
     npm test                        # → 0 failures, 1632 pass
     MU_PI_COMMAND=pi-meta npm test  # → still 0 failures (env scrubbed)
     MU_PI_COMMAND=pi npm test       # → still 0 failures

2. After the DB hard guard:
     npm test                                    # → 0 failures
     # Manually clean up live DB:
     mu workstream destroy demo --yes -w demo
     # Re-run; verify nothing recreates 'demo':
     npm test
     mu workstream list | grep demo              # → empty

CONSTRAINTS
-----------
- 1500 LOC hard cap per file.
- Conventional commit prefix: test:
- Four greens before commit.
- Ship as 2 commits:
    Commit 1: test: scrub MU_* env at suite start + per-test
              withEnv on the 5 spawn-validation cases
    Commit 2: db: refuse to open the user DB during tests
              (hard guard) + clean up the inherited 'demo' row
              (one-shot manual ws-destroy in the commit body)

DOCS
----
- AGENTS.md \"Tests\" section: document the env-scrub policy and
  the openDb test guard.
- CHANGELOG.md (under v0.4.0): bullet under \"Test infrastructure\".

OUT OF SCOPE
------------
- Don't touch the 'feedback' workstream — user-confirmed real.
- Don't widen the openDb guard to non-test contexts (would break
  `mu` itself).
- Don't remove withEnv() — it's still the right tool for tests
  that explicitly NEED a specific env value.

⚠️ FINAL ACTION ⚠️
After committing both layers, run from the workspace dir:
    mu task close bug_test_flake_round_2 -w tui-impl --evidence \"<sha1> + <sha2>\"
```

### #2 by "worker-2", 2026-05-11T17:56:16.606Z

```
SHIPPED — 2 commits as specified.

FILES:
  Commit 1 (test: scrub MU_* env): cd31175
    - test/_setup.ts (NEW, vitest setupFiles hook)
    - vitest.config.ts (+8 lines, plumb setupFiles)
    - test/cli-agent-spawn-validation.test.ts (per-test MU_PI_COMMAND snapshot/restore)
    - AGENTS.md "Tests" (env-baseline policy bullet)
    - CHANGELOG.md 0.4.0 "Fixed" (test infrastructure bullet)

  Commit 2 (db: hard guard): f510b5a
    - src/db.ts (refuseUserDbDuringTests helper + openDb call site)
    - test/db-test-guard.test.ts (NEW, 3 cases)
    - AGENTS.md "Tests" (DB-baseline bullet)
    - CHANGELOG.md 0.4.0 "Fixed" (DB-guard bullet)

COMMANDS:
  npm run typecheck                       exit 0
  npm run lint                             exit 0 (183 files, no warnings)
  npm run test                             exit 0 (102 files / 1565 tests, ~60-70s)
  MU_PI_COMMAND=pi-meta npm run test       exit 0 (same — env scrub works under contamination)
  npm run build                            exit 0
  mu workstream destroy -w demo --yes      exit 0 ('demo' row removed, pre-destroy export taken)
  mu workstream list | grep demo           empty
  mu workstream list | grep feedback       present (untouched, user-confirmed real)

FINDINGS:
  - The 5 cli-agent-spawn-validation deterministic failures were caused by MU_PI_COMMAND=pi-meta
    inherited from the orchestrator shell into vitest forks. Tests assumed `--cli pi` resolves
    to bare `pi`; the SDK resolver picked up the env override and re-bound to `pi-meta`.
  - The 'demo' workstream was a residue from an earlier test run that wrote to the user DB
    BEFORE Layer 1 (unique fixture names) landed. Manual destroy clears it; the new openDb
    hard guard prevents recurrence — any test that tries to open the real DB now fails loudly
    at the offending stack frame.

DECISION:
  - Shipped both layers as instructed (test:, then db:). Two commits, two distinct concerns.
  - Used env-allowlist ([MU_TMUX_SOCKET]) in test/_setup.ts to preserve Layer-3's private
    tmux socket — wiping it would re-introduce the residue that L3 fixed.
  - openDb guard computes the "real" path from HOME / XDG_STATE_HOME DIRECTLY (not via
    defaultDbPath()) — otherwise MU_DB_PATH=<temp> would defeat the check by making
    defaultDbPath() return the temp value.
  - Added belt-and-suspenders MU_PI_COMMAND snapshot/restore in
    cli-agent-spawn-validation.test.ts even though _setup.ts handles it globally; defends
    against a sibling test in the same fork accidentally setting it later.

NEXT:
  None. Both root causes addressed. tui_impl_complete (the umbrella) is unblocked from
  the DB/test-flake side.

VERIFIED:
  - All 4 greens (typecheck/lint/test/build) before EACH commit.
  - Verified `MU_PI_COMMAND=pi-meta npm test` passes — 0 failures (was 7 before).
  - Verified `mu workstream list` shows no 'demo' and 'feedback' is intact.
  - test/db-test-guard.test.ts (3 cases) directly exercises the openDb refusal path.

ODDITIES:
  - Biome's lint/style/useTemplate forced collapsing the multi-line error message in
    src/db.ts into one long template literal (it doesn't accept template+concat mixed). The
    line is wide but correct.
  - feat_track_drill_chains branch name is leftover from prior work; commits land clean.
```

### #3 by "worker-2", 2026-05-11T17:56:23.054Z

```
CLOSE: cd31175 + f510b5a
```
