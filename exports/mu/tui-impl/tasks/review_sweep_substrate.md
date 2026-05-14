---
id: "review_sweep_substrate"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.4
roi: 125.00
owner: "worker-1"
created_at: "2026-05-13T12:30:30.944Z"
updated_at: "2026-05-13T12:49:40.963Z"
blocked_by: []
blocks: []
---

# REVIEW SWEEP shard 1: substrate (db, tmux, agents, reconcile, state, logs, dag, tracks)

## Notes (3)

### #1 by "π - mu", 2026-05-13T12:33:17.537Z

```
TASK: REVIEW SWEEP — apply both code-reviewer + test-reviewer skills
to your assigned shard. File EVERY finding as its own task in this
workstream (tui-impl). Do NOT fix anything — this is read-only audit.
The orchestrator will triage your filed findings into ship/skip/etc.

VERBATIM USER MOTIVATION
> "i want to run codebase with sweeps using the code review and test
>  review skills. ... make them file tasks as per usual and you can
>  triage as they come in."

═══════════════════════════════════════════════════════════════════════
PROTOCOL — read this end-to-end before starting
═══════════════════════════════════════════════════════════════════════

1. READ THE TWO REVIEW SKILLS FIRST.

   - /Users/mtrojer/.agents/skills/code-reviewer/SKILL.md
   - /Users/mtrojer/.agents/skills/test-reviewer/SKILL.md

   They are short. Internalise their categories and output format.

2. STAY IN YOUR SHARD.

   Each worker has a disjoint slice of the codebase listed below
   under FILES IN YOUR SHARD. Other workers are reviewing the
   adjacent slices. Do NOT review or file findings against files
   outside your shard — duplicates waste orchestrator time.

   You ARE allowed to read cross-shard files when chasing a callsite
   (e.g. you're auditing src/agents/ and want to understand how
   src/cli/agents.ts uses it). Just don't FILE findings on those
   external files; that's another worker's shard.

3. APPLY BOTH SKILLS.

   Each file in your shard gets a TWO-PASS review:
   - Pass A (code-reviewer): dead code, duplication, complexity,
     idiomatic patterns. Includes test files.
   - Pass B (test-reviewer): only on test files in your shard.
     Excessive mocking, fake/tautological assertions, weak
     assertions, brittle implementation-coupling, missing
     edge-case coverage.

   Don't conflate them. A finding on src/foo.ts uses the code
   reviewer's framing; a finding on test/foo.test.ts may use
   either depending on what the issue is.

4. ONE FINDING = ONE TASK.

   For every issue you find that meets the FILING THRESHOLD (below),
   file a NEW task in this workstream:

       mu task add review_<shard>_<short_slug> -w tui-impl \
         --title "REVIEW <severity>: <one-line>" \
         --impact <0-100> --effort-days <0.05-1.0>

       mu task note review_<shard>_<short_slug> -w tui-impl \
         "$(cat /tmp/review_<shard>_<short_slug>.txt)"

   Where:
   - <shard> is one of: substrate / data / cli / tui (yours)
   - <short_slug> is snake_case, ≤ 5 words, descriptive
   - <severity> is high / med / low (your judgement)
   - --impact is your estimate of value-of-fix (0-100)
   - --effort-days is your estimate of fix size

   For test-reviewer findings, prefix with `testreview_<shard>_...`
   instead of `review_<shard>_...` — it makes the orchestrator's
   triage cleaner.

5. THE NOTE BODY IS YOUR HANDOFF.

   The note must contain enough for a worker (later) to fix the
   issue without re-reading the file. Use this template:

       FILE(S):
         path/to/file.ts:LINE-RANGE
         (additional files if cross-cutting)

       FINDING (one of: dead code | duplication | complexity |
                       non-idiomatic | weak assertion | excessive
                       mocking | fake testing | missing coverage |
                       implementation coupling | test smell):
         <quote the offending code, ≤ 20 lines>

       WHY IT'S A PROBLEM:
         <2-4 sentences. What bug could slip through? What
         maintenance pain? What principle is violated?>

       PROPOSED FIX:
         <concrete patch sketch. Pseudocode is fine. Note any
         interactions with other files.>

       EFFORT NOTE:
         <any unusual setup needed; tests that need to be
         updated; risk of regression.>

6. FILING THRESHOLD.

   File a task when:
   - A reasonable reviewer would say "yeah, this is worth changing."
   - You can name the principle being violated.
   - The fix would clearly improve the file (not just shuffle bytes).

   DO NOT file a task for:
   - Personal-style nits ("I'd put the brace on the next line").
   - Things that are deliberately the way they are because of a
     comment or docs (read AGENTS.md / VOCABULARY.md / ARCHITECTURE.md
     before flagging architectural concerns).
   - Issues where the fix is bigger than the bug (see "Bounded scope"
     below).
   - Speculative "this might be slow" without measurement.
   - "I don't like commander" / "I'd switch to oclif" — anti-feature
     pledges in ROADMAP.md are firm.

7. RESPECT THE LOAD-BEARING DOCS.

   Read these BEFORE starting (not while filing tasks):
   - AGENTS.md (repo conventions, anti-patterns, what NOT to do)
   - docs/VISION.md (load-bearing pillars)
   - docs/ROADMAP.md (anti-feature pledges; explicitly rejected list)
   - docs/ARCHITECTURE.md (module layout & seams)
   - docs/VOCABULARY.md (canonical terms)

   Findings that contradict these docs are wrong findings. If you
   think a doc is the bug, file a finding against the doc — but
   90% of "this seems wrong" turns out to be a documented decision.

8. BOUNDED SCOPE.

   Promotion criteria in docs/ROADMAP.md cap fixes at <300 LOC.
   If your finding's fix would exceed that, either:
   - Find the smaller, separately-shippable subset and file THAT;
     or
   - File it anyway with effort-days ≥ 0.5 and a sub-task plan in
     the note. Orchestrator will decide whether to break it up.

9. TIER-RANK YOUR FINDINGS BY IMPACT.

   Use the same scale shipped tasks use:
   - 70-100: high. Likely to ship in this sweep.
   - 40-69: medium. Triage candidate.
   - 1-39: low. May or may not ship.
   Set effort-days honestly; padding hurts triage.

10. NO FIXES IN THIS PASS.

    Do NOT modify any source / test / doc file. Do NOT cherry-pick.
    Do NOT touch CHANGELOG.md. Your output is task rows in the DB.
    The orchestrator will fan the filed findings back out to fresh
    workers (possibly even YOU on the next wave) for the actual
    fixes.

═══════════════════════════════════════════════════════════════════════
WHEN YOU'RE DONE
═══════════════════════════════════════════════════════════════════════

A. Run a self-check: scan your shard once more after filing your
   findings. Anything you'd be embarrassed not to mention?

B. Drop a SUMMARY note on your umbrella task with:
   - File count reviewed.
   - LOC reviewed (approx).
   - Findings filed: high N / med N / low N.
   - Topics most often flagged in your shard.
   - Anything you LOOKED at and consciously decided NOT to file
     (e.g. "the X pattern in src/Y looks weird but it's documented
     in ARCHITECTURE.md as load-bearing").

C. ⚠️ FINAL ACTION ⚠️
   Close your umbrella task ONLY when steps A + B are done:

   mu task close <YOUR-UMBRELLA-NAME> -w tui-impl --evidence \
     "swept N files / ~M LOC; filed K findings (H high / M med / L low)"

   If you found genuinely nothing worth filing, close anyway with
   evidence "swept N files; nothing rises to filing threshold (justification: ...)".

═══════════════════════════════════════════════════════════════════════
PRACTICAL NOTES
═══════════════════════════════════════════════════════════════════════

- Use rg / wc / read freely. The shard is read-only for you.
- Don't cd into your workspace — orchestrator gave you a workspace
  but for this read-only sweep you can work from the project root.
  Use absolute paths under /Users/mtrojer/hacking/mu/ or relative
  to the project root.
- Shell quoting: single-quote your `mu task note` payloads, OR use
  the `"$(cat /tmp/...)"` form to avoid the shell mangling them.
- mu task list / mu task show on review_<shard>_* / testreview_<shard>_*
  to confirm your filings are in the DB before closing the umbrella.

═══════════════════════════════════════════════════════════════════════
PRECEDENT
═══════════════════════════════════════════════════════════════════════

This pattern has been run before; existing closed tasks named
review_repo_* and testreview_* in this workstream are what your
output will look like in shape. Read 2-3 of them for examples:

   mu task notes review_repo_unused_zod_dependency -w tui-impl
   mu task notes testreview_static_source_assertions -w tui-impl
   mu task notes review_repo_archive_events_not_incremental -w tui-impl

═══════════════════════════════════════════════════════════════════════
END OF SHARED PRELUDE — see your shard-specific section below.
═══════════════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════════════
YOUR SHARD: SUBSTRATE  (worker-1, umbrella review_sweep_substrate)
═══════════════════════════════════════════════════════════════════════

The substrate is mu's lowest-level state + IO + reconciliation layer.
Other workers depend on it. Findings here have outsized impact.

FILES IN YOUR SHARD (~5400 LOC source + matching tests)

Source (read all of these):
  src/db.ts                         723
  src/tmux.ts                       855
  src/detect.ts                     120
  src/reconcile.ts                  201
  src/agents.ts                     800
  src/agents/adopt.ts               187
  src/agents/errors.ts              341
  src/agents/kick.ts                343
  src/agents/spawn.ts               675
  src/staleness.ts                   11
  src/project-root.ts                76
  src/dag.ts                        203
  src/state.ts                      317
  src/output.ts                     286
  src/index.ts                      386   (re-export hub)
  src/logs.ts                       419
  src/tracks.ts                     167
  src/doctor-summary.ts             242

Tests (read & apply test-reviewer):
  test/agents.integration.test.ts
  test/agent-idle.test.ts
  test/agent-spawn-name-hint.integration.test.ts
  test/dag.integration.test.ts
  test/db.test.ts
  test/db-test-guard.test.ts
  test/detect.test.ts
  test/logs.integration.test.ts
  test/output.test.ts
  test/output-labels-human-rename.test.ts
  test/reaper.integration.test.ts            (if present; also reaper-events-* / kick-* tests)
  test/reaper-events-default-state.test.ts   (if present)
  test/reconcile.integration.test.ts
  test/staleness.test.ts
  test/state-dispatch.integration.test.ts
  test/state-helpers.integration.test.ts
  test/state-render.integration.test.ts
  test/tmux.integration.test.ts
  test/tmux.test.ts
  test/tracks.test.ts
  test/global-teardown-allowlist.test.ts

Use `ls test/ | rg -i 'agent|db|tmux|detect|reconcile|state|dag|tracks|logs|output|staleness|reaper'`
to confirm the live set on disk.

SHARD-SPECIFIC HOTSPOTS TO PAY ATTENTION TO

- src/tmux.ts is one of the largest files. Send protocol, pane
  validation, the bracketed-paste contract, the executor injection
  for tests. Look for: hard-to-test nested closures, complex regex
  parsers without a lookup table, race conditions in liveness checks.
- src/agents/spawn.ts (675) is the longest agent-cluster file.
  Look for: prestage / rollback paths, error mapping correctness,
  cross-cluster imports.
- src/agents/errors.ts (341) and src/agents/kick.ts (343) — both
  near or over the AGENTS.md 200-LOC-typical threshold.
- src/db.ts (723) — single CREATE-IF-NOT-EXISTS block + openDb. Look
  for: schema drift between code and what the schema_version
  expects, baseline-guard correctness in tests, journal_mode/foreign_keys
  pragmas.
- src/reconcile.ts is small but load-bearing ("reality wins").
  Look for: untested edge cases (e.g. orphan adoption races).

UMBRELLA TASK: review_sweep_substrate

When done with the protocol's steps A/B/C above, close that one.
```

