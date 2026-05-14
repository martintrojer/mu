---
id: "nit_tui_drill_inset_title_and_hints"
workstream: "tui-impl"
status: CLOSED
impact: 35
effort_days: 0.2
roi: 175.00
owner: null
created_at: "2026-05-12T05:20:11.589Z"
updated_at: "2026-05-12T06:29:30.340Z"
blocked_by: ["bug_tui_popup_cursor_highlight_color_leak", "feat_centralize_scroll_navigation"]
blocks: ["review_tui_code_and_tests"]
---

# NIT: drill views render their title + key-hints as body rows; should inset into the top/bottom borders (consistent with cards via TitledBox)

## Notes (3)

### #1 by "π - mu", 2026-05-12T05:21:12.952Z

```
SYMPTOM (verbatim user repro)
-----------------------------
User opens the Tasks popup (Shift+3), focuses a task, presses
Enter to drill into TaskDetailDrill (the read-only notes view).
Result:

  ╭──────────────────────────────────────────────────────...─╮
  │ Tasks · bug_tui_tab_switch_stale_render (notes)          │   ← popup-level title (body row)
  │ ── 2026-05-12 05:14:53  π - mu ──h_stale_render (1-72/311) │   ← DrillScrollView title (body row)
  │ SYMPTOM   and                                            │   ← actual notes body
  │ j/k scroll · Ctrl-D/U half page · y yanks ... · Esc/q ...│   ← DrillScrollView hint (body row)
  ╰────────────────────────────────────────────────────...─╯

User's complaint: \"the header line of this data should be on the
top card-line and the keybinding hints should be on the bottom
line. its inconsistent now\".

DIAGNOSIS
---------
The drill view's chrome (title row + hint row) is rendered as
ordinary body text inside the popup Shell's rounded box. Compare
with the dashboard cards, which use TitledBox with the title INSET
into the top border and (via feat_card_footer_inset) the
\"+M more · Shift+N\" hint INSET into the bottom border.

The drill view should follow the same pattern: its own title goes
into the top border line, its key-hint cluster goes into the bottom
border line. That gets back the two consumed body rows AND makes
the visual language consistent with the cards.

ROOT CAUSE
----------
1. The popup's outer Shell renders its title as a body row
   (popups/{ready,agents,...}.tsx Shell function — see
   `<Text bold color=\"cyan\">{title}</Text>` lines).
