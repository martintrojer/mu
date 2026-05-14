---
id: "bug_help_overlay_no_scroll_on_low_rows"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: "worker-3"
created_at: "2026-05-13T05:44:08.678Z"
updated_at: "2026-05-13T08:39:38.705Z"
blocked_by: ["bug_t_keypress_replays_stale_mouse_dblclick"]
blocks: []
---

# BUG: '?' help overlay overflows on low-row panes — keys at bottom hidden behind StatusBar; needs j/k/Ctrl-D/U scroll + position indicator

## Notes (4)

### #1 by "π - mu", 2026-05-13T05:45:09.532Z

````
MOTIVATION (verbatim user)
--------------------------
"bug, the help pane need to be scrollable on low-row panes"

CURRENT STATE
-------------
After commit 55dca75 (single-column help overlay), src/cli/tui/help.tsx renders all HELP_PANES (from src/cli/tui/keymap-spec.ts) into a single rounded Box. Total height = sum of (1 header + N rows + 1 separator) per pane = ~50 logical rows for the current keymap. On a typical 24-row terminal, the bottom half of the overlay is hidden behind the StatusBar with no way to scroll.

src/cli/tui/app.tsx line 350-353:
  if (helpOpen) {
    return (
      <Box flexDirection="column" height={rows} overflow="hidden">
        <Help />
        ...

`overflow="hidden"` clips the bottom — the user sees the upper half of the keymap and nothing else.

LOCKED DESIGN
-------------
Add inline scroll state to <Help> via the centralised src/cli/tui/popups/scroll.ts primitives:

1. Convert HELP_PANES into a flat array of "render row specs":
   ```ts
   type HelpRenderRow =
     | { kind: 'header'; text: string }
     | { kind: 'row'; keys: string; effect: string }
     | { kind: 'separator' };
   ```
   Build it once via useMemo from HELP_PANES (one header per pane, then its rows, then a separator before the next pane).

2. Compute viewport from the available terminal rows: total_rows - 2 (border) - 1 (StatusBar) - 1 (position indicator) = body rows.
   Use the existing `usePopupViewport()` pattern OR pass rows down from <App> as a prop. Simpler: take rows as a prop — Help is rendered conditionally by App which already reads rows via useStdout.

3. useState<scrollTop> + j/k/Ctrl-D/Ctrl-U/g/G/PgDn/PgUp wired via dispatchPopupKey + applyScroll (the same helpers DrillScrollView uses).
   - Esc/q close the overlay (unchanged — handled in app.tsx already).
   - All other dispatchPopupKey actions feed into a local applyScroll call.

4. Position indicator inset into the title (mirror DrillScrollView's pattern):
     "keys · 12-30/52"
   shows the visible row range over the total row count.

5. Wire useInput INSIDE Help() to capture nav keys when helpOpen. Don't ship the Help component a callback — let it own the scroll state and consume keys directly. App.tsx's existing key handler (line 225) already routes Esc/q/? to setHelpOpen(false) — leave that path alone.

BUT WAIT — keys conflict between Help's local nav and App's global key dispatcher. Look at app.tsx line 220-280 to confirm: the global dispatcher fires for ALL keys when helpOpen is true (line 225 only handles Esc/q/Q for close). So `j`/`k`/Ctrl-D/U during help-open would currently fall into the global keymap and might toggle a card or worse.

Easiest seam: when helpOpen, app.tsx SHORT-CIRCUITS the global keymap for navigation keys and lets Help own them. Add a guard:
  if (helpOpen) {
    // close keys (existing)
    if (key.escape || input === "q" || input === "Q" || input === "?") {
      setHelpOpen(false);
      return;
    }
    // anything else: let Help's own useInput see it. Just return without dispatching globally.
    return;
  }

Then Help's own useInput runs and processes j/k/Ctrl-D/U/g/G/PgDn/PgUp via dispatchPopupKey + applyScroll.

⚠️ COORDINATION ⚠️
Both workers in flight on other tasks (worker-2: git-show colors; worker-3: t-debounce mouse-replay). This task gates behind nothing functionally but touches src/cli/tui/help.tsx + src/cli/tui/app.tsx. Worker-3's t-debounce task ALSO touches app.tsx. **Coordinate**: gate this task behind bug_t_keypress_replays_stale_mouse_dblclick to avoid file conflict.

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js`. After build, smoke:
  npm run build && node dist/cli.js --help && node dist/cli.js --version

WIRING
------
- src/cli/tui/help.tsx Help():
  * Add `rows` prop (terminal rows for viewport sizing).
  * Build flatRows = useMemo from HELP_PANES.
  * useState<scrollTop> + useInput consuming dispatchPopupKey actions through applyScroll.
  * Render the rounded outer Box with title that includes the position indicator.
  * Render only flatRows.slice(scrollTop, scrollTop + viewport) inside.

- src/cli/tui/app.tsx:
  * Pass rows={rows} into <Help />.
  * Update the helpOpen guard at line 225 to swallow non-close keys (let Help own nav).

TESTS (REQUIRED)
----------------
- test/tui-help-overlay.test.ts: extend with:
  * Help is rendered with a fixed inner viewport (test by passing rows=15; assert only N flatRows render based on the viewport math).
  * Scroll state increments on j; clamps at bottom.
  * Position indicator string is correct (e.g. "1-12/52").
  * On rows=200 (every line fits): no position indicator, all rows visible.

VERIFY MANUALLY
---------------
After build:
  cd /Users/mtrojer/hacking/mu
  # Resize tmux pane to ~15 rows tall, then:
  node dist/cli.js -w tui-impl
  # Press '?' — overlay opens; only top-half of keymap visible.
  # Press 'j' / Ctrl-D — scrolls down. Position indicator updates.
  # Press 'g' — back to top. 'G' — to bottom.
  # Press '?' or 'q' or 'Esc' — closes; back to dashboard.
  # Resize back to full height; '?' shows all rows; no position indicator.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual smoke at 15-row pane.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; help.tsx is ~30 LOC; this is a ~50 LOC change.
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: '?' help overlay scrolls (j/k/Ctrl-D/U/g/G/PgDn/PgUp + position indicator) so it stays usable on low-row panes

DOCS
----
- CHANGELOG.md [Unreleased] under "Fixed":
  * "TUI '?' help overlay is now scrollable. On low-row panes (e.g. 24 rows) the previous single-column render hid the bottom half of the keymap behind the StatusBar; now j/k/Ctrl-D/U/g/G/PgDn/PgUp scroll the body and a position indicator (`1-12/52`) sits inset into the title."
- docs/USAGE_GUIDE.md: brief mention of help-overlay scroll.

OUT OF SCOPE
------------
- No filtering / search inside the help overlay.
- No tab-pagination of help panes.
- No per-pane collapse/expand.
- No multi-column reflow at very wide widths (the new single-column render is the user-locked layout).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>.

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual smoke at low-row pane, close YOUR task with:
  mu task close bug_help_overlay_no_scroll_on_low_rows -w tui-impl --evidence "<sha>: <one-line summary including 'verified scroll on 15-row pane'>"
````

### #2 by "worker-3", 2026-05-13T08:27:07.909Z

```
DECISION: starting implementation in worker-3 workspace after blocker bug_t_keypress_replays_stale_mouse_dblclick is CLOSED.
```

### #3 by "worker-3", 2026-05-13T08:39:34.506Z

```
FILES: src/cli/tui/help.tsx; src/cli/tui/app.tsx; test/tui-help-overlay.test.ts; docs/USAGE_GUIDE.md; CHANGELOG.md
COMMANDS: npm run typecheck (0); npm run lint (0); npm run test:fast (0); npm run test (0); npm run build (0); node dist/cli.js --help (0); node dist/cli.js --version (0); manual tmux smoke: node dist/cli.js -w tui-impl in 100x15 pane, ? open, j/Ctrl-D/g/G scroll, q close (0)
FINDINGS: help overlay now renders viewport slice and clamps 1-12/53 through 42-53/53 on 15-row pane; App swallows non-close keys while help is open.
DECISION: reused popup scroll primitives and TitledBox title inset; exported pure helpers for behavior tests without ink-testing-library.
NEXT: none.
VERIFIED: all gates green; bundle smoke green; verified scroll on 15-row pane.
ODDITIES: none.
```

### #4 by "worker-3", 2026-05-13T08:39:38.705Z

```
CLOSE: 603693b: help overlay scrollable with popup keys and verified scroll on 15-row pane
```
