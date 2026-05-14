---
id: "bug_tui_drill_text_no_width_pin"
workstream: "tui-impl"
status: CLOSED
impact: 85
effort_days: 0.15
roi: 566.67
owner: "worker-2"
created_at: "2026-05-12T10:16:44.443Z"
updated_at: "2026-05-12T10:34:10.693Z"
blocked_by: []
blocks: []
---

# BUG: every long-text drill view (task notes / git show / log payload / agent scrollback / activity log card) wraps long lines because DrillScrollView body <Text> has no parent <Box width=...> so wrap=truncate is a no-op — fix once centrally

## Notes (3)

### #1 by "π - mu", 2026-05-12T10:17:50.403Z

```
SYMPTOM (verbatim user)
-----------------------
"6. looks like all long details views wrap. hopefully this can be
fixed centrally."

Plus four concrete repros that are all the SAME bug:
  #2 task details (mu task notes drill) wraps
  #3 activity log card wraps long strings (NOT the popup row drift —
       the actual bottom-most rest cell flows past the right border;
       the user reports #3 column not aligned, hinted at #1 too)
  #4 workspaces git-show drill line-wraps
  #6 ALL long detail views wrap

#1 (Agents card top scrolls outside viewport) is a SEPARATE bug —
filed under bug_tui_dashboard_top_card_scrolls_off (worker-3 already
shipped a fix in 65a5fad, but the user is still seeing it). Will
re-file separately.

#5 (Enter in doctor view "shouldn't work but does") is by design —
the doctor popup has a drill mode that renders the per-check
remediation paragraph + status detail (per feat_popup_9_doctor /
nit_tui_drill_inset_title_and_hints Layer 2). Not a bug. Mention in
PR notes only.

ROOT CAUSE — drill body <Text> has no parent width pin
------------------------------------------------------
src/cli/tui/popups/drill.tsx:158 (DrillScrollView body branch):

    visible.map((ln, i) => (
      <Text key={`${start + i}`} wrap="truncate">
        {ln === "" ? " " : ln}
      </Text>
    ))

`wrap="truncate"` is set BUT the parent (TitledBox's inner Box) does
not pin a width prop. ink only honours wrap="truncate" when the
parent Box has a defined width — Box width defaults to its content's
intrinsic width, which IS the unbounded line. Truncate has nothing
to clip against → ink falls back to wrapping.

Same bug class as bug_tui_log_popup_columns_misaligned (per-row Box
in popups had no width pin) which we fixed for the LIST rows
(commit 390a238 — pin width={contentWidth} on the per-row Box). The
DRILL body slipped through that fix because it lives in DrillScrollView,
not in the per-popup row JSX.

CONFIRMED via grep: every consumer of DrillScrollView passes the
body text but NEVER passes a width — TitledBox auto-flows.

SAME CLASS AFFECTS THE LOG CARD
-------------------------------
Wait — the activity-log card uses ListRow, which DOES pin
width={contentWidth} (commit 390a238). So why is it wrapping?

Look at the `rest` column in COLUMN_SPECS for cards/log.tsx:
    { kind: "clip", min: 1 }

The clip allocator gives it `contentWidth - protectedSum - gutters`
columns. ListRow's outer <Box width={contentWidth}> + <Text
wrap="truncate"> inside should clip. But `min: 1` may be
under-counting the protected columns when contentWidth = small +
the rest cell is >> remaining-width.

Actually re-reading the user repro:
  │ 06:53:00  system    task status         feat_workspaces_drill_git_show ... ││
  │ 06:49:33  worker-3  ·                  task.claim    bug_tui_log_popup_columns_misaligned  actor=worker-3 ... │
                                          ^^^ wider than the row above
          
The col-3 "verb" cell has different widths across rows ("task status"
= 11 chars vs "·" = 1 char). The protect spec computes the MAX width
needed across all rows → all rows pad cell-3 to the widest. But the
rendered VISIBLE width is then 11 chars + gutter = 13 cols — and the
row above renders "task status" (11) followed by gutter, while the
row below renders "·" + 10 padding spaces + gutter. They SHOULD line
up but the user sees drift.

HYPOTHESIS: the second column is not protected in the same widths
calculation. Look at COLUMN_SPECS:

    { kind: "protect" }, // ts (HH:MM:SS)
    { kind: "protect" }, // source
    { kind: "protect" }, // verb (or '·' fallback)
    { kind: "clip", min: 1 }, // rest / payload

`source` is `protect` → max-width across all rows → "worker-3" = 8,
"system" = 6, "π - mu" = 6 (with display width). So source col is
padded to 8 (or wider if any row's source name is longer). Looks
correct.

Two possible explanations for the user's visual drift:
  (a) classifyEventVerb returns null for some payloads (the "·"
      fallback) but its `rest` is the FULL payload, while for
      classified payloads `rest` is just the trailing slug. The
      LENGTH of the rest cell varies wildly per row. With "·"
      events the verb cell shrinks but the rest cell expands past
      the available clip width.
  (b) Same as #6: ListRow's <Text wrap="truncate"> is in a Box with
      width=contentWidth, but ink's flex layout still lets the
      <Text> overflow if it has no `flexShrink`. The popup row
      width pin worked (commit 390a238) so this seems unlikely…
      unless the cards mount the rows differently than popups.

NEEDS DIAGNOSIS — the implementer should reproduce locally and
inspect.

FIX — TWO LAYERS
----------------

LAYER 1 (DRILL — covers #2, #4, #6 + the doctor remediation render):

In src/cli/tui/popups/drill.tsx, the body <Text> tags need a parent
<Box width=...>. Either:
  (a) Wrap each line in <Box width={contentWidth}><Text wrap="truncate">
      — explicit per-line.
  (b) Let TitledBox accept a contentWidth-pin prop OR inject one
      automatically based on stdout columns.
  (c) Use ink's `<Box flexDirection="column" width={contentWidth}>`
      around the visible.map and let each <Text> share it (cleanest).

Option (c) is one extra <Box> + the contentWidth from termColsForLayout/
contentWidthFromCols. Smallest diff.

The same <Box> wrapper should also go around the empty-state <Text>
fallback for consistency.

LAYER 2 (CARDS log + popups list rows — covers #3):

If the log card's rest column drift is the same bug class — ListRow's
<Text wrap="truncate"> not engaging — diagnose by pinning the test
case (a row whose `rest` is a 200-char string in a 100-col terminal).
Expected: rest clips at column N. Observed: rest wraps to next line.

If the bug repros, the fix is in ListRow itself: add `flexShrink={1}`
to the inner <Text> so ink shrinks the children rather than spilling.
OR explicitly add `<Text wrap="truncate" textWrap="truncate">` (ink
has both names depending on version).

VERIFY (CHEAP)
--------------
1. npm run build
2. node dist/cli.js state --tui -w tui-impl
3. Open Tasks popup (Shift+3) → pick the centralisation feedback note → Enter to drill.
   Each line should clip at the right magenta border (no wrap to next terminal row).
4. Same for Workspaces (Shift+5) → Enter → Enter → git show.
5. Same for Log popup (Shift+4) → Enter on a long-payload event.
6. Same for Agents popup (Shift+1) → Enter on a busy worker.
7. For #3 specifically: shrink the terminal so the activity log card has narrow contentWidth (~80 cols). Long payloads in the rest column should clip with `…` or hard cut, NOT wrap.

TESTS
-----
- New test/tui-drill-no-wrap.test.ts: static-source assertion that
  drill.tsx renders the visible.map inside a <Box width=...> wrapper.
- Extend test/tui-list-row.test.ts: assert ListRow's outer Box has
  flexShrink set if Layer 2 needs it.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: drill body lines clip at contentWidth (was wrapping —
         <Text wrap=truncate> is a no-op without a parent <Box width>;
         applies to every long-text drill: task notes, git show,
         event payload, agent scrollback, doctor remediation)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish): bullet under TUI bugs fixed,
  cross-ref bug_tui_log_card_columns_misaligned and
  bug_tui_log_popup_columns_misaligned (the two prior fixes that
  thought they got everything; this completes the trio).

OUT OF SCOPE
------------
- Don't add a wrap-and-count fallback (separate task; deferred).
- Don't change the position counter math.
- Don't change DrillScrollView's API surface.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_drill_text_no_width_pin -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-2", 2026-05-12T10:34:09.170Z

```
FILES: src/cli/tui/popups/drill.tsx; src/cli/tui/cards/log.tsx; src/cli/tui/popups/log.tsx; test/tui-drill-no-wrap.test.ts; test/tui-drill-scrollview.test.ts; test/tui-card-log.test.ts; test/tui-popup-log.test.ts; CHANGELOG.md
COMMANDS: npm run typecheck exit 0; npm run lint exit 0; npm run test exit 0 (rerun after one unrelated/flaky integration timeout + one updated stale static assertion); npm run build exit 0; manual expect PTY: node dist/cli.js state --tui -w tui-impl at 80 cols, observed Activity-log card clipping and aligned human task claim verb.
FINDINGS: Drill <Text wrap=truncate> needed a finite-width parent; added Box width={contentWidth}. Activity-log ListRow width pin was working; observed card did not wrap at 80 cols. The apparent col-3 drift was structured task.claim payloads rendering as raw task.claim sentinel/fallback, so log card/popup now displayEventPayload before classification.
DECISION: Kept Layer 2 in ListRow unchanged; no flexShrink needed based on manual TUI diagnosis.
NEXT: none.
VERIFIED: npm run typecheck && npm run lint && npm run test && npm run build all green after final changes; commit 5142a34.
ODDITIES: First full npm run test in the four-command chain had a one-off timeout in cli-task-wait.integration cross-ws reaper test; rerun of npm run test passed all 120 files / 1956 tests.
```

### #3 by "worker-2", 2026-05-12T10:34:10.693Z

```
CLOSE: 5142a34: drill body width pin
```
