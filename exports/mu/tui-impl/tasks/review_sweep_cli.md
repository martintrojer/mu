---
id: "review_sweep_cli"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.4
roi: 125.00
owner: "worker-3"
created_at: "2026-05-13T12:30:31.448Z"
updated_at: "2026-05-13T12:40:12.180Z"
blocked_by: []
blocks: []
---

# REVIEW SWEEP shard 3: CLI verbs (cli root + cli/* + cli/tasks/*)

## Notes (3)

### #1 by "π - mu", 2026-05-13T12:33:18.149Z

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
YOUR SHARD: CLI VERBS  (worker-3, umbrella review_sweep_cli)
═══════════════════════════════════════════════════════════════════════

The thin wrappers around the SDK that present every verb to the
human and to scripts. Excludes the TUI cluster (shard 4).

FILES IN YOUR SHARD (~6200 LOC source + matching tests)

Source (read all of these):
  src/cli.ts                        814
  src/cli/agents.ts                 825
  src/cli/archive.ts                652
  src/cli/doctor.ts                 332
  src/cli/format.ts                 450
  src/cli/handle.ts                 442
  src/cli/log.ts                    242
  src/cli/snapshot.ts               688
  src/cli/sql.ts                    306
  src/cli/staleness.ts               52
  src/cli/state.ts                  352
  src/cli/tasks.ts                   32
  src/cli/tui-launch-focus.ts       104
  src/cli/workspace.ts              499
  src/cli/workstream.ts             774
  src/cli/tasks/claim.ts            563
  src/cli/tasks/edges.ts            181
  src/cli/tasks/edit.ts             450
  src/cli/tasks/lifecycle.ts        309
  src/cli/tasks/queries.ts          166
  src/cli/tasks/tree.ts              88
  src/cli/tasks/wire.ts             500

Tests (read & apply test-reviewer):
  Every test/cli-*.ts file EXCEPT TUI tests (those are shard 4's).
  Specifically:
    test/cli-*  (all of them)
    test/doctor-summary.integration.test.ts
    test/sql-multi-statement.integration.test.ts
    test/error-nextsteps.test.ts
    test/json-output.integration.test.ts
    test/next-steps.test.ts                 (if present)
    test/unescape-note-text.test.ts
    test/cli-snapshot.integration.test.ts
    test/cli-bare-launches-tui.integration.test.ts (TUI dispatch
      is the entrypoint — code review here, but the TUI render
      side is shard 4)
    test/agent-spawn-name-hint.integration.test.ts (if it's CLI-
      flavoured rather than substrate; use judgement)

SHARD-SPECIFIC HOTSPOTS TO PAY ATTENTION TO

- src/cli/agents.ts (825), src/cli/workstream.ts (774), src/cli/
  snapshot.ts (688), src/cli/archive.ts (652) — all over the
  AGENTS.md 800-LOC refactor signal or close to it. The recent
  refactor pass split src/agents.ts / src/vcs.ts / etc., but the
  CLI mirrors of these were NOT touched. Look for: handler bodies
  with too much logic that should be in the SDK; near-duplicate
  flag-parsing scaffolds across verbs.
- src/cli/tasks/wire.ts (500) and src/cli/tasks/claim.ts (563)
  are large handler files in an already-clustered subdir. Look
  for: opportunities to factor shared helpers; `optsWithGlobals()`
  call patterns that could be a tiny utility.
- src/cli/format.ts (450) is the rendering centre. Look for:
  duplicated truncation/colour logic, table-config patterns that
  could be a single helper.
- src/cli/handle.ts (442) — typed-error → exit-code mapping. Look
  for: error classes the SDK throws but handle() doesn't map (->
  silent generic exit 1); check coverage against src/agents/errors.ts
  + src/tasks/errors.ts.

CROSS-SHARD COORDINATION

- The bare `mu` TUI dispatch in src/cli.ts → src/cli/tui/ — review
  the dispatch decision in cli.ts here, but TUI internals are shard 4.
- mu state has both static and --tui modes; static rendering is
  yours (src/cli/state.ts), TUI is shard 4.

UMBRELLA TASK: review_sweep_cli
```

### #2 by "worker-3", 2026-05-13T12:40:11.885Z

```
SUMMARY — review_sweep_cli

File count reviewed:
  Source: 22 shard files under src/cli.ts, src/cli/*, src/cli/tasks/* (TUI internals excluded).
  Tests: 37 CLI-flavoured shard files (test/cli-* plus listed doctor/sql/error/json/unescape/spawn-name files; TUI-render tests excluded).
  Total: 59 files.

LOC reviewed (approx):
  Source: 8,821 LOC by wc -l.
  Tests: 8,145 LOC by wc -l.
  Total: ~16,966 LOC.

Findings filed:
  High: 1
    - review_cli_destroy_archive_nextstep
  Med: 4
    - review_cli_state_tui_preloads
    - review_cli_sql_reader_detection
    - testreview_cli_nextsteps_incomplete
    - testreview_cli_classify_map_incomplete
  Low: 1
    - review_cli_empty_blocked_by_line
  Total: 6 findings.

Topics most often flagged:
  - CLI Next-step / self-documenting output correctness (destroy dry-run losing --archive; task-add empty optional line).
  - CLI wrapper doing avoidable work before dispatch (`state --tui` preloading static snapshots).
  - Escape-hatch correctness (`mu sql` single-statement read/write detection by prefix instead of prepared-statement metadata).
  - Test inventory drift around typed-error user contracts (errorNextSteps and classifyError tests don't cover many currently shipped classes/branches).

Looked at and consciously did NOT file:
  - Large CLI namespace files (`src/cli/agents.ts`, `src/cli/workstream.ts`, `src/cli/archive.ts`, `src/cli/snapshot.ts`) are near/over the 800 LOC refactor signal, but the repo already documents one-file-per-verb-namespace CLI wrappers and several files contain recent extracted helpers. I did not file a generic "split more" task without a concrete behavior/maintenance win.
  - `optsWithGlobals()` vs `opts()` usage is uneven but mostly tied to the documented Commander positional-options gotcha and top-level/bare-mu surfaces; I only filed the concrete lost-flag Next-step issue.
  - Static/behavioral TUI render tests and TUI internals were intentionally skipped as shard 4, except for CLI dispatch entrypoint files/tests named in this shard.
  - Existing comments referencing older audit task names / historical reasons are noisy in places, but most explain load-bearing dogfood regressions and did not meet filing threshold as dead code.
  - `NoForegroundProcessError` currently falls through to generic exit 1, but its own source comment says that is intentional runtime-state behavior, so I did not file it as an unmapped error.

Self-check:
  Re-scanned the shard after filing; the six tasks above are the issues I would be embarrassed not to mention. No source/test/doc files were modified in this read-only audit.
```

### #3 by "worker-3", 2026-05-13T12:40:12.180Z

```
CLOSE: swept 59 files / ~17k LOC; filed 6 findings (1 high / 4 med / 1 low)
```
