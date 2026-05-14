---
id: "review_tui_code_and_tests"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: null
created_at: "2026-05-12T05:36:34.392Z"
updated_at: "2026-05-12T08:43:00.228Z"
blocked_by: ["bug_tui_log_card_columns_misaligned", "bug_tui_popup_cursor_highlight_color_leak", "bug_tui_tab_switch_stale_render", "feat_centralize_scroll_navigation", "feat_log_popup_enter_full_entry_drill", "nit_tui_drill_inset_title_and_hints"]
blocks: ["tui_impl_complete"]
---

# REVIEW: run code-reviewer + test-reviewer skills across the entire new TUI surface; file a task per finding (gate on tui_impl_complete; only run AFTER all bugs/nits closed)

## Notes (3)

### #1 by "π - mu", 2026-05-12T05:39:19.379Z

```
GOAL
----
Run the canonical code-reviewer + test-reviewer skills across
EVERY file the TUI workstream introduced or modified. File a
new mu task per finding (don't try to fix in-line). The audit
serves as the final ship-gate before tui_impl_complete closes.

This task is a HARD GATE: it cannot be claimed until every other
TUI bug / nit / feat is closed. Edges added in this same edit
batch enforce that.

WHY (the user's framing)
------------------------
\"i have a hunch that there is lots of duplication and refactoring
opportunities. the agent running the reviews should log a task
for each finding. this should not be run until impl is more or
less done and we have no more outstanding bugs / nits\".

Concrete reasons to gate the audit instead of running it now:
  - Every still-open bug fix (cursor-leak, log-overflow, tab-stale)
    will rewrite chunks the reviewer would otherwise audit.
  - feat_centralize_scroll_navigation explicitly extracts ~60
    duplicated case branches into a shared primitive — running
    the reviewer BEFORE that lands flags the same duplication
    that's already on the docket. Wasted attention.
  - nit_tui_drill_inset_title_and_hints rewrites every popup
    Shell. Same.
  - feat_tui_mouse_input adds a brand-new mouse layer; reviewer
    should see the final shape, not an intermediate.

So: this task waits until the surface is stable, then audits
once.

REVIEWER SCOPE
--------------
Audit ALL of the following (the entire TUI surface introduced
or substantially modified by the v0.4 work):

  src/cli/tui/index.ts
  src/cli/tui/escapes.ts
  src/cli/tui/app.tsx
  src/cli/tui/state.ts
  src/cli/tui/keys.ts
  src/cli/tui/yank.ts
  src/cli/tui/titled-box.tsx
  src/cli/tui/columns.ts
  src/cli/tui/help.tsx
  src/cli/tui/status-bar.tsx
  src/cli/tui/glyphs.ts
  src/cli/tui/tab-strip.tsx
  src/cli/tui/use-popup-filter.tsx
  src/cli/tui/scroll.ts                  (assuming feat_centralize lands)
  src/cli/tui/mouse.ts                   (assuming feat_tui_mouse_input lands)
  src/cli/tui/hit-test.ts                (same)
  src/cli/tui/cards/*.tsx                (9 files)
  src/cli/tui/popups/*.tsx               (9 files + drill.tsx + task-detail.tsx + viewport.ts)

…plus every test file under test/tui-*.test.ts.

REVIEWER SKILLS
---------------
The orchestrator's environment exposes two skills explicitly for
this purpose:

  ~/.agents/skills/code-reviewer/SKILL.md
    Use for: dead code, duplication, unnecessary complexity,
    non-idiomatic patterns. \"Use after implementing a feature,
    after refactors, or whenever code quality feedback is
    requested.\"

  ~/.agents/skills/test-reviewer/SKILL.md
    Use for: false confidence, excessive mocking, meaningless
    assertions, weak behavior coverage. \"Use after writing tests
    or when a suite passes but bugs still escape.\"

Read both skills FIRST. They have explicit anti-patterns to scan
for and a structured output format. Follow it.

PER-FILE PROCESS
----------------
For each file in the scope above:

  1. Read the file (use the read tool, don't grep-and-skim).
  2. Run the code-reviewer skill's checks against it. List every
     finding with: file:line, category (dead-code / duplication /
     complexity / non-idiomatic), severity (low/med/high), one-line
     summary, and a suggested fix.
  3. For test files: run the test-reviewer skill's checks. List
     findings the same way.
  4. After the per-file pass: a CROSS-FILE pass for finding
     duplication patterns (e.g. \"5 popup files have a near-
     identical Shell function\" or \"3 cards re-implement the same
     subtitle formatter\").

OUTPUT — A TASK PER FINDING
---------------------------
For EACH finding the audit produces, file a new mu task in
workstream tui-impl:

  - id pattern: review_<short-slug>  (e.g. review_dedup_popup_shells)
  - title: \"REVIEW <severity>: <one-line summary>\"
  - impact: 30-60 depending on severity
  - effort-days: 0.05-0.3 depending on size
  - notes: file:line citations + suggested fix sketch + cross-ref
    back to this review task

If a finding is LOW severity AND <10 LOC fix, the auditor MAY
fix it in-line and document under this review task instead of
filing a new task. Use judgement; default = file a task.

REVIEWER ANTI-PATTERNS (BANNED)
-------------------------------
- Don't claim \"all good\" when low-hanging duplication exists.
  Two near-identical files = a finding.
- Don't recommend abstractions that don't have ≥2 concrete
  consumers (per AGENTS.md \"no anticipatory abstractions\" rule).
- Don't recommend renaming as a finding unless it's actively
  confusing (the bar is high).
- Don't recommend test-coverage increases by line count;
  recommend BEHAVIOUR coverage gaps. Test count is not a goal.

OUTPUT FORMAT (this task's CLOSE evidence)
------------------------------------------
When closing this task, the evidence string should list:
  - N findings (code-reviewer)
  - M findings (test-reviewer)
  - K tasks filed
  - L tasks fixed in-line (if any)

Plus a one-paragraph summary in a final note on this task,
linking each filed task by id.

DELIVERABLE TIMING
------------------
The audit runs ONCE near the end of v0.4. After it completes:
  - All filed sub-tasks are queued; orchestrator triages and
    dispatches normally.
  - tui_impl_complete unblocks ONLY when every filed sub-task
    closes (or is explicitly marked DEFERRED).

If the audit produces an unmanageable backlog (>10 high-severity
findings), that's a real signal that v0.4 isn't ready and we
should defer the ship.

CONSTRAINTS
-----------
- This task does NOT modify code itself (except the in-line fix
  carve-out above).
- This task does NOT add new tests. It points at coverage gaps;
  fixing them is the filed-task's job.
- Conventional commit prefix for in-line fixes: refactor: or test:
- Four greens before any in-line commit.

DOCS
----
- CHANGELOG.md (under v0.4 polish or v0.5): bullet under \"Internal\"
  noting the post-v0.4 audit pass + any major findings.
- The audit's per-finding notes themselves are the durable
  artefact in mu's task graph.

⚠️ FINAL ACTION ⚠️
After all findings are filed (and any in-line fixes are
committed):
    mu task close review_tui_code_and_tests -w tui-impl --evidence \"<N+M findings, K tasks filed, L fixed>\"
```

