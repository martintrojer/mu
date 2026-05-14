---
id: "review_sweep_data"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.4
roi: 125.00
owner: "worker-2"
created_at: "2026-05-13T12:30:31.196Z"
updated_at: "2026-05-13T12:47:15.498Z"
blocked_by: []
blocks: []
---

# REVIEW SWEEP shard 2: data SDK (tasks, vcs, workspace, snapshots, archives, workstream, import/export)

## Notes (3)

### #1 by "π - mu", 2026-05-13T12:33:17.858Z

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
YOUR SHARD: DATA SDK  (worker-2, umbrella review_sweep_data)
═══════════════════════════════════════════════════════════════════════

Tasks, workspaces, VCS backends, snapshots, archives, workstreams,
and the import/export round-trip.

FILES IN YOUR SHARD (~6200 LOC source + matching tests)

Source (read all of these):
  src/tasks.ts                      135   (re-export hub)
  src/tasks/claim.ts                392
  src/tasks/core.ts                 149
  src/tasks/edges.ts                334
  src/tasks/edit.ts                 355
  src/tasks/errors.ts               420
  src/tasks/id.ts                   210
  src/tasks/lifecycle.ts            384
  src/tasks/queries.ts              336
  src/tasks/sort.ts                  58
  src/tasks/status.ts                45
  src/tasks/wait.ts                 378
  src/vcs.ts                         27   (re-export hub)
  src/vcs/git.ts                    380
  src/vcs/helpers.ts                133
  src/vcs/index.ts                   55
  src/vcs/jj.ts                     295
  src/vcs/none.ts                    73
  src/vcs/sl.ts                     248
  src/vcs/types.ts                  320
  src/workspace.ts                   53   (re-export hub)
  src/workspace/core.ts             200
  src/workspace/crud.ts             379
  src/workspace/decorate.ts         110
  src/workspace/orphans.ts          103
  src/workspace/recreate.ts         107
  src/snapshots.ts                   33   (re-export hub)
  src/snapshots/capture.ts          108
  src/snapshots/core.ts             179
  src/snapshots/prune.ts            199
  src/snapshots/restore.ts          100
  src/archives.ts                    39   (re-export hub)
  src/archives/addremove.ts         244
  src/archives/core.ts              274
  src/archives/delete.ts             20
  src/archives/query.ts             263
  src/workstream.ts                 613
  src/importing.ts                  803
  src/exporting.ts                  888

Tests (read & apply test-reviewer):
  test/archives.integration.test.ts
  test/archive-cli.integration.test.ts        (CLI side; CROSS-SHARD with shard 3 — do CODE side here, leave the cli-* heavy stuff to shard 3)
  test/exporting.integration.test.ts
  test/importing.integration.test.ts
  test/snapshots.integration.test.ts
  test/tasks-crud.integration.test.ts
  test/tasks-lifecycle.integration.test.ts
  test/tasks-meta.integration.test.ts
  test/tasks-reject-defer.test.ts
  test/tasks-sort.test.ts
  test/tasks-views.test.ts
  test/tasks-wait.integration.test.ts
  test/claim.integration.test.ts
  test/v5-name-clash.integration.test.ts
  test/vcs-commits-show.integration.test.ts
  test/vcs-detect.integration.test.ts
  test/workspace-backends.integration.test.ts
  test/workspace-commits.integration.test.ts
  test/workspace-refresh.integration.test.ts
  test/workspace-sdk.integration.test.ts
  test/workspace-staleness.integration.test.ts
  test/workspace-staleness-mem.integration.test.ts
  test/workstream.integration.test.ts
  test/workstream-destroy-empty.integration.test.ts

SHARD-SPECIFIC HOTSPOTS TO PAY ATTENTION TO

- src/exporting.ts (888) and src/importing.ts (803) are large and
  do round-trip serialization. Look for: drift between exporter and
  importer (a field one writes the other ignores), inadvertent loss
  of metadata, schema-version coupling.
- src/workstream.ts (613) handles ensure/list/summarize/destroy/
  export. Look for: whether destroy actually pre-snapshots and
  cascades cleanly; ghost-prune interaction with destroy.
