---
id: "bug_tui_render_ghosting_v2"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.1
roi: 800.00
owner: null
created_at: "2026-05-11T14:48:43.537Z"
updated_at: "2026-05-11T15:18:24.181Z"
blocked_by: []
blocks: ["bug_tui_popups_fill_pane", "tui_impl_complete"]
---

# BUG: TUI ghosting on card toggle (frame height shrinks → stale lines below remain)

## Notes (2)

### #1 by "π - mu", 2026-05-11T14:49:20.471Z

```
SYMPTOM
-------
Toggling card visibility (digit keys 1/2/3/4 hide-show the matching card)
leaves "ghost" lines on screen. Steps to reproduce:

1. node dist/cli.js state --tui -w tui-impl
2. (full dashboard renders, ~30+ rows tall)
3. Press '1' → Agents card hides → frame is now SHORTER
4. Below the shortened frame, the BOTTOM rows of the previous (taller) frame
   are still visible — borders, last log line, etc.
5. Press '1' again → Agents card reappears → frame full size, ghosts overlap
   with new content until the user resizes the pane (which forces a redraw).

There is a previous "bug_tui_render_ghosting" task in this workstream
(commit cd1cce9 / a928bbe / etc.) that addressed an earlier ghosting class.
This is a NEW manifestation specific to card-toggle frame-height changes.

ROOT CAUSE
----------
ink's renderer uses a diff-based redraw: it tracks the lines IT wrote in
the previous frame and only erases-then-rewrites the lines it owns. When
the new frame is SHORTER than the previous, ink does not know it needs to
clear the trailing lines because those lines were "owned" by the prior
frame's bottom — but the diff sees no change, so no clear is emitted.

(See ink-render's behaviour: it uses log-update under the hood, which
clears N lines based on the LAST frame's height; but only when log-update's
own `clear()` is called. Re-renders only clear the lines they're about to
overwrite.)

The canonical fix in btop/htop/lazygit is to either:
  (a) Render every frame at FULL terminal height (pad with empty lines),
      so the diff always covers the same line range, OR
  (b) Issue an explicit \x1b[2J (clear screen) on every height-shrink.

(a) is simpler, idempotent, and matches what the existing src/cli/tui/app.tsx
already half-does (it reads stdout.rows for a too-small guard but does not
constrain the frame height to it).

FIX
---
In src/cli/tui/app.tsx, set the root <Box> to height={rows} so every frame
fills the terminal. ink will then clear-and-rewrite every line on each frame.

  return (
    <Box flexDirection="column" height={rows}>
      ...cards...
      <Box flexGrow={1} />     // pushes StatusBar to the bottom
      <StatusBar ... />
    </Box>
  );

The flexGrow={1} spacer is the lazygit/btop convention: the cards stack at
the top and the status bar sticks to the bottom regardless of how many
cards are visible. As a side effect this also FIXES a UX nit: today the
status bar floats up against the cards, which looks cramped when only one
card is visible.

Apply the same pattern to the help branch and the popup branch (they have
their own root Box), so toggling between dashboard / popup / help never
shrinks the frame and never ghosts.

  if (helpOpen) {
    return (
      <Box flexDirection="column" height={rows}>
        <Help />
        <Box flexGrow={1} />
        <StatusBar mode="help" ... />
      </Box>
    );
  }

  if (popup !== null) {
    return (
      <Box flexDirection="column" height={rows}>
        {renderPopup(popup)}
        <Box flexGrow={1} />
        <StatusBar mode="popup" ... />
      </Box>
    );
  }

CAVEAT
------
A popup body that wants to consume "all remaining space" (e.g. the Log
popup's scrollable region) needs flexGrow={1} on its OWN inner Box, NOT
on a sibling. Inspect each popup file (popups/agents.tsx, popups/log.tsx,
popups/ready.tsx, popups/tracks.tsx); if any of them already have a
flexGrow region, the new outer flexGrow={1} spacer in app.tsx is
redundant and would steal the space — in that case, drop the spacer and
let the popup own the bottom-fill.

Verify cmd-by-cmd:
  npm run build
  node dist/cli.js state --tui -w tui-impl
  → press 1, 2, 3, 4 each twice; no ghost lines below the shortened frame.
  → press % (Shift+5) ... oh wait, popups are 1..4 with Shift; press
    Shift+1 / Shift+2 / Shift+3 / Shift+4 to open each popup; then press
    q to close. No ghost lines either direction.
  → press ? to open help; press q to close. Same — no ghosts.
  → resize the terminal smaller, then larger. ink already handles
    resize via stdout 'resize' event; verify nothing breaks.

TESTS
-----
- Add a static-source assertion test (test/tui-app-frame-height.test.ts):
  read src/cli/tui/app.tsx as a string and assert that EACH of the three
  return branches (dashboard / help / popup) contains `height={rows}` on
  its root Box. Crude but catches the regression cheaply.

- Optionally: verify the "spacer Box flexGrow" idiom is present where
  expected (regex match).

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file (app.tsx is currently ~210 lines; this
  change adds <10).
- Conventional commit prefix: tui:
- Four greens before commit.
- One commit. Suggested message:
    tui: pin frame to terminal height + bottom-stick status bar so card
         toggles don't leave ghost lines

OUT OF SCOPE
------------
- Don't touch the alt-screen enter sequence — that's the sibling task
  bug_tui_topalign_v2.
- Don't change the StatusBar component itself; the spacer goes in app.tsx
  only.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_render_ghosting_v2 -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-3", 2026-05-11T15:18:24.181Z

```
CLOSE: 4489275 pin root <Box> to height={rows} + flexGrow spacer (dashboard/help) so card toggles & branch swaps don't leave ghost lines; popup branch omits spacer (popup owns bottom-fill); new test/tui-app-frame-height.test.ts; 4 greens (typecheck/lint/1407 tests/build)
```
