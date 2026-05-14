---
id: "bug_ink_truncate_eats_right_border"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.15
roi: 533.33
owner: "worker-3"
created_at: "2026-05-13T15:30:46.549Z"
updated_at: "2026-05-13T15:42:04.762Z"
blocked_by: []
blocks: []
---

# BUG: ink wrap=truncate on ANSI text drops right border + trailing space (visual width row 88 vs box 90)

## Notes (3)

### #1 by "π - mu", 2026-05-13T15:31:05.126Z

```
TASK: bug_ink_truncate_eats_right_border — drill body row containing
ANSI loses its right border `│` because ink truncates ANSI content
to a width that consumes the box's trailing chrome cells.

DIAGNOSIS (orchestrator-confirmed reproducer)

User clue: every broken drill row matches `@@ -X,Y +A,B @@ f` —
i.e. a hunk header from `git show --color=always` whose function-
context label runs past the popup width and triggers ink's
`wrap="truncate"`.

Reproducer (added to /tmp/wraptest.mjs during diagnosis):
- Render a width=90 paddingX=1 borderStyle=round Box.
- One child Text wrap="truncate" with content
  `\x1b[36m@@ -35,6 +81,109 @@\x1b[m xxxxxxxxx...` (visual width 100).
- Capture ink output.
- Top/bottom border rows: visual width 90 ✓
- ANSI-coloured truncated row: visual width 88 ✗ (missing 2 cells:
  the trailing space + right border `│`).
- A PLAIN-TEXT truncated row at the same width: visual width 90 ✓
  (right border intact).

Root cause: ink (or its cli-truncate dependency, or yoga's text
metrics) miscounts the budget when ANSI escapes are present in
truncated text. The truncated chunk is shorter than the box content
width by ~2 cells AND the row stops emitting characters past the
last cli-truncate ellipsis — no padding, no right border.

This is the SAME class of bug that the f24f5df wrap=truncate fix
+ de4d4f0 SGR-leak fix were trying to solve, but neither addressed
the actual mechanism — ink's truncate path itself eats the chrome.

FIX

Don't depend on ink's `wrap="truncate"` to fit ANSI lines into the
box. Pre-render every drill body line to EXACTLY `wrapWidth`
visual columns: pad with spaces (and a trailing SGR reset if
needed), so ink has nothing to truncate.

Add a `padAnsiLine(line: string, width: number): string` helper
in src/cli/tui/wrap-ansi.ts:

    export function padAnsiLine(line: string, width: number): string {
      const w = stringWidth(line);
      if (w >= width) return line;
      // Trailing-spaces pad up to `width`. Spaces don't carry SGR
      // state but if the line ends inside an open SGR, the spaces
      // would inherit the colour. closeIfOpen is already applied
      // upstream (the line is end-clean). So plain-space pad is safe.
      return line + " ".repeat(width - w);
    }

Update `wrapAnsiLines` (and / or the drill body composer) to pad
each line to wrapWidth before joining with `
`. Or expose a new
`wrapAndPadAnsiLines(text, width)` helper for the drill path:

    export function wrapAndPadAnsiLines(text: string, width: number): string {
      return text
        .split("
")
        .flatMap((line) => wrapAnsi(line, width))
        .map((line) => padAnsiLine(line, width))
        .join("
");
    }

In src/cli/tui/popups/drill.tsx, change `wrapDrillBody` (or
wherever wrapAnsiLines is called for the body) to use the
padded variant. Then DROP `wrap="truncate"` from the body Text —
keep wrap="truncate" on title/hint/empty (those stay short).

Or alternative: keep wrap="truncate" but pad first; truncate-on-
already-fitting-line is a no-op so it's still safe.

DEFENSIVE: add a unit test that mounts a Box(width=90, paddingX=1,
borderStyle=round) with a child Text containing the ANSI hunk
header (visual width 100), captures the output, and asserts every
non-corner row has visual width = 90 (i.e. the right border is
present and aligned).

TESTS
- Add to test/tui-wrap-ansi.test.ts (or new test/tui-drill-render-border.test.ts):
  - Direct: padAnsiLine pads short ANSI line to width with spaces;
    no double-pad; no spurious SGR.
  - Integration: render a Box(90, paddingX=1, borderStyle=round) +
    Text containing the canonical hunk header. Every visible row
    has visual width 90. The right border `│` is the last
    visible char of every row.
- Existing wrap-ansi tests stay green.

CONSTRAINTS
- Touch:
    src/cli/tui/wrap-ansi.ts (add padAnsiLine, wrapAndPadAnsiLines)
    src/cli/tui/popups/drill.tsx (consume the padded variant; drop
      wrap="truncate" on body OR keep belt-and-suspenders)
    test/tui-wrap-ansi.test.ts (extend)
    Possibly a new test/tui-drill-render-border.test.ts for the
    integration assertion
    CHANGELOG.md
- TUI cluster only.
- Bundle smoke MANDATORY.
- Four greens: typecheck (broader) + lint + full test + build.
- Commit prefix: `tui:`. ONE commit. Suggested:
    tui: pad drill body lines to box width; ink no longer eats right border on ANSI truncation

DOCS
- CHANGELOG.md under [Unreleased] / Fixed.

VERIFY MANUALLY
- `mu` → drill into Workspaces → Enter on a workspace → Enter on a
  commit. Right border `│` is a single straight cyan column on
  EVERY row, including the rows that contain `@@ -X,Y +A,B @@ f`
  hunk headers. Top to bottom of the drill, no exception.
- Same for Agents popup → drill into agent scrollback (also
  ANSI-coloured).

PARALLEL WORK NOTE
- worker-1: src/cli/tui/popups/* (filter-drill bug fix; if they
  edit drill.tsx the orchestrator handles the conflict)
- worker-2: src/agents.ts (lastClaimEvent helper; unrelated)
- worker-4: test/tui-popup-{ready,inprogress,blocked}.test.ts
  (sibling test conversion; unrelated to wrap-ansi)
- CHANGELOG.md is shared.

⚠️ FINAL ACTION
After four greens AND manual TTY verification:

  mu task close bug_ink_truncate_eats_right_border -w tui-impl \
    --evidence "<sha>: padAnsiLine + wrapAndPadAnsiLines; drill body lines exact wrapWidth; ink truncate path bypassed; right border intact on ANSI rows"
```

### #2 by "worker-3", 2026-05-13T15:42:01.049Z

```
FILES: src/cli/tui/wrap-ansi.ts; src/cli/tui/popups/drill.tsx; test/tui-wrap-ansi.test.ts; test/tui-drill-keymap.test.ts; test/tui-drill-no-wrap.test.ts; CHANGELOG.md
COMMANDS: npm run test:fast -- test/tui-wrap-ansi.test.ts test/tui-drill-no-wrap.test.ts (failed first on stale source-guard, fixed); npm run test:fast -- test/tui-wrap-ansi.test.ts test/tui-drill-no-wrap.test.ts (exit 0); npm run test:fast (failed first on stale wrapAnsiLines source-guard, fixed); npm run test:fast (exit 0); npm run typecheck && npm run lint && npm run test:fast && npm run test && npm run build (exit 0); manual tmux TTY bundle smoke with node dist/cli.js.
FINDINGS: Ink truncation with ANSI hunk headers can still eat trailing chrome when body rows rely on wrap="truncate" to fit content. Padding every pre-wrapped drill row to the exact wrapWidth makes Ink receive already-fitting lines, so the truncate path is a safety belt only.
DECISION: Added padAnsiLine plus wrapAndPadAnsiLines in wrap-ansi.ts and routed wrapDrillBody through the padded variant. Kept wrap="truncate" in DrillScrollView as belt-and-suspenders for unexpected over-budget callers.
VERIFIED: Direct pad tests, wrapAndPad tests, and Ink Box(width=90,paddingX=1,borderStyle=round) ANSI hunk-header regression assert all rows have visual width 90 and body rows end with │. Manual TTY: launched built CLI in tmux, opened Workspaces -> worker-1 -> git show d855c5ccbb40, scrolled to ANSI @@ hunk rows; captured rows retained right border aligned on every coloured row. Four greens + build passed.
NEXT: closed by commit 6c3a81c.
```

### #3 by "worker-3", 2026-05-13T15:42:04.762Z

```
CLOSE: 6c3a81c: padAnsiLine + wrapAndPadAnsiLines; drill body lines exact wrapWidth; ink truncate path bypassed; right border intact on ANSI rows
```