### #2 by "worker-3", 2026-05-12T08:38:34.662Z

```
AUDIT SUMMARY — 26 findings filed as new tasks (15 code-reviewer + 11 test-reviewer; no in-line fixes — orchestrator triages and dispatches).

CODE-REVIEWER FINDINGS (15)
---------------------------

duplication / centralisation #4 candidates:
  review_dedup_popup_shell           — 8 byte-identical Shell function copies + 1 PopupShell variant in popups/. Single shared component.
  review_dedup_popup_useinput        — 9 popups copy the dispatchPopupKey key-flag pack. Hoist to a `dispatchPopupKeyFromInk(input, key)` wrapper.
  review_dedup_drill_keymap          — 9-10 popups have the same drill-mode useInput skeleton (isNavAction → applyScroll, close, yank, return). Hoist to `useDrillKeymap(...)` next to DrillScrollView.
  review_dedup_drill_centring_visible_slice — 3 popups inline `Math.max(0, Math.min(items.length-viewport, cursor-Math.floor(viewport/2)))`. Hoist to scroll.ts.
  review_dedup_filter_editing_effect — 8 popups copy the StatusBar onFilterEditingChange useEffect. Bake into usePopupFilter.
  review_dedup_format_roi            — formatRoi hand-rolled in 5 places (2 helpers + 3 inline). Hoist to src/state.ts.
  review_dedup_color_for_bucket      — colorForBucket copy-pasted in 3 places. Hoist next to roiBucket in src/state.ts.
  review_dedup_age_ms                — ageMs in cards/inprogress + cards/recent are now consumed by 4 callsites (header comment "single call site, not worth sharing" is stale). Hoist.
  review_unify_format_when_since     — formatSinceClaim + formatWhen + relTime are 3 implementations of the same date-bucket rule. Unify via src/cli/format.ts.
  review_dedup_classify_event_verb_pattern — 5 callsites of classifyEventVerb in log card+popup repeat the row-cell builder. One helper.

dead-code:
  review_dead_code_refresh_now       — `r` / F5 binding bumps `refreshNonce` whose only consumer is a no-op useEffect. The "refresh now" affordance is a lie. Wire to the hook OR drop.
  review_dead_code_workstream_picker — `w` binding shows a "v0.next" toast but does nothing. Same lie pattern. Drop or implement.
  review_dead_code_glyph_for_unused  — 3 `glyphFor(_t: TaskRow)` ignore their argument. Replace with constants (or drop the arg).

complexity / non-idiomatic:
  review_complexity_status_bar_hint_dual_render — status-bar.tsx maintains hintsPlain() + renderHints() in lockstep. Drift surface; build a single `{plain, jsx}` token list.
  review_complexity_filter_consume_ignore — classifyFilterKey hijacks `appendChar` with `char:""` as a sentinel. Add a first-class `consume` action variant for clarity.
  review_complexity_app_helpopen_path — help-overlay close is hand-wired BEFORE dispatchGlobalKey runs (asymmetric with popup close). Fold into the dispatcher.

TEST-REVIEWER FINDINGS (11)
---------------------------

false-confidence / fake-testing (high severity):
  review_tests_card_truthy_assertions    — 9 card test files do `expect(SomeCard({snapshot:...})).toBeTruthy()` — that's import-graph testing, not behaviour. Single biggest gap.
  review_tests_static_source_overuse     — Most popup tests are `expect(src).toContain("mu task ...")` or regex grep. Tests pass when string appears anywhere in the file, even a comment. Recommends ink-testing-library install + behaviour rewrite.
  review_tests_acceptance_isnt_acceptance — tui-acceptance.test.ts is mostly source greps, not E2E. Real acceptance would mount the TUI + send keystrokes + assert frame.
  review_tests_app_test_grep             — tui-app.test.ts only structurally inspects app.tsx source.

weak-coverage (med severity):
  review_tests_yank_matrix_per_state     — Yank matrix is the load-bearing UX feature; tested only by substring presence. Must simulate keystroke + assert callback arg.
  review_tests_drill_chain_navigation    — Tracks (3-level) + Workspaces (3-level) drill recursion has no behaviour test for Enter→Enter→Esc→Esc transitions.

weak-coverage (low severity):
  review_tests_workspaces_show_loadshow_unmocked — loadShow shells out to git but the truncation + ANSI-strip + error path are gated only by source greps.
  review_tests_yank_osc52_unverified    — OSC-52 fallback path (the SSH default) has zero coverage. Critical because TUI's whole pivot is "yank commands".
  review_tests_state_hook_indirect      — useDashboardSnapshot's two layers (key-equality short-circuit + snap-to-null) tested only via static-source markers. ~50 LOC test would pin real behaviour.

duplication in tests:
  review_tests_inline_card_source_blocks — 7 card test files have the same "no in-body +M more" trailer; collapse to one sweep test.

CROSS-CUTTING THEMES
--------------------

(1) The dominant code-reviewer theme is duplication, NOT dead code or complexity. The TUI codebase has shipped 3 centralisations (ListRow, scroll.ts, viewport.ts) — there are at least 5 more high-value candidates queued (Shell, useInput pack, drill keymap, format helpers, filter-editing effect). Centralisation #4 should be `Shell` or `useInput pack` — both are pure mechanical edits that touch ~9 files each.

(2) The dominant test-reviewer theme is "tests grep on source instead of exercising behaviour". The root cause is the missing ink-testing-library install (network-blocked in the dev env per several test-file comments). Installing it unlocks ~6 of the 11 test findings; without it, the cards/popups have NO real rendering tests.

(3) Two findings are LIES (review_dead_code_refresh_now, review_dead_code_workstream_picker). Both bind a key, show it in the help overlay, and either do nothing or show a toast that says "v0.next". User UX impact is real: the operator presses `r`, expects a refresh, sees the help label confirming `r` is bound, and gets nothing.

NO HIGH-SEVERITY DEAD CODE; NO CIRCULAR IMPORTS; NO ABSTRACTIONS WITH 0 CONSUMERS.

PER THE TASK BRIEF: zero in-line fixes (every finding > 10 LOC OR has cross-cutting impact); 26 tasks queued for follow-up triage.

Reviewers' methodology: full read of every file under src/cli/tui/* (cards x9, popups x9 + drill/cursor-row/scroll/viewport/task-detail, infrastructure x10) + every test/tui-*.test.ts (43 files); cross-referenced with the canonical code-reviewer/test-reviewer skills; respected the AGENTS.md "no anticipatory abstraction" / "no rename suggestions" / "no test-count-as-coverage" anti-patterns.
```

### #3 by "worker-3", 2026-05-12T08:43:00.228Z

```
CLOSE: audit complete: 26 findings filed (15 code-reviewer + 11 test-reviewer); 0 in-line fixes; tasks: review_dedup_popup_shell review_dedup_popup_useinput review_dedup_format_roi review_dedup_color_for_bucket review_dedup_age_ms review_unify_format_when_since review_dedup_classify_event_verb_pattern review_dedup_drill_keymap review_dedup_filter_editing_effect review_dead_code_refresh_now review_dead_code_workstream_picker review_dead_code_glyph_for_unused review_complexity_status_bar_hint_dual_render review_complexity_filter_consume_ignore review_complexity_app_helpopen_path review_dedup_drill_centring_visible_slice review_tests_card_truthy_assertions review_tests_static_source_overuse review_tests_acceptance_isnt_acceptance review_tests_app_test_grep review_tests_yank_matrix_per_state review_tests_drill_chain_navigation review_tests_workspaces_show_loadshow_unmocked review_tests_yank_osc52_unverified review_tests_state_hook_indirect review_tests_inline_card_source_blocks; commit 849ff86; 4 greens
```
