---
id: "review_sweep_tui"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.4
roi: 125.00
owner: "worker-4"
created_at: "2026-05-13T12:30:31.759Z"
updated_at: "2026-05-13T12:57:15.557Z"
blocked_by: []
blocks: []
---

# REVIEW SWEEP shard 4: TUI cluster (cli/tui/*)

## Notes (3)

### #1 by "π - mu", 2026-05-13T12:33:18.446Z

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
YOUR SHARD: TUI CLUSTER  (worker-4, umbrella review_sweep_tui)
═══════════════════════════════════════════════════════════════════════

The interactive ink-based dashboard. ONLY place ink/react are
imported in the codebase. Newest cluster — shipped over the past
two weeks of intense iteration; expect rough edges from rapid
iteration AND a high test density (TUI components are well-tested).

FILES IN YOUR SHARD (~4316 LOC source + matching tests)

Source (read all of these):
  src/cli/tui/index.ts                       (entrypoint)
  src/cli/tui/escapes.ts                  (ANSI constants — pure)
  src/cli/tui/app.tsx                       714  (root state machine)
  src/cli/tui/state.ts                      415  (poll-loop hook)
  src/cli/tui/keys.ts                       251
  src/cli/tui/keymap-spec.ts                234
  src/cli/tui/yank.ts                       166
  src/cli/tui/titled-box.tsx                244
  src/cli/tui/list-row.tsx                   90
  src/cli/tui/columns.ts (if exists)
  src/cli/tui/layout.ts                     381
  src/cli/tui/help.tsx                      150
  src/cli/tui/use-popup-filter.tsx          260
  src/cli/tui/use-status-filter.tsx          97
  src/cli/tui/tab-strip.tsx                  78
  src/cli/tui/tab-strip-layout.ts           182
  src/cli/tui/status-bar.tsx                214
  src/cli/tui/mouse.ts                      217
  src/cli/tui/wrap-ansi.ts                   87
  src/cli/tui/tuicr.ts                       73
  src/cli/tui/padded-rows.tsx                22
  src/cli/tui/popup-shell.tsx                23
  src/cli/tui/cards/{agents,tracks,ready,log,workspaces,inprogress,blocked,recent,doctor}.tsx
  src/cli/tui/popups/{agents,tracks,ready,log,workspaces,inprogress,blocked,recent,doctor}.tsx
  src/cli/tui-launch-focus.ts (if it's TUI-ish; otherwise leave
    for shard 3 — it's listed in shard 3 too — coordinate by
    NOT filing duplicates)

Tests (read & apply test-reviewer):
  Every test/tui-*.ts file. Roughly:
    test/tui-acceptance.integration.test.ts
    test/tui-app-frame-height.test.ts
    test/tui-app.test.ts
    test/tui-card-*.test.ts
    test/tui-popup-*.test.ts
    test/tui-columns.test.ts
    test/tui-cursor-row.test.ts
    test/tui-dashboard-layout.test.ts
    test/tui-drill-*.test.ts
    test/tui-escapes.test.ts
    test/tui-format-helpers.test.ts
    test/tui-git-show.integration.test.ts
    test/tui-glyphs.test.ts
    test/tui-help-overlay.test.ts
    test/tui-keymap-consistency.test.ts
    test/tui-keys.test.ts
    test/tui-launch-focus.integration.test.ts
    test/tui-layout.test.ts
    test/tui-list-row.test.ts
    test/tui-mouse-*.test.ts
    test/tui-mouse.test.ts
    test/tui-popup-filter*.test.ts
    test/tui-state-hook.test.ts
    test/tui-status-bar*.test.ts
    test/tui-tab-strip.test.ts
    test/tui-titled-box.test.ts
    test/tui-yank.test.ts
    test/tui-wrap-ansi.test.ts
    test/tui-tuicr.test.ts (if present)

SHARD-SPECIFIC HOTSPOTS TO PAY ATTENTION TO

- src/cli/tui/app.tsx (714) is the largest TUI file and was the
  hub for a lot of late-stage iteration. Look for: stale state
  patterns, useEffect dep lists that drift, popup state machine
  branches that may never fire.
- src/cli/tui/state.ts (415) — the snapshot poll-loop hook. Look
  for: render-frequency vs subprocess-frequency tier correctness;
  any reads not on the right tick; race between ticks and tab
  switches.
