---
id: "bug_tui_long_lines_overflow"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.2
roi: 375.00
owner: null
created_at: "2026-05-11T16:44:02.722Z"
updated_at: "2026-05-11T17:59:42.016Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: long titles overflow + wrap (cards/popups call layoutColumns() without totalWidth → clipping disabled)

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:45:00.546Z

```
SYMPTOM (verbatim user repro)
-----------------------------
    ╭─ ³ Ready · 10 ────────────────────────────────────────────...─╮
    │ cfp_k_messageview_refresh_authors_inplace    ROI 200  Fix reconcile in widgets/message_view.py:refresh_authors                           │
    │                            —                                                                                                             │
    │ cfp_l_messageview_replace_message_inplace    ROI 200  Fix reconcile in widgets/message_view.py:replace_message                           │
    │                            —                                                                                                             │
    ...

Each row visually spans TWO lines: the cells render at their natural
widths, the long title pushes the row past the inner Box's right
edge, then ink wraps the trailing `—` (owner cell) to a second line.

ROOT CAUSE
----------
src/cli/tui/columns.ts `layoutColumns(rows, specs, totalWidth?)` has
THIS contract (lines 124-127):

    if (totalWidth === undefined) return widths;

When `totalWidth` is omitted, the function returns natural widths
WITHOUT any clipping — the protect/clip remainder-distribution logic
never runs. That is intentional (the function is designed for both
"layout only" and "layout + clip" callers), BUT every actual caller
in cards/* and popups/* omits the third argument:

    src/cli/tui/cards/agents.tsx:65       layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/cards/blocked.tsx:130     layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/cards/doctor.tsx:94       layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/cards/inprogress.tsx:109  layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/cards/ready.tsx:66        layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/cards/recent.tsx:108      layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/cards/tracks.tsx:64       layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/cards/workspaces.tsx:86   layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/popups/agents.tsx:257     layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/popups/inprogress.tsx:236 layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/popups/log.tsx:177        layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/popups/ready.tsx:226      layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/popups/tracks.tsx:355     layoutColumns(rows, DRILL_COLUMN_SPECS);
    src/cli/tui/popups/tracks.tsx:393     layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/popups/workspaces.tsx:310 layoutColumns(rows, COLUMN_SPECS);
    src/cli/tui/popups/workspaces.tsx:430 layoutColumns(rows, DRILL_COLUMN_SPECS);

ALL 16 callers. Every one. Cards never had it because there was no
real terminal-width budget at the time they shipped (the design
note for feat_responsive_layout deferred dynamic width).

Now that TitledBox sets `width={cols}` from `useStdout()`, every
card/popup IS rendered into a known-width container — we just have
to pass the right number to layoutColumns.

FIX
---
1) Compute the per-card content budget. The TitledBox inner Box has:

      borderLeft: 1
      paddingX: 1   (1 each side)
      borderRight: 1

   Total chrome on each side: 2 (border + padX). So:

      contentWidth = cols - 4

   Pure helper exported from src/cli/tui/titled-box.tsx:

      export function contentWidthFromCols(cols: number): number {
        return Math.max(0, cols - 4);  // 1 border + 1 padX per side
      }

   (Or move it to columns.ts to avoid the layer crossing — pick
   wherever the fewer files import from. Suggest columns.ts as it's
   already the layout-math home.)

2) Wire it through every card + popup:

      const { stdout } = useStdout();
      const cols = stdout?.columns ?? 80;
      const contentWidth = contentWidthFromCols(cols);
      const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

   Each card already imports useStdout via TitledBox? NO — TitledBox
   reads it itself. So each card needs to ALSO call useStdout, OR
   TitledBox needs to expose its computed contentWidth via a render-
   prop / context. Simplest: each card calls useStdout itself. Add
   the import; ink already memoises the value.

3) Popups: same pattern. The popup Shell components also know cols
   (per bug_tui_popups_fill_pane they now set width={cols} too), so
   wiring the same useStdout()→contentWidth into each popup body is
   straightforward.

   For popups whose Shell uses different chrome (e.g. ready.tsx's
   PopupShell), audit each Shell's borderLeft+paddingX and use the
   matching subtraction. Default 4 (1 border + 1 padX per side) is
   the same across all current Shells.

4) Verify the overflow is gone:

      npm run build
      node dist/cli.js state --tui -w <some-real-workstream>

   Open a workstream with very long task ids/titles (the user
   already has one — reproduce against the same shape). Each row
   should occupy exactly one line; long titles get a trailing `…`.

EDGE CASES
----------
- Cards inside the responsive layout (feat_responsive_layout, OPEN)
  may render at less than full pane width. That feature lands later;
  it'll just pass a smaller cols value into the same function. Don't
  hand-tune for it now.

- PROTECTED cells alone might exceed the budget on very narrow panes
  (cols < 60ish). columns.ts already handles this by zeroing the
  CLIPPABLE columns; the row will visually look bad but still
  occupy one line. The "terminal too small" guard at App.tsx (cols
  < 40 or rows < 10) is the last resort.

- Popups widen the title column more than cards. The protect/clip
  spec arrays are already sized appropriately per popup; passing
  the wider contentWidth into layoutColumns gives the title room
  to grow without any spec tweak.

TESTS
-----
- Extend test/tui-columns.test.ts with the contentWidthFromCols
  pure-function cases (chrome subtraction, floor at 0, narrow-cols
  overflow shape).

- For each card/popup test file, add a static-source assertion that
  the file passes a third argument to layoutColumns (regex match
  for `layoutColumns(rows, ...,`). Crude but catches the exact
  regression.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- No SDK changes — pure layout fix.
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: pass contentWidth to layoutColumns from every card/popup
         (long titles now clip with `…` instead of overflowing
         to a second line)

DOCS
----
- CHANGELOG.md (under v0.4.0): bullet under TUI bugs fixed.
- docs/ARCHITECTURE.md: if you add contentWidthFromCols to columns.ts,
  the existing src/cli/tui/* row already covers columns.ts — just
  mention the helper in the columns.ts cell description.

OUT OF SCOPE
------------
- Don't refactor the 16 near-duplicate `useStdout` reads into a
  shared hook yet — one concrete consumer per call site is fine
  per the no-anticipatory-abstractions pledge. If a hook makes
  sense AFTER feat_responsive_layout lands (where each card might
  receive a parent-driven contentWidth prop instead), file a
  follow-up.

- Don't change layoutColumns' signature — its current dual
  natural/clipped contract is fine. The fix is at the call sites.

- Don't change the COLUMN_SPECS arrays unless you find one that's
  genuinely wrong (e.g. all PROTECTED with no clip). Audit but
  don't 'tune'.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_long_lines_overflow -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-3", 2026-05-11T17:59:42.016Z

```
CLOSE: f9f85ce496fb0ed570c1673064f7881e93eecd5d: pass contentWidthFromCols(termColsForLayout()) to layoutColumns at all 16 call sites; long titles now clip with … instead of wrapping. 4 greens (typecheck/lint/1605 tests/build).
```