2. The drill view (popups/drill.tsx DrillScrollView) renders ITS
   own title row + position indicator inside the body Box (\"▸
   title (1-72/311)\").
3. The popup-specific hint row (\"y yanks…\") is also a body Box
   appended below the rows.

Three different chrome surfaces, all rendered as body content.

FIX
---
Two layers, each shippable independently:

LAYER 1 — POPUP SHELLS USE TitledBox.

Refactor each popup file's local Shell function to use TitledBox
instead of a hand-rolled `<Box borderStyle=\"round\">`:

    function Shell({ title, children }) {
      return (
        <TitledBox title={title} borderColor=\"cyan\" titleColor=\"cyan\"
                   /* no cardId — popups aren't toggled by digit */>
          {children}
        </TitledBox>
      );
    }

…and DELETE the in-body `<Text bold color=\"cyan\">{title}</Text>`
line that was previously rendered as a body row.

That alone moves the popup-level title (\"Tasks · popup (i/N)\" or
\"Tasks · bug_…  (notes)\") into the top border, identical to how
the cards render.

Per-popup files:
  popups/agents.tsx
  popups/blocked.tsx
  popups/doctor.tsx
  popups/inprogress.tsx
  popups/log.tsx
  popups/ready.tsx
  popups/recent.tsx
  popups/tracks.tsx
  popups/workspaces.tsx

Caveat: each Shell in those files might still need flexGrow={1}
on its Box (per bug_tui_popups_fill_pane). TitledBox already
manages width={cols}; verify it also flexes vertically. If not,
add a flexGrow={1} prop to TitledBox (small extension, document
in titled-box.tsx).

LAYER 2 — DrillScrollView CHROME INSETS INTO BORDERS.

DrillScrollView (src/cli/tui/popups/drill.tsx) currently renders:

    <Box flexDirection=\"column\">
      <Box>
        <Text bold color=\"magenta\">▸ {title}</Text>
        <Text dimColor> ({positionLabel})</Text>
      </Box>
      {hint !== undefined ? <Text dimColor>{hint}</Text> : null}
      ...visible lines...
    </Box>

Change to use TitledBox with `bottomLabel`:

    <TitledBox title={title}
               subtitle={positionLabel}
               borderColor=\"magenta\"
               titleColor=\"magenta\"
               bottomLabel={hint}>
      {visible.map(...)}
    </TitledBox>

(borderColor=magenta keeps the existing visual: drill-view chrome
is magenta to distinguish it from the popup's cyan chrome.)

The popup that hosts the drill (popups/ready.tsx and the other
list popups in their drill branch) currently passes a `hint`
prop that includes both the per-popup yank info AND the j/k/Esc
nav strings. Two cleanups available:

  (a) The j/k/Esc/q nav cluster is already in the global
      StatusBar's popup-mode hint (per feat_status_bar). Drop
      those from the drill's bottomLabel; only keep the
      DRILL-SPECIFIC hint (e.g. \"y yanks `mu task notes <id>`\"
      for the Tasks-drill). The status bar carries the rest.

  (b) Or: keep them, but render the bottom-label as a single
      compact line. TitledBox truncates if needed.

Pick (a) — fewer pixels duplicated, status bar stays the
single-source-of-truth for nav keys.

INTERACTION WITH bug_tui_popup_data_doesnt_fill
-----------------------------------------------
The popupViewport helper subtracts a 6-row chrome budget from
stdout.rows. After this nit:

  - Popup Shell border: 2 rows (top + bottom).
  - Popup title: 0 rows (now inset into top border).
  - Drill title: 0 rows (now inset into top border of nested TitledBox).
  - Drill hint: 0 rows (now inset into bottom border).
  - Body margin: 0 rows.

Total chrome drops from 6 to ~4. Update POPUP_CHROME_ROWS
accordingly in src/cli/tui/popups/viewport.ts (or whatever the
current constant is). The drill body gets 2 extra visible rows
\"for free\" — measurable win on tall panes.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file. TitledBox grows by ~10 LOC if
  flexGrow needs adding; popups shrink by ~3 LOC each.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested 2 commits:
    Commit 1: tui: popups use TitledBox for the Shell (title inset
              into top border)
    Commit 2: tui: DrillScrollView chrome insets into top + bottom
              borders (consistent with cards)

DOCS
----
- CHANGELOG.md (under v0.4.0, or v0.4.1 if 0.4 ships first):
  bullet under TUI polish.
- docs/ARCHITECTURE.md src/cli/tui/popups/drill.tsx description:
  mention the TitledBox-based chrome.

VERIFY
------
1. npm run build
2. node dist/cli.js state --tui -w tui-impl
3. Open Tasks popup (Shift+3). Title \"Tasks · popup (i/N)\" should
   be inside the rounded top border.
4. Press Enter on a task row → drill into notes. Title
   \"Tasks · <id> (notes) (1-72/311)\" should be inside the
   rounded top border. Hint (\"y yanks `mu task notes <id>`\")
   inside the rounded bottom border.
5. Repeat for popups/agents drill (scrollback) and popups/tracks
   drill (task list). Same pattern.
6. Status bar at the very bottom of the screen still shows the
   global popup-mode hint cluster (j/k nav · / filter · Enter
   drill · Esc close · ? help · q quit). No duplication with the
   per-popup bottom-inset hint.

OUT OF SCOPE
------------
- Don't redesign the colour palette (keep cyan for popup chrome,
  magenta for drill chrome — they distinguish nesting depth).
- Don't merge popup Shell + DrillScrollView into one component;
  they're conceptually different (one wraps a list, one wraps
  pre-formatted text).
- Don't extend TitledBox to support per-cell rendering inside
  the title; the existing title/subtitle/cardId props are enough.

⚠️ FINAL ACTION ⚠️
After committing both layers, run from the workspace dir:
    mu task close nit_tui_drill_inset_title_and_hints -w tui-impl --evidence \"<sha1> + <sha2>\"
```

### #2 by "π - mu", 2026-05-12T05:22:10.120Z

```
ADDENDUM (2026-05-12) — APPLIES TO BOTH SURFACES, NOT JUST DRILL
----------------------------------------------------------------
User confirms: \"that same for the Shift+N drill down cards (i.e.
first level drill down). header and hints are inside the card.\"

The same diagnosis covers TWO nested chrome surfaces, both
currently rendered as body rows:

  SURFACE A — POPUP SHELL (the Shift+N first-level drill-down)
    e.g. Shift+3 → Tasks popup. Today the popup's Shell box
    renders its title (\"Tasks · popup (3/12)\") as the FIRST
    body row inside the cyan rounded box. Below the rows, a
    per-popup hint row (\"y yanks `mu task claim <id>`\" for
    Tasks popup, \"f free · x close · y yanks `mu agent send`\"
    for Agents popup, etc.) renders as another body row. Two
    rows of chrome rendered as content inside the visible
    border.

  SURFACE B — DrillScrollView (the Enter-into-row second-level
    drill, e.g. notes timeline inside the Tasks popup). Title +
    position + hint all body rows, as already specced above.

The original spec only called out Surface B (\"the drill view's
chrome\"). The fix needs to apply BOTH surfaces independently —
so the LAYER 1 (popup Shells use TitledBox) part of the fix is
load-bearing for the Shift+N case, not just the second-level
drill case.

VERBATIM USER PSEUDOCODE FOR SURFACE A
--------------------------------------
What the user expects to see (Shift+3 popup, no drill):

    ╭─ Tasks · popup (3/12) ─────────────────────────────────╮
    │ <task-id>  STATUS  ROI  title                          │
    │ ...                                                    │
    ╰── y yanks `mu task claim <id>` ───────────────────────╯

…with the title inset into the top border (just like cards) and
the per-popup hint inset into the bottom border (just like the
\"+M more · Shift+N\" hint on cards via feat_card_footer_inset).

The status bar at the SCREEN bottom still carries the global popup
nav cluster (j/k · / filter · Enter drill · Esc close · ? help ·
q quit) — that's the screen-level chrome and stays separate.

LAYER 1 IS ENOUGH FOR SURFACE A
-------------------------------
The original \"LAYER 1 — POPUP SHELLS USE TitledBox\" already
covers Surface A end-to-end:

  function Shell({ title, hint, children }) {
    return (
      <TitledBox title={title}
                 borderColor=\"cyan\"
                 titleColor=\"cyan\"
                 bottomLabel={hint}>
        {children}
      </TitledBox>
    );
  }

…with the per-popup hint passed in as `hint` prop. Each popup
file replaces its current hand-rolled bottom-row JSX (\"y yanks
…\") with passing the same string as `hint=` to its Shell.

LAYER 2 (DrillScrollView) THEN COMPOSES NATURALLY
-------------------------------------------------
With Layer 1 done, the DrillScrollView (Surface B) renders as a
TitledBox-wrapped child of the popup's TitledBox. The two nested
border colors (cyan outer, magenta inner) preserve the
distinguish-by-depth visual.

UPDATED IMPLEMENTATION ORDER
----------------------------
1. EXTEND TitledBox if needed: optional `bottomLabel` prop is
   already there from feat_card_footer_inset (commit 1f25a25);
   verify it works with cyan + dim styling. If a popup needs a
   different visual treatment for the bottomLabel (e.g. yellow
   key glyphs), add a `bottomLabelStyle` prop or render the
   label via a JSX node instead of a string. Defer to whatever
   the popup actually needs.

2. SHIP LAYER 1 (popup Shells use TitledBox with bottomLabel for
   the per-popup hint). All 9 popup files. One commit.

3. SHIP LAYER 2 (DrillScrollView uses TitledBox). drill.tsx +
   verify via Tasks popup → drill, Agents popup → scrollback drill,
   Tracks popup → drill, Workspaces popup → commits drill, Doctor
   popup → check-detail drill. One commit.

4. UPDATE POPUP_CHROME_ROWS in popups/viewport.ts: drops from 6
   to ~3 (border 2 + minimal margin). Drill body gets ~3 extra
   visible rows.

PER-POPUP HINT TEXT (SO THE LAYER-1 EDIT IS LINE-PRECISE)
---------------------------------------------------------
Quick audit so the implementer doesn't have to re-derive each:

  popups/agents.tsx:    \"f free · x close · y yanks `mu agent send`\"
  popups/blocked.tsx:   \"y yanks `mu task tree <id>`\"
  popups/doctor.tsx:    (depends on the slot-9 popup's yank target;
                         check current source)
  popups/inprogress.tsx:\"y yanks `mu task close <id> --evidence ...`\"
  popups/log.tsx:       \"y yanks the related `mu task/agent show` command\"
  popups/ready.tsx:     yank-matrix branches (OPEN/IN_PROGRESS/CLOSED)
                        — render the matrix-resolved string per row's
                        state in bottomLabel
  popups/recent.tsx:    \"y yanks `mu task open <id>`\"
  popups/tracks.tsx:    \"y yanks `mu task tree <head-id>`\"
  popups/workspaces.tsx:\"y yanks `cd $(mu workspace path <agent>)`\"

Each popup's hint is short (≤60 cols typical) — well within
TitledBox.bottomLabel's natural width. ready.tsx's branching
yank-matrix is the gnarliest case; its bottomLabel might need to
update per-cursor-row, which is fine since TitledBox re-renders
on prop change.

VERIFY (extended)
-----------------
After Layer 1:
  - Open every popup (Shift+1..Shift+9). Title in top border;
    per-popup hint in bottom border. No body-row chrome.
  - Resize the pane narrower; bottomLabel truncates per
    feat_card_footer_inset's ellipsis path.

After Layer 2:
  - Drill into Tasks popup. Inner TitledBox has magenta chrome
    nested inside cyan; both borders distinct, no doubled lines.

NO OTHER CHANGES TO THIS TASK'S SCOPE
------------------------------------
Everything else in the original spec stays: same constraints,
same docs, same tests, same final-action block. The implementer
should treat the title as covering BOTH surfaces.
```

### #3 by "worker-3", 2026-05-12T06:29:30.340Z

```
CLOSE: be0dc7d+d7ed60b: Layer 1 makes every popup Shell delegate to TitledBox so the popup-level title insets into the top border and the per-popup hint insets into the bottom border (POPUP_CHROME_ROWS drops 6→3); Layer 2 makes DrillScrollView wrap its body in a nested magenta TitledBox so the drill title+position inset into the top border and the drill-specific yank-hint insets into the bottom border. typecheck+lint+1812 tests+build all green for both commits.
```
