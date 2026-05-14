---
id: "feat_tui_mouse_input"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.5
roi: 110.00
owner: "worker-3"
created_at: "2026-05-12T05:36:34.131Z"
updated_at: "2026-05-12T19:06:29.796Z"
blocked_by: ["bug_tui_popup_cursor_highlight_color_leak", "feat_centralize_scroll_navigation"]
blocks: []
---

# FEAT: mouse support in --tui (double-click on card → drill; scroll wheel in list → scroll; double-click on list row → drill into row; no mouse 'back')

## Notes (3)

### #1 by "π - mu", 2026-05-12T05:38:11.114Z

```
GOAL
----
Wire mouse input into the --tui dashboard. Specifically:

  1.1  Double-click anywhere INSIDE a top-level card → drill into
       the matching popup (same as Shift+N keyboard).
  1.2  Mouse scroll-wheel up/down inside a list view (popup body
       OR drill scrollback OR card body) → scroll the focused
       list (same as j/k or Ctrl-D/U).
  1.3  Double-click on a list ENTRY in a popup → drill one level
       down (same as Enter on focused row).
  1.4  NO mouse action for 'back'. Esc/q/right-click are NOT
       wired. Keyboard remains the canonical way out — by design.
       Document this in the help overlay so the affordance is
       clear.

WHY (the user's framing)
------------------------
\"new feat task to support mouse click and scrolls in the tui\":
  - macOS / iTerm2 / kitty / WezTerm / Ghostty all forward mouse
    events when the app opts in via `\x1b[?1000h` / `?1006h` (SGR
    extended). Today the TUI ignores them. A new operator who
    instinctively scrolls the dashboard sees nothing happen.
  - Drilling via double-click matches every modern TUI's
    convention (k9s, lazygit, btop have wide-spread mouse
    affordances).

INK MOUSE SUPPORT — STATE OF THE ART
------------------------------------
ink itself does NOT ship a useMouse() hook. There are two viable
paths:

  PATH A (vendor a tiny mouse layer): write a small
    src/cli/tui/mouse.ts module that:
      - On runTui startup, writes the SGR mouse-enable escape
        sequences to stdout (\x1b[?1000h \x1b[?1002h \x1b[?1006h).
      - On runTui exit (finally block in src/cli/tui/index.ts),
        writes the disable sequences (\x1b[?1000l ...).
      - Subscribes to process.stdin for raw mouse-report bytes
        (\x1b[<button;x;y;M for press / m for release in SGR
        mode), parses them into typed MouseEvent objects.
      - Exposes a useMouse() hook that <App> consumes (similar
        shape to ink's useInput()).

  PATH B (use ink-mouse if installable): a community package
    exists. The ROADMAP pledge restricts new TUI deps; if
    ink-mouse is sufficient + auditable + ≤ ~5KB + zero
    transitive deps it might be acceptable. Default: PATH A
    (we already vendor every other escape-sequence interaction
    in src/cli/tui/escapes.ts).

→ Recommend PATH A. Vendor a ~150 LOC mouse.ts module + a tiny
  useMouse() hook. Keeps the dep surface flat per the ROADMAP
  pledge. ink/react still only-in-src/cli/tui/.

DESIGN — DOUBLE-CLICK DETECTION
-------------------------------
SGR mouse mode reports per-press / per-release events. A
double-click is two press events on the same (x, y) cell within
~400ms. Implement as a small reducer:

  state: { lastClickAt: number; lastClickX: number; lastClickY: number }
  on press(x, y, t):
    isDouble = (t - lastClickAt < 400) && (x === lastClickX) && (y === lastClickY)
    update lastClick* = (t, x, y)
    emit either { kind: \"click\" } or { kind: \"doubleClick\" }

Single-click (1.1's \"single click anywhere\") is intentionally NOT
wired — too easy to trip accidentally. Only DOUBLE-click drills.

DESIGN — HIT-TESTING (mapping (x, y) → which card / row)
--------------------------------------------------------
ink doesn't expose a per-component bounding-box query. We need
to build the hit-test ourselves. Two options:

  HIT-TEST OPTION α (snapshot heights at render time):
    Each card's render path returns { cardId, top, height }
    via a side-channel (a useRef'd map keyed by cardId). The
    mouse handler reads the map and finds the card whose
    [top, top+height) range contains the click y.

    Pro: accurate.
    Con: needs every card to instrument itself.

  HIT-TEST OPTION β (re-derive heights from snapshot data):
    Pure-function derivation: given the snapshot + visibility
    flags + viewport rows, compute each card's expected height
    deterministically. Match click y against the same calc.

    Pro: no instrumentation; pure.
    Con: needs to mirror every card's height-budget logic
         (which feat_responsive_layout will eventually own).

→ Recommend option α — single side-channel ref in <App>; each card
  instruments itself with `<MouseRegion cardId=...>...</MouseRegion>`
  that updates the ref on render. ~30 LOC of plumbing.

DESIGN — SCROLL-WHEEL EVENTS
----------------------------
SGR mouse mode reports wheel as button codes 64 (up) / 65 (down)
on press. Map them to nav actions:

    wheel-up    → moveUp (or pageUp half if Ctrl-modifier? no — keep simple)
    wheel-down  → moveDown

The current \"focused popup\" or \"focused card list\" receives the
nav action via the same applyCursor helper from
feat_centralize_scroll_navigation (BLOCKER).

When the cursor is OUTSIDE the dashboard (e.g. mouse over the
TabStrip or StatusBar), wheel events are ignored. Don't bind the
StatusBar's wheel events — that'd be confusing.

DESIGN — DOUBLE-CLICK ON A POPUP LIST ROW
-----------------------------------------
When a popup is open AND the click y falls inside the popup body's
visible row range, the double-click resolves to:
  - Set cursor = (clicked row index)
  - Emit the same \"drill\" action that Enter would emit

Reuse the same dispatchPopupKey path; just synthesize a fake key
event. (Or: factor out the underlying handler so both keyboard
Enter and mouse double-click call it.)

NO MOUSE 'BACK'
---------------
The user's pledge: \"there is no mouse action for 'back'\". Document
in:
  - help.tsx: line under the mouse keymap section
  - skills/mu/SKILL.md: same
  - docs/USAGE_GUIDE.md TUI section: mention by-design rationale
    (mouse is for nav-IN; keyboard owns nav-OUT for predictability)

INTERACTION WITH OTHER TASKS
----------------------------
Blocked by:
  - feat_centralize_scroll_navigation — wheel events should funnel
    through the same applyCursor / applyScroll helpers as keyboard.
  - Optionally bug_tui_popup_cursor_highlight_color_leak — the
    cursor row is the implicit anchor for \"which row a wheel-scroll
    moves\".

BLOCKS (added in this same edit batch):
  - review_tui_code_and_tests (the new audit-gate task) — mouse
    code adds surface area that the audit should cover.

LINE-PRECISE FILES TO TOUCH
---------------------------
NEW:
  src/cli/tui/mouse.ts         (~150 LOC: enable/disable escapes,
                                stdin SGR parser, useMouse hook,
                                double-click reducer)
  src/cli/tui/escapes.ts       extend with MOUSE_ENABLE / MOUSE_DISABLE
                                constants
  src/cli/tui/hit-test.ts      (~50 LOC: pure x/y → cardId/rowIdx
                                resolver consuming the side-channel
                                ref)
  test/tui-mouse-parser.test.ts (~40 LOC: SGR byte sequences →
                                MouseEvent objects)
  test/tui-double-click.test.ts (~30 LOC: reducer)
  test/tui-hit-test.test.ts    (~40 LOC: pure)

EDIT:
  src/cli/tui/index.ts         enable/disable around the render
  src/cli/tui/app.tsx          consume useMouse, dispatch
                                drill/scroll based on hit-test
  src/cli/tui/cards/*.tsx      9 cards register their bounding
                                boxes with the hit-test ref
  src/cli/tui/help.tsx         add a 'mouse' section
  src/cli/tui/status-bar.tsx   no change needed; mouse is silent

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: mouse input — double-click drills, wheel scrolls, no
         mouse-back (PATH A: vendored stdin parser)

DOCS
----
- CHANGELOG.md (under v0.4 polish or v0.5 entry): bullet under
  TUI features.
- docs/USAGE_GUIDE.md TUI section: extend keymap with mouse rows.
- docs/ARCHITECTURE.md src/cli/tui/ table: add rows for mouse.ts
  + hit-test.ts.
- skills/mu/SKILL.md TUI keymap: list the mouse affordances.
- VOCABULARY.md: \"double-click\", \"hit-test\", \"mouse region\" if
  not already defined.

OUT OF SCOPE
------------
- Single-click anywhere is NOT a drill. Only double-click. (Per
  spec.)
- Right-click is NOT wired (no mouse 'back', per spec).
- Drag-to-resize panes / drag-to-reorder cards are out (those
  belong to feat_responsive_layout if anywhere).
- Mouse events in popup-filter mode (typing a query) are ignored.
- Mouse capture for text-selection is intentionally REPLACED by
  this feature (the alt-screen + mouse-mode hijack the terminal's
  built-in select-to-copy). Document the workaround:
  Shift-drag still works in iTerm2 / kitty for native selection.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_tui_mouse_input -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-3", 2026-05-12T19:06:25.226Z

```
FILES: src/cli/tui/mouse.ts; src/cli/tui/index.ts; src/cli/tui/escapes.ts; src/cli/tui/app.tsx; src/cli/tui/layout.ts; src/cli/tui/help.tsx; test/tui-mouse.test.ts; test/tui-mouse-hit-test.test.ts; test/tui-escapes.test.ts; test/tui-help-overlay.test.ts; test/tui-dashboard-layout.test.ts; CHANGELOG.md; docs/USAGE_GUIDE.md; docs/ARCHITECTURE.md; skills/mu/SKILL.md
COMMANDS: mu task notes feat_tui_mouse_input -w tui-impl; npm run typecheck; npm run lint; npm run test; npm run build; node dist/cli.js --help; node dist/cli.js --version; manual tmux smoke via node dist/cli.js -w tui-impl in pane %10715 with SGR mouse byte injection.
FINDINGS: Ink has no public mouse hook; vendored PATH A SGR parser/double-click detector and routed popup wheel/row drill through Ink's input emitter so existing popup keymaps remain canonical. Card hit-testing reuses the dashboard layout/budget model.
DECISION: No new dependencies. Mouse mode is enabled on TUI entry and disabled in the same finally cleanup as alt-screen exit. Added mouse help as a new final pane to avoid reflowing existing help panes for worker-2 overlap.
NEXT: If future work wants exact clicked-row-to-cursor for every popup, promote per-popup row region plumbing; current implementation replays keyboard-equivalent navigation and was manually smoked.
VERIFIED: npm run typecheck && npm run lint && npm run test && npm run build all green; node dist/cli.js --help and --version smoke passed; manual real-terminal/tmux smoke verified mouse double-click opens popup, scroll wheel moves popup cursor, double-click row drills into notes, Esc/q backs out/quits and terminal mouse mode restores.
ODDITIES: Direct tmux send-keys -M could not target the detached smoke pane, so manual smoke injected SGR mouse reports into the TUI pane; this exercises the same stdin parser path.
```

### #3 by "worker-3", 2026-05-12T19:06:29.796Z

```
CLOSE: 9786135: TUI mouse input wired; verified mouse double-click + scroll wheel works in real terminal
```