### #2 by "worker-1", 2026-05-13T12:49:36.220Z

```
SWEEP SUMMARY — substrate shard

FILE COUNT REVIEWED:
  Source: 18 files (~5400 LOC):
    src/db.ts (723), tmux.ts (855), detect.ts (120),
    reconcile.ts (201), agents.ts (800), agents/adopt.ts (187),
    agents/errors.ts (341), agents/kick.ts (343),
    agents/spawn.ts (675), staleness.ts (11),
    project-root.ts (76), dag.ts (203), state.ts (317),
    output.ts (286), index.ts (386), logs.ts (419),
    tracks.ts (167), doctor-summary.ts (242)
  Tests: 19 files (~6200 LOC):
    agents.integration, agent-idle, agent-spawn-name-hint,
    dag.integration, db, db-test-guard, detect,
    logs.integration, output, output-labels-human-rename,
    reconcile.integration, staleness, state-dispatch.integration,
    state-helpers.integration, state-render.integration,
    tmux.integration, tmux, tracks, global-teardown-allowlist
  TOTAL: ~37 files / ~11.6 KLOC reviewed.

FINDINGS FILED: 11 (1 high / 4 med / 6 low)

  HIGH (1):
    review_substrate_delete_agent_not_transactional
      deleteAgent + reaper loop is not transactional; mid-loop
      failure leaves zombie IN_PROGRESS tasks with no breadcrumb.

  MEDIUM (4):
    review_substrate_startup_err_patterns_too_broad
      `command not found`/`No such file or directory` regexes
      can rollback a healthy spawn on benign banner output.
    review_substrate_resolve_id_anonymous_errors
      resolveTaskId/resolveAgentId throw fake-named Error,
      breaks the cli/handle.ts instanceof-based exit-code map.
    review_substrate_tsconfig_test_unused
      tsconfig.test.json is dead — `npm run typecheck` skips
      test/. Multiple test files are silently miscompiled
      (e.g. WorkstreamSnapshot literal with wrong shape; agent
      fixtures using non-existent statuses).
    testreview_substrate_workstream_snapshot_compile_check
      "Compile-time structural check" test for WorkstreamSnapshot
      uses the wrong report shape and falls through to a tautology.

  LOW (6):
    review_substrate_known_agent_clis_recomputed
      Per-pane recompute of orphan-agent recogniser; small perf +
      env snapshot consistency hazard in tests.
    review_substrate_raw_agent_row_id_unused
      RawAgentRow.id is selected per query but never read.
      Misleading comment claims "carried through for helpers".
    review_substrate_unused_workstream_state_dir
      Two SDK-public helpers (workstreamStateDir,
      ensureWorkstreamStateDir) have zero consumers — the comment
      itself reads "Unused today."
    review_substrate_last_claim_dup
      lastClaimActor + lastClaimEventAt duplicate the same SQL +
      LIKE-escape; extract one helper.
    review_substrate_force_color_zero
      MU_FORCE_COLOR=0 / FORCE_COLOR=0 turn colour ON (inverse
      of chalk semantics).
    testreview_substrate_insertedge_fake_fk_test
      db.test.ts insertEdge helper coerces an FK error with
      `to_task_id = -999999` to "match the v4 contract" — the
      "rejects edges to non-existent tasks (FK)" test passes for
      the wrong reason and tests behaviour mu doesn't ship.

TOPICS MOST OFTEN FLAGGED:
  - Type-safety gap: tests escape `tsc --noEmit`. This is the
    root cause of two findings (the unused tsconfig + the
    inline WorkstreamSnapshot fixture using wrong shape).
  - Incidental dead code from anticipatory abstractions
    (workstream state dir; RawAgentRow.id field).
  - Brittleness around env var truthiness (NO_COLOR vs
    MU_FORCE_COLOR semantics).
  - Three findings cluster around src/agents.ts: rollback
    transactionality, idle-attribution helper, and unused id field.

ITEMS LOOKED AT AND CONSCIOUSLY NOT FILED:
  - PENDING_PANE_PREFIX / placeholder pane id pattern: ugly but
    documented load-bearing in src/agents.ts and ARCHITECTURE.md
    (FK-ordering constraint). Already filed as a separate refactor.
  - SchemaTooOldError points operators to a deleted git-history
    script for migration: this is the documented "delete
    one-shot artifacts post-landing" rule. The errorNextSteps
    show how to recover. Comments are explicit; not a bug.
  - resolveCliCommand re-reads process.env on each call; mu
    skill states env vars are operator-tunable and the price
    is one process.env hash lookup per call. Not worth filing.
  - tmux.ts is 855 LOC but is the single chokepoint for every
    tmux call (mandated by AGENTS.md "all tmux invocations go
    through src/tmux.ts"). Splitting it would create wrappers
    around wrappers — anti-feature pledge.
  - agents.ts is 800 LOC, right at the soft refactor signal.
    The hard split (src/agents/*) has already happened.
  - state.ts wrapper does double staleness decoration work
    (fast then slow); functional but stylistically smell.
    Skipped — the data flow is documented in design_sdk_seam.
  - The five-step bracketed-paste send protocol in tmux.ts
    has a small race window (delay between paste-buffer and
    send-keys Enter); it's the documented MU_SEND_DELAY_MS
    knob.
```

### #3 by "worker-1", 2026-05-13T12:49:40.963Z

```
CLOSE: swept 37 files / ~11.6 KLOC; filed 11 findings (1 high / 4 med / 6 low). 9 code-reviewer + 2 test-reviewer.
```
