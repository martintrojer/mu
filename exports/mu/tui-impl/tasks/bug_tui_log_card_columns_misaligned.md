---
id: "bug_tui_log_card_columns_misaligned"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.2
roi: 325.00
owner: null
created_at: "2026-05-12T05:28:23.171Z"
updated_at: "2026-05-12T05:49:57.019Z"
blocked_by: []
blocks: ["feat_log_popup_enter_full_entry_drill", "review_tui_code_and_tests", "t41_manual_smoke"]
---

# BUG: Activity log card (and possibly others) — long rows still wrap or overflow; column boundaries don't line up — contentWidth doesn't account for the gutter padding/border slack

## Notes (2)

### #1 by "π - mu", 2026-05-12T05:29:31.372Z

```
SYMPTOM (verbatim user repro)
-----------------------------
\"long cells are still not clipped correctly leading to wrapping.
columns don't always line up. see activity log\":

  ╭─ ⁴ Activity log · last ↑8 ───────────────...─╮
  │ 15:11:24  π - mu    task note   feat_track_drill_chains_to_task_drill (note #1216 by π - mu)  │
  │ 15:10:07  system    task block  tui_impl_complete by feat_track_drill_chains_to_task_drill │
  │ 15:10:04  system    task add    feat_track_drill_chains_to_task_drill (impact=65, effort=0.2, blocked-by=feat_popup_enter_drill) │
  │ 15:04:28  worker-2  ·    task.claim    bug_tui_topalign_v2    actor=worker-2    self=0    task claim bug_tui_topalign_v2 by worker-2 …  │
  │ 15:04:23  system    workspace refresh   worker-2 (backend=git, fromRef=refs/remotes/origin/HEAD, replayed=1) │
  │ 15:00:43  worker-3  task note   feat_popup_enter_drill (note #1206 by worker-3)              │
  │ 15:00:4
  ╰──────────────────────────────────────────...─╯

Two failure modes visible:
  - Some rows extend beyond the card's right border (no clip,
    no `…` ellipsis, just runs into the border-fill).
  - Some rows wrap to a partial second line (`15:00:4` cut off
    mid-timestamp).
  - Column boundaries shift between rows — the `task note` /
    `task block` / `task add` cells start at different x-positions.

Same symptom class as the original bug_tui_long_lines_overflow,
which we thought was fixed (commit ba1b6e7 + f553a77 + 566de0b
threaded contentWidth through every layoutColumns call site).
Re-opening the diagnosis.

ROOT CAUSE — contentWidth IS WRONG BY ≥2
----------------------------------------
src/cli/tui/columns.ts contentWidthFromCols(cols) currently does:

    return Math.max(0, cols - 4);  // 1 border + 1 padX per side

i.e. subtracts 4 from the terminal cols (TitledBox border 1 + paddingX 1
on each side = 4 cols of chrome). But the row-render code in each
card's body adds MORE chrome that contentWidth doesn't know about:

  (a) Inter-cell gutter — every consumer renders rows as:
        <Text>{glyph}</Text>{\"  \"}<Text bold>{name}</Text>{\"  \"}<Text dimColor>{...}</Text>...
      The literal {\"  \"} between cells is 2 cols × (N-1) gutters. The
      `layoutColumns` helper allocates per-column widths assuming the
      gutter is part of contentWidth, but the per-cell <Text> chunks
      then ADD the gutter spaces VISIBLY on top of the allocated widths.
      Net: the rendered row is content + (N-1)*2 cols wider than
      contentWidth.

  (b) Card body's left padding from TitledBox's inner Box `paddingX={1}`.
      contentWidthFromCols subtracts BOTH sides (= 2), but the rendered
      row's `<Box>` doesn't pad its OWN content — only the outer TitledBox
      Box does. If ink computes width based on the PARENT Box's
      content area, the row inherits the parent's content area which
      is already cols-4. But layoutColumns' `totalWidth` argument was
      passed cols-4. So row content can fit exactly in cols-4 …
      EXCEPT for issue (a) above.

  (c) Activity log specifically renders each row as TWO separate
      <Text> chunks (timestamp + payload) joined by a literal space,
      not via the columns.ts gutter convention. That extra layout
      path bypasses the contentWidth calc altogether.

Combined effect: the protect/clip allocator runs as if the row has
contentWidth cols available, but actual rendered width is contentWidth
+ gutters + extra-renders. Long clip cells \"fit\" per the allocator
but overflow per ink's terminal output.

The wrapping the user sees is ink's own `terminal.lineBreak` behaviour
when a single <Text> exceeds the parent <Box>'s width — ink wraps
to the next line.

FIX — TWO LAYERS
----------------

LAYER A (cheap; fixes most cases): the gutter accounting bug.

In src/cli/tui/columns.ts layoutColumns, the COL_GUTTER constant
(currently 2) is already used to subtract gutters from `remaining`
for the protect/clip allocator:

    const gutters = ncols > 1 ? (ncols - 1) * COL_GUTTER : 0;
    const remaining = totalWidth - protectedSum - gutters;

That's correct — but the renderRow output cells are then re-padded
WITHOUT the gutter being part of any cell. Each cell is padCell'd
to its allocated width, then the consumer's JSX appends a literal
{\"  \"} (or {\" \"}) BETWEEN them. The gutter IS already accounted
for; the bug is when the consumer renders MORE THAN COL_GUTTER (=2)
spaces between cells, OR uses different spacing in different rows.

Audit each card's body JSX:

  src/cli/tui/cards/agents.tsx
  src/cli/tui/cards/blocked.tsx
  src/cli/tui/cards/doctor.tsx
  src/cli/tui/cards/inprogress.tsx
  src/cli/tui/cards/log.tsx          ← user's repro
  src/cli/tui/cards/ready.tsx
  src/cli/tui/cards/recent.tsx
  src/cli/tui/cards/tracks.tsx
  src/cli/tui/cards/workspaces.tsx

For each: confirm the inter-cell separator is exactly {\"  \"} (two
spaces, matching COL_GUTTER=2) and there are no extra spaces /
non-padded raw cells / hand-rendered chunks bypassing the column
allocator.

The Log card is most likely shipping with a bespoke render path
(not via layoutColumns at all, or with extra glue spaces) — start
the audit there.

LAYER B (deeper; ensures it stays fixed): make renderRow OWN the
gutter, not the consumer.

Today renderRow returns `string[]` — one string per cell — and the
consumer's JSX appends gutters between them. Change renderRow to
return a SINGLE joined string with the gutter built in, and have
consumers render the row as one <Text> chunk (or split it back via
a width-preserving slice if per-cell colour is needed).

Tradeoff: per-cell colour requires multiple <Text> chunks, which
re-introduces the gutter risk. Keep renderRow returning per-cell
strings BUT add a strict invariant: the consumer's JSX MUST use
exactly one {\" \".repeat(COL_GUTTER)} between adjacent cells, no
other spacing. Add an ESLint rule or a static-source assertion
test that every `renderRow(...)` consumer follows the pattern.

LAYER C (defensive; handles ink wrapping): pin the row's <Box> to
contentWidth.

In each card's body, the per-row <Box> currently inherits the
parent's content area. Add `width={contentWidth}` to each row's
outer Box so ink clamps the rendered chunks to that exact width.
If the joined cells overflow, ink will TRUNCATE (or wrap; depends
on the Text overflow prop) — pick \"truncate\" so long rows clip
visibly instead of wrapping.

Specifically: ink's <Text> supports `wrap=\"truncate\"` (or
`wrap=\"truncate-end\"`). Add it to every row's outermost <Text>:

    <Text wrap=\"truncate\">  /* truncate-end if you want \"...\" suffix */
      <Text>{glyph}</Text>{\"  \"}<Text>{cell2}</Text>...
    </Text>

This is the BELT to layoutColumns' SUSPENDERS. Even if the column
allocator under-estimates by 1-2 cells, ink's own truncation
catches it before the row wraps.

VERIFY
------
1. npm run build
2. node dist/cli.js state --tui -w tui-impl
3. Activity log card — look for any row that wraps. Should be ZERO.
4. Toggle a card off (e.g. press 4 to hide log) and back on; check
   the log card re-renders with all rows clipped.
5. Resize the pane narrower and wider; the truncation should
   re-flow on every SIGWINCH.
6. Zoom into the bottom-right of every card: rows end exactly at
   the rounded right border, with `…` (ellipsis) where applicable
   for clip cells. No row extends past the border or wraps.

EDGE CASES
----------
- Activity log card: rows are timestamped events with verb prefixes;
  the payload column carries arbitrary text. Likely the worst-case
  for clipping. Make sure its column specs include a generous
  `clip` for the payload AND that the consumer JSX uses the
  protect+clip pattern (no hand-rolled rendering).
- Tracks card: track NUMBER is short, GOAL list can be long; same
  pattern.
- Ready card: titles are CLIPPABLE; ROI / id are PROTECTED.

TESTS
-----
- Extend test/tui-columns.test.ts: a unit test that asserts
  `renderRow(rows, widths, specs).join(\"  \")` length is ≤ totalWidth
  for synthetic inputs. (Verifies the join math.)
- New test/tui-card-render-width.test.ts: per-card static-source
  assertion that the body JSX includes `wrap=\"truncate\"` on every
  outer row <Text>, AND uses the canonical {\" \"+\"  \"} gutter
  literal (regex match).

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file (this is a cleanup, no growth).
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: card rows clip cleanly at contentWidth (was overflowing /
         wrapping due to gutter-accounting + ink-overflow bugs)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish or v0.4.1): bullet under TUI
  bugs fixed. Reference bug_tui_long_lines_overflow as the original
  task that this completes.
- docs/ARCHITECTURE.md src/cli/tui/columns.ts cell: mention the
  gutter invariant and the wrap=\"truncate\" defensive layer.

OUT OF SCOPE
------------
- Don't change COL_GUTTER from 2; the convention is established.
- Don't add per-card configurable gutters.
- Don't refactor the Log card into a different render path
  (popups have their own; cards keep theirs).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_log_card_columns_misaligned -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-3", 2026-05-12T05:49:57.019Z

```
CLOSE: fb93799: every outermost row <Text> in src/cli/tui/{cards,popups}/*.tsx now sets wrap="truncate" so ink clips long rows at contentWidth instead of wrapping; static-source guards in new test/tui-card-render-width.test.ts (truncate prop + canonical {"  "} gutter) + extra renderRow.join() width assertion in test/tui-columns.test.ts; four greens (typecheck + lint + 1783 tests + build)
```