- src/tasks/errors.ts (420) — large error-class file. Look for:
  classes never thrown, classes never caught, exit-code mapping
  drift with src/cli/handle.ts.
- src/tasks/wait.ts (378) — wait-for-tasks blocking logic; the
  --on-stall semantics + JSON nextSteps are user-visible. Look for
  test gaps around stuck/stall transitions.
- src/vcs/git.ts (380) is the largest VCS backend. Cross-cutting
  concern: every backend (git/jj/sl/none) should expose the same
  surface — look for inconsistencies between the four impls.
- Snapshots: src/snapshots/restore.ts is small but load-bearing
  (cross-version rejection, post-restore reconcile). Look for test
  gaps.

CROSS-SHARD COORDINATION

The CLI surface for these (mu task / mu workspace / mu archive /
mu snapshot / mu workstream) is shard 3's responsibility. If you
spot a CLI-side issue while reading SDK callers, leave it for shard
3; mention it in your summary note.

UMBRELLA TASK: review_sweep_data
```

### #2 by "worker-2", 2026-05-13T12:47:10.437Z

```
FILES: data SDK shard per assignment
COMMANDS: read review skills + repo docs; wc -l shard; targeted rg/read sweeps; filed findings via mu task add/note; verified filed notes with mu task notes.
FINDINGS: Swept 63 files / ~20,247 LOC (39 source files, 24 test files). Filed 10 findings total: high 0 / med 10 / low 0.

Findings filed:
- review_data_reparent_duplicate_blockers — reparentTask leaks raw SQLite errors on duplicate blockers and is not a true same-set no-op.
- testreview_data_reparent_edges_gap — reparent tests miss duplicate blockers and same-set no-op behavior.
- review_data_addtask_duplicate_blockers — addTask leaks raw SQLite errors on duplicate blockedBy entries.
- testreview_data_addtask_duplicate_gap — add-task blocked-by tests miss duplicate inputs.
- review_data_import_drops_system_author — export/import collapses literal note author "system" to null.
- testreview_data_system_author_gap — import round-trip test seeds author "system" but does not assert it.
- review_data_import_merges_nonempty_ws — import only refuses existing workstreams with tasks, allowing silent merge into agent/workspace-only workstreams.
- testreview_data_import_existing_ws_gap — import tests miss existing target workstreams with agents/workspaces/no tasks.
- review_data_destroy_batch_snapshots — destroy --empty batch takes one sweep snapshot plus one per destroyWorkstream call.
- testreview_data_destroy_empty_snapshot_gap — destroy-empty tests only assert no-victim snapshot behavior, not positive batch count.

Topics most often flagged: duplicate/canonicalized task-edge input leaking substrate errors, import/export metadata drift, documented import/destroy contracts not pinned by tests, and positive-path test gaps around batch/destructive behavior.

Consciously not filed:
- src/exporting.ts and src/importing.ts exceed the 800 LOC refactor signal but remain below the hard 1500 LOC cap; they are cohesive round-trip modules and ARCHITECTURE.md explicitly calls them out as load-bearing large modules.
- Archive re-add note/event incrementality looked suspicious, but an existing task (review_repo_archive_events_not_incremental) was triaged to document snapshot-only semantics; no duplicate filed.
- VCS backend differences (git fetches on refresh, commitsBehind is observation-only, jj dirty semantics always-snapshotted, none backend clean/dirty unanswerable) are documented in VcsBackend comments and tests; no finding filed.
- Real sleeps of 25ms in export/workstream mtime tests are under the fast-tier 50ms threshold where applicable and integration tests tolerate filesystem mtime gaps; no filing threshold.
- CLI-side rendering/help details spotted while reading workstream/archive/task wrappers were left to shard 3 except where needed as cross-shard context for SDK seams.
VERIFIED: mu task notes for all 10 filed tasks were readable; git status remained clean (read-only audit, no source/test/doc edits).
```

### #3 by "worker-2", 2026-05-13T12:47:15.498Z

```
CLOSE: swept 63 files / ~20247 LOC; filed 10 findings (0 high / 10 med / 0 low)
```
