---
id: "bug_tui_popup_cursor_highlight_color_leak"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: null
created_at: "2026-05-12T05:25:20.383Z"
updated_at: "2026-05-12T06:00:59.361Z"
blocked_by: []
blocks: ["feat_log_popup_enter_full_entry_drill", "feat_tui_mouse_input", "nit_tui_drill_inset_title_and_hints", "review_tui_code_and_tests", "t41_manual_smoke"]
---

# BUG: Shift+N popup cursor row highlight is patchy — per-cell color/dimColor overrides outer <Text inverse> so the highlight leaks/breaks; should be solid line-wide

## Notes (2)

### #1 by "π - mu", 2026-05-12T05:26:11.998Z

```
SYMPTOM (verbatim user report)
------------------------------
\"all first-level shiftN drill-down with selectable items render
the 'highlight row' incorrectly. colors leak through. should solid
highlight color for the active line\".

Open any list popup (Shift+1..Shift+8 — anything with a focused
row), j/k to a row. The cursor row should be a solid inverse-video
line spanning the full popup width. Today: only SOME cells of the
focused row invert; others (notably bold or dim ones) keep their
own colour — so the cursor highlight looks broken / patchy /
\"leaky\".

ROOT CAUSE
----------
Every list popup renders cursor rows with this pattern (verbatim
from src/cli/tui/popups/agents.tsx:114-126; same shape in
blocked / inprogress / log / ready / recent / tracks / workspaces):

    <Box key={a.name}>
      <Text inverse={sel}>
        <Text>{glyph}</Text>
        {\"  \"}
        <Text bold>{name}</Text>
        {\"  \"}
        <Text dimColor>{status}</Text>
        {\"  \"}
        <Text dimColor>{taskBit}</Text>
        ...
      </Text>
    </Box>

Two independent issues:

(1) ink's <Text> styling is per-Text; nested <Text> children
    DON'T inherit `inverse` from the parent. Each inner <Text>
    is rendered as its own ANSI sequence, and inner sequences
    (color=cyan, bold=true, dimColor=true) RESET the previous
    inverse SGR state. Result: only the bare-Text and whitespace
    chunks (no own color) carry the inverse; every coloured cell
    breaks it.

(2) The <Box> wrapping the row is content-sized — the inverse
    only covers the rendered characters' columns, not the full
    popup width. Even if (1) were fixed, the highlight would
    end at the last character of the row's content; the rest of
    the line (whitespace right of the row, up to the popup's
    right border) would NOT be highlighted, leaving an obvious
    cut-off.

FIX
---

OPTION A (recommended) — STRIP STYLING FROM CURSOR ROW + PAD TO
WIDTH.

When `sel === true`, render the row's already-padded cells as
PLAIN text (no per-cell color, no bold, no dim) wrapped in a
single <Text inverse> on a <Box width={cols}>. The cursor row
trades its colour palette for visibility:

    if (sel) {
      // Cursor row: solid inverse line, full width, no inner styling.
      const line = padded.join(\"  \");                 // join with the gutter
      const padded2 = line.padEnd(contentWidth);       // pad to popup width
      return (
        <Box key={...} width={contentWidth}>
          <Text inverse>{padded2}</Text>
        </Box>
      );
    }
    // Non-cursor row: render as today (per-cell colour preserved).
    return (
      <Box key={...}>
        <Text>
          <Text>{glyph}</Text> ... <Text dimColor>{...}</Text>
        </Text>
      </Box>
    );

Trade: the focused row loses its glyph colour, bold name, etc.
That's the conventional behaviour in lazygit / k9s / btop —
the inverse video IS the affordance, the colour palette is for
non-focused rows.

OPTION B — KEEP COLOURS ON CURSOR ROW.

Wrap each inner <Text> with its own `inverse` prop forwarded:

    <Text inverse={sel} bold={!sel} ...>...</Text>

Tedious; every cell needs to know about cursor state. AND ink's
ANSI generation order means coloured cursor rows look weird in
many terminals (cyan-on-cyan, etc).

→ Recommend OPTION A. lazygit / k9s do exactly this.

OPTION C (smallest, accepts the cut-off) — REPLACE THE WRAPPING
<Text inverse={sel}> WITH A <Box width={contentWidth}>
WRAPPING ALL THE CELLS, AND RENDER THE FULL ROW VIA backgroundColor
ON THE BOX.

ink supports `backgroundColor` on Box. Set it to a contrast colour
when sel. But ink's Box backgroundColor + inner Text colour
combinations are flaky across terminals; test before promising.

→ Stick with OPTION A.

LINE-PRECISE EDIT
-----------------
Each popup file's row-render JSX needs the same restructure.
Touch:

  src/cli/tui/popups/agents.tsx      lines ~110-135
  src/cli/tui/popups/blocked.tsx     similar block
  src/cli/tui/popups/inprogress.tsx  similar block
  src/cli/tui/popups/log.tsx         similar block (cursor row is
                                     the centred event)
  src/cli/tui/popups/ready.tsx       similar block (list mode only;
                                     drill mode has no per-row
                                     selection)
  src/cli/tui/popups/recent.tsx      similar block
  src/cli/tui/popups/tracks.tsx      similar block (list mode +
                                     drill mode each have a focused
                                     row)
  src/cli/tui/popups/workspaces.tsx  similar block (list mode +
                                     commits-drill mode)

The `padded` array per row is already the cell strings; just join
with two-space gutter and padEnd to contentWidth.

Suggest extracting a tiny helper into popups/row.tsx (or inline
in each file if smaller):

    function CursorRow({ cells, contentWidth }: {
      cells: ReadonlyArray<string>;
      contentWidth: number;
    }): JSX.Element {
      const line = cells.join(\"  \").padEnd(contentWidth);
      return (
        <Box width={contentWidth}>
          <Text inverse>{line}</Text>
        </Box>
      );
    }

…then each consumer becomes:

    if (sel) return <CursorRow key={...} cells={padded} contentWidth={contentWidth} />;
    // unchanged non-cursor path

contentWidth comes from the same termColsForLayout() +
contentWidthFromCols() helpers introduced by
bug_tui_long_lines_overflow.

INTERACTION WITH THE NIT_TUI_DRILL_INSET TASK
---------------------------------------------
nit_tui_drill_inset_title_and_hints will refactor each popup's
Shell to use TitledBox. The cursor-row rendering is independent —
both can land in either order. The CursorRow component lives
inside the Shell's body, untouched by the chrome refactor.

VERIFY
------
1. npm run build
2. node dist/cli.js state --tui -w tui-impl
3. Open Tasks popup (Shift+3). j/k to scroll cursor through rows.
   Each cursor position should show a SOLID inverse line spanning
   the full popup width — no partial highlight, no cut-off.
4. Repeat for every popup that has a focused row.
5. Cursor row text should still be readable (terminal default
   foreground/background swap; no coloured cells stuck in the
   middle).

TESTS
-----
- New test/tui-cursor-row.test.ts: pure-source assertion that the
  CursorRow helper exists + each popup file imports it. Plus a
  unit test for the helper itself: cells join with two-space gutter
  + padEnd to contentWidth + wrapped in <Text inverse>.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file (each popup loses ~15 LOC; gains
  ~3 for the import + use).
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: cursor row renders as a solid inverse line (was patchy —
         per-cell colors leaked through the outer inverse)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish or v0.4.1): bullet under TUI
  bugs fixed.

OUT OF SCOPE
------------
- Don't add a configurable highlight colour (no config file).
- Don't change how non-cursor rows render — they keep their
  per-cell colour palette.
- Don't refactor the popup Shell chrome here; that's
  nit_tui_drill_inset_title_and_hints.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_popup_cursor_highlight_color_leak -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-3", 2026-05-12T06:00:59.361Z

```
CLOSE: 8b62e1a: CursorRow helper renders selected popup row as solid full-width inverse line; eliminates per-cell color leak through nested <Text inverse>. 4 greens (typecheck/lint/test 1812 pass/build); new test/tui-cursor-row.test.ts (29 tests) + static-source guard across 8 popups.
```