- src/cli/tui/use-popup-filter.tsx (260) is shared across all 9
  popups. Look for: assumptions that DON'T hold for one of the
  popups (e.g. column-name that's missing in the doctor popup).
- 9 cards × 9 popups = obvious duplication risk. Look for: near-
  identical column setups, near-identical formatRow helpers,
  scrolling patterns that are copy-paste with one diff.
- ANSI / wrap math: src/cli/tui/wrap-ansi.ts handles visual-width
  wrapping. Look for: callers that bypass it and use raw <Text>;
  callers that wrap twice.
- titled-box (244) and list-row (90) are the two visual primitives.
  Look for: prop-drilling that should be context, styles defined
  in N places that should be one.
- Tests: tui-acceptance is the heaviest. tui-card-* / tui-popup-*
  files probably mirror each other heavily — if you find 9 near-
  identical test files, that's worth a single "consolidate" finding.

CROSS-SHARD COORDINATION

- Don't review src/cli/tui-launch-focus.ts if it's listed in
  shard 3's manifest — leave that to shard 3.
- The bare-mu TUI-launch decision lives in src/cli.ts (shard 3).
  TUI internals are yours; the launch dispatch is theirs.

UMBRELLA TASK: review_sweep_tui
```

### #2 by "worker-4", 2026-05-13T12:57:07.475Z

```
REVIEW SWEEP SUMMARY — TUI cluster (worker-4)

FILE COUNT REVIEWED:
  Source : 49 files in src/cli/tui/ (entrypoint + escapes + columns +
           state + keys + keymap-spec + yank + titled-box + list-row +
           layout + help + use-popup-filter + use-status-filter +
           tab-strip + tab-strip-layout + status-bar + mouse +
           wrap-ansi + tuicr + padded-rows + popup-shell + format-helpers
           + glyphs + index + 10 cards + 12 popups [agents, all-tasks,
           blocked, commits, cursor-row, dag, doctor, drill, inprogress,
           log, ready, recent, scroll, task-detail, tracks, viewport,
           workspaces]).
  Tests  : 65 files matching test/tui-*.ts (~9700 LOC).

LOC REVIEWED (approx):
  Source : ~9900 LOC (verified via wc -l over the listed shard files).
  Tests  : ~9700 LOC.
  Total  : ~19,600 LOC.

FINDINGS FILED: 21
  high  (impact ≥ 70): 3
    - review_tui_task_popups_duplicated_template (impact 65 — borderline-high)
    - testreview_tui_static_source_grep_pervasive (impact 80)
    - testreview_tui_app_no_behaviour_coverage (impact 75)
  med   (40 ≤ impact < 70): 9
    - review_tui_card_loading_empty_boilerplate (50)
    - review_tui_card_key_from_id_redundant (45)
    - review_tui_workspaces_popup_too_large (55)
    - review_tui_app_uses_internal_ink_emitter (55)
    - review_tui_drill_wraps_body_twice (40)
    - review_tui_app_card_render_two_switches (45)
    - review_tui_renderpopup_dead_code_path (55)
    - testreview_tui_state_hook_static_layer_b (50)
    - testreview_tui_popup_brittle_implementation_coupling (60)
  low   (impact < 40): 9
    - review_tui_glyph_for_zero_arg_overhead (25)
    - review_tui_doctor_remediation_lives_in_popup (35)
    - review_tui_app_render_card_inline_function (25)
    - review_tui_padded_rows_minrows_or_rows (20)
    - review_tui_workspaces_two_filter_instances (30)
    - review_tui_help_overlay_swallows_only_some_keys (30)
    - review_tui_term_cols_for_layout_pop_pop_pop (30)
    - review_tui_dag_double_apply_scroll (30)
    - testreview_tui_yank_blob_format_pinned (30)

Note: review_tui_task_popups_duplicated_template is impact 65 but it
is the largest single duplication finding in the source code; tagging
it "high" in the summary because if shipped, it removes ~150 LOC × 5
files of copy-pasted template. Triage may treat it as med; effort is
0.5d so ROI is good.

TOPICS MOST OFTEN FLAGGED IN THIS SHARD:
  1. STATIC-SOURCE GREP TESTS instead of behaviour tests (umbrella +
     several supporting findings). The pattern is HEAVILY entrenched
     in this shard (~30 of 65 test files use readFileSync on .tsx
     source) and the lack of behaviour testing for the
     largest/most-state-rich files (app.tsx, useDashboardSnapshot)
     is the single biggest weakness I observed. Real bugs in this
     cluster have historically shipped despite passing tests.
  2. COPY-PASTED POPUP/CARD SCAFFOLDING. Five task-popup files
     share a ~150 LOC template; ten cards share ~20-line
     loading/empty placeholder blocks. The cluster's recent
     review_dedup_* notes already extracted SOME shared primitives
     (useDrillKeymap, usePopupFilter, format-helpers, ListRow,
     centredVisibleSlice) but several more dedup opportunities
     remain.
  3. PARALLEL ENUM REPRESENTATIONS for cards (numeric CardId 0..9
     in layout/state vs string keys in CardVisibility) leads to
     two switch statements (cardKeyFromId, popupNameForId) that
     should be a single registry table.
  4. RISKY/INTERNAL DEPENDENCIES — app.tsx reaches into ink's
     `internal_eventEmitter`; the doubleclick path emits N
     synthetic keystrokes via setTimeout to navigate to row N
     (no `setCursor` PopupAction).
  5. WORKSPACES POPUP COMPLEXITY (586 LOC, 3 fused sub-views,
     ad-hoc sentinel state machine, 3 reset useEffects).

THINGS I LOOKED AT AND CONSCIOUSLY DID NOT FILE:
  - The "void fastTickNonce; void slowTickNonce;" pattern in
    9 popups looks like dead code, but it's load-bearing per
    biome's exhaustive-deps and is documented as such in
    state.ts's hook + each popup. The deeper issue is the 3-times-
    duplicated useMemo it sits inside; that IS filed under
    review_tui_task_popups_duplicated_template.
  - layout.ts's allocateRowBudgets / cullCardsForRows are dense
    but well-commented and well-tested in tui-layout.test.ts +
    tui-dashboard-layout.test.ts. They look correct and the
    complexity is genuine domain complexity.
  - tab-strip-layout.ts's grow-from-active algorithm has a
    dense nested while loop with `growLeft = !growLeft` toggle
    that I flinched at, but tui-tab-strip-layout.test.ts has
    real behaviour coverage and the layout is solid. Not filed.
  - escapes.ts (24 LOC pure constants) and glyphs.ts
    (29 LOC) are small enough that nothing rises above filing
    threshold. Pure modules with clear contracts.
  - mouse.ts uses a module-scoped Set<MouseSubscriber> +
    process.stdin attach/detach pattern. Smells like singleton
    state but the comment + setSleepForTests/test attach is
    well-documented. The pattern is necessary for ink integration.
    Not filed.
  - The CursorRow / ListRow split is clean and well-documented
    (review_dedup centralisation). I considered flagging that
    ListRow's "selected → CursorRow delegation" plus the
    standalone CursorRow re-exports is a slight indirection,
    but the rationale is clear in the headers and the existing
    test suite catches drift. Not filed.
  - feat_centralize_scroll_navigation (popups/scroll.ts) is
    exemplary — pure function, tight unit tests, all popups
    consume it. Not filed.
  - The "App.tsx popup-mode block" (app.tsx ~277-318) is dense
    suppress-or-fall-through logic that I almost filed for
    "complexity inside useInput". On re-read it is well-commented
    and the logic IS load-bearing for the Ctrl-C escape hatch +
    popup-filter-mode key suppression. Not filed.
  - tuicr.ts is small (73 LOC), clean, and well-tested. Not filed.
  - keymap-spec.ts has a dense data table but every entry is
    referenced by tui-keymap-consistency.test.ts. Not filed.

CROSS-SHARD COURTESY:
  - I did NOT review src/cli/tui-launch-focus.ts (listed in
    shard 3's manifest per the prompt's coordination note).
  - I did NOT file findings on src/cli.ts (the bare-mu TUI
    launch dispatch decision lives there; that's shard 3's
    file).
  - Where TUI tests reference src/cli/state.ts (e.g. acceptance
    test asserting `runTui(db, { workstreams: ... })`), I noted
    them as test smells in the test file but did NOT file a
    finding against state.ts (shard 3's territory).
```

### #3 by "worker-4", 2026-05-13T12:57:15.557Z

```
CLOSE: swept 49 src files + 65 test files / ~19,600 LOC; filed 21 findings (3 high / 9 med / 9 low). Topics most often flagged: pervasive readFileSync source-grep tests instead of behaviour tests; copy-pasted scaffolding across 5 task popups + 10 cards; parallel CardId 0-9 vs string-keyed enum representations; risky internal_eventEmitter dependency; workspaces popup at 586 LOC with fused sub-views. Summary note posted.
```
