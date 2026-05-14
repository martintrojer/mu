---
id: "bug_drill_text_no_truncate_wrap"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.1
roi: 700.00
owner: "worker-3"
created_at: "2026-05-13T13:43:43.483Z"
updated_at: "2026-05-13T14:00:33.729Z"
blocked_by: ["review_tui_drill_wraps_body_twice"]
blocks: []
---

# BUG: drill body Text re-wraps on bytes (ANSI) — right border ragged in git-show

## Notes (2)

### #1 by "π - mu", 2026-05-13T13:51:33.080Z

```
TASK: bug_drill_text_no_truncate_wrap — drill body Text element
re-wraps on byte count (counting ANSI escapes), breaking the right
border in git-show / agent-scrollback / any-coloured drill view.

VERBATIM USER MOTIVATION
> "git show pane still renders incorrectly ... parts of the right
>  hand side border is off aligned. appears broken."

ROOT CAUSE

src/cli/tui/popups/drill.tsx DrillScrollView renders each visible
line as:

    <Text key={`${start + i}`}>{ln === "" ? " " : ln}</Text>

WITHOUT a `wrap` prop. ink's default `wrap` is "wrap" (overflow
wraps to a new visual row) and ink counts BYTES — not visual width
— when computing the wrap point. That breaks for lines that already
contain ANSI SGR escapes:

  - The wrapAnsi pre-wrap (wrapWidth = cols - 6) makes each line
    VISUALLY ≤ cols-6.
  - ink sees the BYTE length, which includes the ANSI escape bytes
    (`\x1b[31m`, etc.). Bytes > cols-4 (the popup's inner content
    width) → ink wraps the line mid-text, often mid-escape sequence.
  - The wrapped overflow consumes a new row but the right border of
    the popup chrome was already rendered for that row → the
    overflow text spills past it, the next row's border is one
    cell out of alignment.

This is the same class of bug that was supposedly fixed for
git-show in 591f55e — the wrapAnsi PRE-wrap was added, but the
component-level re-wrap was never disabled.

FIX

Add `wrap="truncate"` to the drill body Text:

    <Text key={`${start + i}`} wrap="truncate">
      {ln === "" ? " " : ln}
    </Text>

Justification:
- We've already done a precise visual-width wrap upstream
  (`wrapAnsiLines(body, wrapWidth)`). Whatever the line is now, we
  WANT it on one terminal row. If wrapAnsi over-shoots (bug), we
  prefer truncation (visual integrity of the popup chrome) over
  re-wrap (broken chrome).
- ink's `wrap="truncate"` honours visual width via string-width,
  not bytes — same library wrapAnsi uses. So a correctly pre-wrapped
  line will fit exactly; an incorrectly over-budget line will be
  truncated cleanly with no border breakage.

ALSO (defensive)

While in DrillScrollView, audit the title row and the hint row at
the top/bottom of the drill body — both are rendered as Text without
`wrap="truncate"`. Add it there too. Title is already truncateCell'd
into headerTitleWidth so this is belt-and-suspenders, but the dim
" · {positionLabel}" Text is appended on the same line and could
push it just over the budget on tight terminals.

TESTS

- test/tui-drill-no-wrap.test.ts (likely already exists from the
  591f55e fix). Extend OR add:
  (i)  A test that mounts DrillScrollView with a body containing
       ANSI red diff markers AND lines exactly at wrapWidth
       characters. Render to text via _ink-render fixture.
       Assert: every visible row has visual-width ≤ wrapWidth (no
       wrap-induced extra rows).
  (ii) A test that mounts DrillScrollView with a body that
       deliberately exceeds wrapWidth (bug input). Assert: each
       row is TRUNCATED (no wrap-overflow row appears in render
       output).

CONSTRAINTS
- Touch:
    src/cli/tui/popups/drill.tsx (add wrap="truncate" to body +
      title/hint Text; document why)
    test/tui-drill-no-wrap.test.ts (extend OR new test)
    CHANGELOG.md
- TUI cluster only.
- Bundle smoke MANDATORY: `node dist/cli.js --help`.
- Four greens: typecheck + lint + test:fast + build (full optional;
  TUI render so :fast covers).
- Commit prefix: `tui:`. ONE commit. Suggested:
    tui: drill body Text wrap=truncate so ink's byte-wrap doesn't break right border

DOCS
- CHANGELOG.md under [Unreleased] / Fixed.

VERIFY MANUALLY
- `mu` → drill into Workspaces → Enter → drill into a commit (`git
  show`). Assert: right border vertical line is straight, top to
  bottom of the drill body, regardless of pane width / line lengths.
- Same for `mu` → Agents popup → drill → agent scrollback (also
  ANSI-coloured).

PARALLEL WORK NOTE
- worker-1: build tooling (tsconfig.test.json; unrelated)
- worker-2: src/cli/tui/app.tsx (registry collapse). MAY touch
  drill.tsx if they widen prop signatures? Their prompt said avoid;
  if they did, conflict at cherry-pick time.
- worker-4: src/cli/tui/cards/* (CardPlaceholder; unrelated)
- worker-3 just shipped review_tui_drill_wraps_body_twice (also in
  drill.tsx). If your edit conflicts with their changes, manual
  resolve.
- CHANGELOG.md is shared.

⚠️ FINAL ACTION
After four greens AND manual TTY verification:

  mu task close bug_drill_text_no_truncate_wrap -w tui-impl \
    --evidence "<sha>: drill body Text wrap=truncate; ink no longer re-wraps on bytes; right border straight"
```

### #2 by "worker-3", 2026-05-13T14:00:33.729Z

```
CLOSE: f24f5df: drill body Text wrap=truncate; ink no longer re-wraps on bytes; right border straight
```
