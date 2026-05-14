---
id: "bug_tui_popups_fill_pane"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.1
roi: 600.00
owner: null
created_at: "2026-05-11T14:52:54.752Z"
updated_at: "2026-05-11T15:40:04.835Z"
blocked_by: ["bug_tui_render_ghosting_v2"]
blocks: ["feat_popup_search_filter"]
---

# BUG: popups (esp. Shift+4 Log) don't cover the entire pane — Shell box only sizes to content

## Notes (3)

### #1 by "π - mu", 2026-05-11T14:53:31.019Z

```
SYMPTOM
-------
When the user opens a popup with Shift+1..Shift+4 (most obvious on
Shift+4 = Log popup), the popup's rounded-border box does NOT fill
the pane. It renders only as tall as its content (e.g. ~22 rows for
the Log popup's VIEWPORT=20 + title + footer), leaving a band of
blank space below it before the StatusBar.

The popup is supposed to be the "fullscreen drill-down" view per
design_popup_lifecycle and the design_card_iface contract — it
should COVER the pane edge-to-edge while it's open, the way htop's
help / lazygit's diff view / k9s's pod-detail view do.

ORDERING
--------
This task is BLOCKED BY bug_tui_render_ghosting_v2. That fix pins
the popup branch's outer <Box> to height={rows}. Once that lands,
each popup still has a SECOND inner Box (its own "Shell" component)
that defines the visible bordered surface — and that inner Shell
ALSO needs to fill the available space, otherwise it sits at its
content height inside an empty parent.

ROOT CAUSE
----------
Each popup file defines a tiny local component called Shell (or
PopupShell in popups/ready.tsx):

    function Shell({ title, children }) {
      return (
        <Box borderStyle="round" borderColor="cyan"
             paddingX={1} flexDirection="column">
          <Text bold color="cyan">{title}</Text>
          {children}
        </Box>
      );
    }

Without flexGrow={1} on this Box, ink sizes it to content. Since
the parent (App's popup branch) IS the only flex container giving
it room, the Shell sits at content height.

FIX
---
In each of the four popup files, add `flexGrow={1}` to the Shell
component's outer Box:

  src/cli/tui/popups/agents.tsx   (line ~139, function Shell)
  src/cli/tui/popups/tracks.tsx   (line ~124, function Shell)
  src/cli/tui/popups/ready.tsx    (line ~151, function PopupShell)
  src/cli/tui/popups/log.tsx      (line ~141, function Shell)

Each becomes:

    <Box borderStyle="round" borderColor="cyan" paddingX={1}
         flexDirection="column" flexGrow={1}>
      ...
    </Box>

Additionally, for popups with a "viewport + footer" layout (Log is
the obvious one — VIEWPORT=20 at the top, then a one-line "y yanks
…" hint), the body region should also flexGrow so the hint sticks
to the bottom of the popup's own Shell. The cleanest pattern:

  <Shell ...>
    <Box flexDirection="column" flexGrow={1}>
      {visible.map(...)}
    </Box>
    <Box marginTop={1}>
      <Text dimColor>y yanks ...</Text>
    </Box>
  </Shell>

That mirrors the lazygit/btop convention of "sticky bottom hint".

CAVEAT — DON'T DOUBLE-FILL
--------------------------
Per the spec note in bug_tui_render_ghosting_v2: if app.tsx's popup
branch renders a flexGrow={1} *spacer* between the popup and the
StatusBar, that spacer would steal all the room and the popup would
collapse back to content height. The right combination is:

  app.tsx popup branch:
    <Box flexDirection="column" height={rows}>
      {renderPopup(popup)}    ← will flexGrow into the available room
      <StatusBar ... />        ← natural 1-row height
    </Box>

  i.e. NO spacer Box in this branch. The popup itself owns the
  expansion. Make sure app.tsx is consistent with this pattern when
  the ghosting fix lands.

VERIFY
------
  npm run build
  node dist/cli.js state --tui -w tui-impl
  → Shift+1 → Agents popup fills the pane edge-to-edge
              (rounded border just below the top of the pane;
               StatusBar on the very bottom row).
  → Shift+4 → Log popup ditto, with the "y yanks …" hint
              sitting just above the StatusBar (NOT floating
              two rows under the events list).
  → q to close → returns to dashboard cleanly, no ghost border.

TESTS
-----
- Static-source assertion: scan each popup file for the Shell/PopupShell
  function and assert its Box props include flexGrow={1}.
  Add to test/tui-popup-shells.test.ts (NEW) — keep it cheap.

- For Log popup: assert the body region also has flexGrow={1}
  (regex match) so the hint sticks to the bottom.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file (each popup is well under).
- Conventional commit prefix: tui:
- Four greens before commit.
- One commit. Suggested message:
    tui: popups expand to fill the pane (flexGrow on Shell + Log
         body)

OUT OF SCOPE
------------
- Don't refactor the four near-duplicate Shell components into a
  shared one yet. They diverge a tiny bit (PopupShell vs Shell,
  ready.tsx already has slight differences). A shared
  src/cli/tui/popup-shell.tsx is a follow-up FEAT; separate task.
- Don't add scrollback / viewport sizing logic; VIEWPORT=20 stays
  for now. A "viewport-grows-with-pane" feature is a follow-up.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_popups_fill_pane -w tui-impl --evidence "<sha + summary>"
```

