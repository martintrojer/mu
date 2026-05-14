---
id: "nit_tui_status_bar_popup_shift_range"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-11T16:45:11.746Z"
updated_at: "2026-05-11T19:00:02.888Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# NIT: status bar popup-mode hint should mention 'Shift+1-9' (cross-popup hop hint), not just popup-only verbs

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:45:48.257Z

```
GOAL
----
While a popup is open, the status-bar 'popup' mode hint cluster
lists popup-only verbs (j/k, /, Enter, y, Esc, ?, q) but NEVER
tells the user that Shift+1..Shift+9 SWITCHES to a different popup
without going back to the dashboard first. Surface that affordance
in the hint.

WHY
---
btop / k9s / lazygit all let you hop directly between fullscreen
views with the digit shortcuts. mu does too — `dispatchGlobalKey`
keeps the popup-opener glyphs (! @ # $ % ^) live even while a popup
is open (verified by the existing test that those glyphs map to
openPopup actions even from within a popup), but the user has no
way to discover that without reading the help overlay.

LINE-PRECISE EDIT
-----------------
src/cli/tui/status-bar.tsx — both popup-mode branches:

(1) The "popup · list" branch (~line 138, the bottom return inside
    case "popup"):

    BEFORE:
      <Key>j/k</Key> <Text dimColor>nav ·</Text> <Key>/</Key> <Text dimColor>filter ·</Text>
      <Key>Enter</Key> <Text dimColor>drill ·</Text> <Key>y</Key> <Text dimColor>yank ·</Text>
      <Key>Esc</Key> <Text dimColor>close ·</Text> <Key>?</Key> <Text dimColor>help ·</Text>
      <Key>q</Key> <Text dimColor>quit</Text>

    AFTER (add `Shift+1-9 · switch popup` somewhere prominent — most
    operators glance at the LEFT of the cluster, so put it second
    after j/k):

      <Key>j/k</Key> <Text dimColor>nav ·</Text>
      <Key>Shift+1-9</Key> <Text dimColor>switch popup ·</Text>
      <Key>/</Key> <Text dimColor>filter ·</Text>
      <Key>Enter</Key> <Text dimColor>drill ·</Text>
      <Key>y</Key> <Text dimColor>yank ·</Text>
      <Key>Esc</Key> <Text dimColor>close ·</Text>
      <Key>?</Key> <Text dimColor>help ·</Text>
      <Key>q</Key> <Text dimColor>quit</Text>

(2) The "popup · drill" branch (~line 127):

    The drill branch does NOT need the hop hint — drill is a
    transient view that returns to the popup-list on Esc; switching
    popups from drill mode is unusual. Leave it alone, OR if you
    add it for symmetry, position it AFTER `Esc back`. Pick whichever
    feels less cluttered. Document the choice in the commit.

NARROW-COL POLICY
-----------------
The popup hint cluster is already the second-busiest cluster in the
status bar after the dashboard one. Adding `Shift+1-9 · switch popup`
costs ~22 cols. If the existing LEFT-zone-drop policy still leaves
this hint legible at cols=80 (typical narrow pane), ship it as-is.
If not, drop the explanatory `· switch popup` words and keep just
`Shift+1-9` (since the user is in a popup, the meaning is implied).

PARALLEL — POPUP-FILTER MODE
----------------------------
case "popup-filter" (~line 148): hint shows filter-edit verbs (Esc
cancel, Enter commit, Bksp edit). Do NOT add the Shift+1-9 hint
here — while typing a filter query, the digit glyphs ARE part of
the query (printable chars), not popup-switch shortcuts. The
existing usePopupFilter reducer correctly appends them. Leaving
the hint cluster minimal here keeps the user focused on the
filter-editing affordances.

DOCS
----
- skills/mu/SKILL.md TUI keymap: confirm Shift+1-9 cross-popup hop
  is documented; if not, add a line.
- CHANGELOG.md (under v0.4.0): bullet under TUI nits/polish.

TESTS
-----
- test/tui-status-bar.test.ts: extend the popup-mode hint case to
  assert the cluster now contains 'Shift+1-9' (or 'Shift+1' literal).

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: status-bar popup hint surfaces Shift+1-9 cross-popup hop

OUT OF SCOPE
------------
- Don't add a Shift+1-9 mnemonic to the help overlay if it's
  already there. Audit first.
- Don't change the dashboard hint — sibling task
  nit_tui_status_bar_card_range covers the '1-9' range there.
- Don't change the popup-filter mode hint.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close nit_tui_status_bar_popup_shift_range -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-3", 2026-05-11T19:00:02.888Z

```
CLOSE: d163e9d — popup-list hint now surfaces 'Shift 1-9 switch popup' (drill + filter modes deliberately untouched per spec)
```
