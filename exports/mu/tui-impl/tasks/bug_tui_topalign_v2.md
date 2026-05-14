---
id: "bug_tui_topalign_v2"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.1
roi: 800.00
owner: null
created_at: "2026-05-11T14:48:08.826Z"
updated_at: "2026-05-11T15:12:12.869Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: TUI dashboard not flush with top of pane on enter (alt-screen swap doesn't home/clear cursor)

## Notes (2)

### #1 by "π - mu", 2026-05-11T14:48:38.941Z

```
SYMPTOM
-------
When the user runs `node dist/cli.js state --tui -w tui-impl`, the dashboard
does NOT render flush with the top of the pane. It still appears in the
"middle" of the pane (i.e. wherever the shell prompt happened to be when the
TUI started).

This is a regression-like report against commit 21b43fe ("tui: enter
alt-screen so dashboard is flush with top of pane"), which DID add the
\x1b[?1049h sequence — the swap to alt-screen IS happening, but the alt-screen
buffer in many terminals (iTerm2, Apple Terminal, tmux's inner terminal, ...)
inherits the cursor row position from the prior buffer rather than starting
at row 1.

ROOT CAUSE
----------
Look at src/cli/tui/index.ts:

    const ALT_SCREEN_ENTER = "\x1b[?1049h";
    const ALT_SCREEN_EXIT  = "\x1b[?1049l";

    process.stdout.write(ALT_SCREEN_ENTER);
    // ...render(...)

\x1b[?1049h ALONE is insufficient. The canonical "enter the alt screen and
start drawing at row/col 1" sequence used by lazygit, btop, htop, k9s, vim,
less, etc. is THREE escape sequences in this order:

    \x1b[?1049h    enter alt-screen buffer
    \x1b[2J        clear the entire screen (else stale shell text shows
                   through ink's diff-based renderer until ink overwrites it)
    \x1b[H         home cursor to row 1, col 1

Without `\x1b[H` at minimum, ink's first frame is anchored to whatever row
the cursor was on in the ORIGINAL buffer when we swapped — most terminals
preserve cursor position across the alt-screen swap.

It is also good hygiene to hide the cursor while the TUI runs (`\x1b[?25l`)
and restore it on exit (`\x1b[?25h`); the visible cursor blinks
behind the rendered cards otherwise. lazygit/btop both do this.

FIX
---
Edit src/cli/tui/index.ts:

  const ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
  const ALT_SCREEN_EXIT  = "\x1b[?25h\x1b[?1049l";

(Concatenated string, single write — no flushing reorder hazards.)

Verify:
  npm run build
  node dist/cli.js state --tui -w tui-impl
  → dashboard's TitledBox top border MUST be on screen row 1.
  → no shell prompt remnants visible above the cards.
  → cursor not visible behind the cards.
  → q to quit → shell scrollback fully restored, cursor visible
    on the prompt line.

TESTS
-----
- The escape strings are pure constants; assert their exact bytes in a
  small unit test (NEW file or extend any existing tui index test):

    test("ALT_SCREEN_ENTER homes cursor and hides it", () => {
      // exported the strings or via a tiny helper for testability.
      expect(ALT_SCREEN_ENTER.endsWith("\x1b[H\x1b[?25l")).toBe(true);
      expect(ALT_SCREEN_EXIT.startsWith("\x1b[?25h")).toBe(true);
    });

  Export the constants from index.ts (or move them to a sibling
  `escapes.ts` file inside src/cli/tui/ so the test can import them
  without booting ink). escapes.ts is fine — keeps index.ts clean.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge); escapes.ts has
  no ink imports so it's purely a string-constants module — fine.
- Conventional commit prefix: tui:
- Four greens before commit: typecheck + lint + test + build.
- One commit. Suggested message:
    tui: home + clear + hide cursor on alt-screen enter so dashboard
         renders at row 1
- ARCHITECTURE.md: if you split escapes.ts out, add a one-line row
  to the src/cli/tui/ table; otherwise no doc churn needed.

OUT OF SCOPE
------------
- Do NOT touch the height/ghosting bug — that's a sibling task
  (bug_tui_render_ghosting_v2). Don't bundle them.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_topalign_v2 -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-2", 2026-05-11T15:12:12.869Z

```
CLOSE: 8b05c2f tui: extend ALT_SCREEN_ENTER to swap+clear+home+hide-cursor (escapes.ts) so dashboard renders flush with row 1; 4 greens
```