### #2 by "π - mu", 2026-05-11T14:54:10.664Z

```
ADDENDUM — POPUPS MUST ALSO FILL HORIZONTAL WIDTH
-------------------------------------------------
Re-reading the symptom against all 4 popup files: each popup's Shell
component is a plain rounded Box with NO explicit width and NO
flexGrow on the WIDTH axis. It auto-sizes to its widest content,
so popups appear as a narrow strip in the middle/left of the pane,
not edge-to-edge.

The Cards already span full pane width because src/cli/tui/titled-box.tsx
explicitly sets `width={cols}` from `useStdout().columns`. Popups need
the equivalent.

EXPANDED FIX
------------
Each popup's Shell box (popups/agents.tsx, tracks.tsx, ready.tsx,
log.tsx) needs BOTH dimensions filled:

    <Box borderStyle="round" borderColor="cyan" paddingX={1}
         flexDirection="column" flexGrow={1} width={cols}>
      ...
    </Box>

where `cols = useStdout().stdout?.columns ?? 80` (mirror what
titled-box.tsx already does).

Why width={cols} not flexGrow on width axis: ink's Yoga layout
defaults to the parent's container width when the parent has a
defined width, but App.tsx's outer Box only sets height={rows}
(after bug_tui_render_ghosting_v2 lands). Without width={cols},
Yoga sizes Shell to content. width={cols} is the simplest fix
that mirrors TitledBox.

ALTERNATIVE (cleaner long-term)
-------------------------------
Convert each popup's Shell to use TitledBox itself. TitledBox already
pins width AND renders the section header inset in the top border —
that would give popups the same btop-style header treatment as cards
and reduce ~4×10 LOC of duplicated Shell components to one prop change
each. If you go this route in this same task, ALSO drop the `<Text
bold color="cyan">{title}</Text>` line from each popup's Shell body
(TitledBox renders it). Use cardId={undefined} for popups (they're
not toggled by digit).

If that refactor feels too large for this bug task, just add the
width={cols} + flexGrow={1} props inline and file a follow-up FEAT
"unify popup Shell with TitledBox" as a separate task.

CARDS — VERIFY NOT REGRESSED
----------------------------
Per the user's framing ("on all relevant cards (where we have rows
to fill the page)"), audit each card to confirm horizontal coverage
is OK:
  - cards/agents.tsx, tracks.tsx, ready.tsx, log.tsx all use TitledBox
    which sets width={cols}. ✓ already full-width.

A future "responsive multi-column" layout (feat_responsive_layout in
the backlog) will introduce horizontal card splits at wide
terminals; that's where you'd swap width={cols} for a parent-driven
layout. Out of scope for this bug.

VERIFY (extended)
-----------------
  npm run build
  node dist/cli.js state --tui -w tui-impl
  → Shift+1 / Shift+2 / Shift+3 / Shift+4 each render the popup
    edge-to-edge (border touches both pane sides AND extends to
    ~one row above the StatusBar).
  → Resize terminal narrower / wider; popup re-flows correctly.
  → q to close → dashboard restored, no ghost columns/rows.

TESTS (extended)
----------------
- The static-source assertion test should also assert each popup
  Shell sets width to a cols-derived expression (regex match for
  `width={cols}` or `width={stdout.columns` etc.).
```

### #3 by "worker-2", 2026-05-11T15:40:04.835Z

```
CLOSE: 5cb6ca8 tui: popups expand to fill the pane — flexGrow={1} + width={cols} on Shell/PopupShell in agents/log/ready/tracks popups + flexGrow body wrapper for sticky bottom hint; no app.tsx changes needed (existing height={rows}+no-spacer contract holds); new tui-popup-shells.test.ts asserts via static-source scan; 4 greens (tsc + biome + 1449 tests + tsup)
```
