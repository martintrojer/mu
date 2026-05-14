---
id: "bug_tui_popup_data_doesnt_fill"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: null
created_at: "2026-05-11T16:38:14.419Z"
updated_at: "2026-05-11T18:29:04.865Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# BUG: popup body data is capped at hardcoded VIEWPORT=20 — rows leave a band of empty space inside the filled popup

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:39:08.983Z

```
SYMPTOM
-------
After bug_tui_popups_fill_pane (commit 71a404f) landed, every
popup's outer Shell box correctly expands to fill the pane
edge-to-edge. BUT the actual data inside (the row list, the
scrollback drill, the task notes drill) is still capped at a
fixed number of rows. So in any pane taller than ~25 lines, the
user sees:

  ╭─ Tasks · popup (3/12) ─────────────────────────────────────╮
  │ t1 OPEN  Foo                                                │
  │ t2 OPEN  Bar                                                │
  │ ...                                                         │
  │ (about 20 rows of data)                                     │
  │                                                             │
  │                                                             │
  │  ← BIG EMPTY BAND HERE INSIDE THE POPUP BORDER              │
  │                                                             │
  │                                                             │
  ╰─────────────────────────────────────────────────────────────╯

The popup is full-pane (good). The row list inside is not (bad).
Same pathology for the drill mode (mu task notes inside Tasks
popup), the agent pane scrollback (Agents popup drill), the
commits drill (Workspaces popup), and the Tracks popup (both list
and task-detail drill).

ROOT CAUSE
----------
Every popup hardcodes `const VIEWPORT = 20;` near the top:

    src/cli/tui/popups/agents.tsx:50    const VIEWPORT = 20;
    src/cli/tui/popups/log.tsx:42       const VIEWPORT = 20; // rows visible at once
    src/cli/tui/popups/ready.tsx:52     const VIEWPORT = 20;
    src/cli/tui/popups/tracks.tsx:66    const VIEWPORT = 20;
    src/cli/tui/popups/workspaces.tsx (similar)
    src/cli/tui/popups/inprogress.tsx (similar)

Every reference to `VIEWPORT` (cursor centring, scroll-clamp, slice)
uses this constant. The Shell box may be 60 rows tall but the slice
still picks 20.

src/cli/tui/popups/drill.tsx is fine: it accepts `viewport` as a
prop, passes the buck to the caller. The bug is in the callers that
all hand it the same hardcoded 20.

FIX
---
Compute the viewport at render time from `useStdout().stdout.rows`,
minus the chrome each popup actually consumes:

  - 2 rows: outer Shell rounded border (top + bottom)
  - 1 row: Shell title (e.g. "Agents · popup (3/8)")
  - 1 row: marginTop={1} between body and the popup-specific hint
  - 1 row: the popup-specific hint line
  - 1 row: <FilterPrompt> when filter is editing OR has a query
  - 1 row: StatusBar at the very bottom of the App
  - 0 rows: TitledBox in popups uses its own header inset (popups
            don't use TitledBox today; their Shell renders <Text> for
            the title — so 1 row of title text inside the border)

Pessimistic baseline: subtract ~6 rows from stdout.rows. Round down,
floor at a sensible minimum (8 rows so very-small terminals still
work).

Add a tiny pure helper in src/cli/tui/popups/drill.tsx (or a new
src/cli/tui/popups/viewport.ts):

    export const POPUP_CHROME_ROWS = 6;
    export const POPUP_VIEWPORT_FLOOR = 8;
    export function popupViewport(rows: number, chromeOverride?: number): number {
      const chrome = chromeOverride ?? POPUP_CHROME_ROWS;
      return Math.max(POPUP_VIEWPORT_FLOOR, rows - chrome);
    }

Each popup replaces:

    const VIEWPORT = 20;
    // ...later
    const visible = items.slice(start, start + VIEWPORT);

with:

    const { stdout } = useStdout();
    const viewport = popupViewport(stdout?.rows ?? 24);
    // pass viewport through to the slice / clamp helpers, OR
    // accept that VIEWPORT becomes per-render rather than module-const
    const visible = items.slice(start, start + viewport);

Per-popup chrome adjustments (pass chromeOverride):

  - Workspaces popup (drill mode): drill has TWO inner regions
    (title + dim "(L-T/T)" indicator); subtract 7.
  - Tasks popup (drill mode): inline notes view; chrome same as
    list (drill renders DrillScrollView with title + indicator).
  - Log popup: cursor-centring already uses VIEWPORT for the slice
    AND for the centring math. Both must use the new dynamic
    viewport — see "centring formula" caveat below.

CAVEAT — CENTRE-CURSOR LOG POPUP
--------------------------------
popups/log.tsx:163 centres the cursor in the viewport:

    const start = Math.max(
      0,
      Math.min(events.length - VIEWPORT, safeCursor - Math.floor(VIEWPORT / 2)),
    );

`VIEWPORT` here is BOTH the slice size AND the half-window for
centring. Replace with the per-render `viewport` consistently in
both expressions.

CAVEAT — TRACKS POPUP HAS TWO DRILL DEPTHS
------------------------------------------
popups/tracks.tsx has list, drill (task-list), and task-detail
(notes drill). Each scroll cursor and each slice uses VIEWPORT.
All three must use the dynamic viewport.

CAVEAT — DOESN'T REGRESS ALREADY-FILLING POPUPS
-----------------------------------------------
bug_tui_popups_fill_pane added flexGrow={1} to the Shell + body
wrapper. The fix here does NOT remove those — it just ensures the
data slice is large enough to actually fill the body wrapper. The
flexGrow={1} on the body wrapper still serves as the "push the
hint to the bottom" device when the row count is LESS than the
viewport (e.g. 3 IN_PROGRESS tasks in a 60-row pane: only 3 rows
render, hint sticks to the bottom).

VERIFY
------
  npm run build
  node dist/cli.js state --tui -w tui-impl

  - In a tall terminal (50+ rows):
    Shift+1 → Agents popup → list shows ALL agents, not capped.
    Shift+3 → Tasks popup → list shows MANY ready+in-progress tasks.
              Then Enter on a task → drill shows MANY notes lines
              (or ALL of them if they fit), not just 20.
    Shift+5 → Workspaces popup → all workspaces visible.
              Then Enter on one → commits drill shows MANY commits.
    Shift+4 → Log popup → many events visible; cursor still centred.

  - Resize the pane: drag from 60 rows down to 30 down to 15.
    The popup's row count should re-flow live (ink re-renders on
    resize via the existing stdout 'resize' event).

TESTS
-----
- New test/tui-popup-viewport.test.ts: pure-function tests for
  popupViewport(rows[, chromeOverride]) — boundaries (floor at 8;
  60-row pane → 54; subtract chromeOverride correctly).

- Each popup's existing test file (tui-popup-agents/log/ready/
  tracks/workspaces/inprogress) — extend with a static-source
  assertion: "popup file does NOT contain `const VIEWPORT = 20`
  hardcoded; instead reads `useStdout` and calls `popupViewport`."
  Crude regex assertion is enough; catches the regression cheaply.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: dynamic per-popup viewport (data fills the pane, not
         hardcoded 20 rows)

DOCS
----
- CHANGELOG.md (under v0.4.0): bullet under TUI bugs fixed.
- docs/ARCHITECTURE.md src/cli/tui/ table: the popups/ row should
  mention the new popups/viewport.ts (or note that drill.tsx now
  exports popupViewport).

OUT OF SCOPE
------------
- Don't change the StatusBar / Help / Card chrome heights.
- Don't add a per-popup viewport-tuning prop yet (the
  POPUP_CHROME_ROWS default + a per-call override is enough; one
  more concrete consumer should justify a richer API).
- Don't refactor the four near-duplicate popup files into a
  shared scrollable-list component yet — separate task if needed.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_popup_data_doesnt_fill -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-3", 2026-05-11T18:29:04.865Z

```
CLOSE: 1b0d855 — dynamic per-popup viewport: popupViewport(rows[,chromeOverride]) helper in src/cli/tui/popups/viewport.ts; all 6 popups read useStdout().rows; Workspaces drill chrome=7; Log popup centring uses dynamic viewport for both slice + half-window; tests + static-source regression guard; 4 greens (typecheck/lint/1622 tests/build)
```
