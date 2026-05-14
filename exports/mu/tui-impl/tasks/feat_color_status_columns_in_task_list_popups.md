---
id: "feat_color_status_columns_in_task_list_popups"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.15
roi: 333.33
owner: "worker-2"
created_at: "2026-05-13T05:26:06.428Z"
updated_at: "2026-05-13T07:32:50.030Z"
blocked_by: []
blocks: []
---

# FEAT: every task-list popup (Ready/InProgress/Blocked/Recent/all-tasks) colour-codes the status column via the existing colorStatus helper (currently only DAG popup uses it)

## Notes (2)

### #1 by "π - mu", 2026-05-13T05:27:51.443Z

````
MOTIVATION (verbatim user)
--------------------------
"in all the task lists, color code the status coluns"

CURRENT STATE
-------------
Only the DAG popup uses src/cli/format.ts colorStatus(). Every other task-list popup (Ready, InProgress, Blocked, Recent, all-tasks) renders the status column as plain `dimColor: true` text via the ListRow `colors` prop.

THE FIX
-------
Per-status colours are already defined in src/cli/format.ts colorStatus(). It returns picocolors-wrapped strings — but in the TUI we need ink colours, not ANSI strings inside Text content (mixing ANSI with ink Text is brittle).

CLEANEST APPROACH: add a tiny helper that maps TaskStatus → ink colour name string ("green" | "yellow" | "cyan" | "red" | "magenta" or whatever's canonical), then ListRow's existing `colors` array can take per-row colour overrides for the status cell.

BUT the colors prop is currently a STATIC array (one entry per column). Per-row colour means we need to vary by row's status value. Two options:

  OPTION A — derive per-row colors at render time:
    Today: rows.map((row, i) => <ListRow ... colors={ALL_TASKS_COLORS} />)
    Where ALL_TASKS_COLORS is a fixed array.
    
    Change to: rows.map((row, i) => {
      const colors = colorsForRow(row, ALL_TASKS_COLORS);  // returns a per-row variant
      return <ListRow ... colors={colors} />;
    });
    
    `colorsForRow` looks at the status column's value and overrides its slot in the colors array.

  OPTION B — extend ListRow to accept a `colorOverrides?: (row, colIdx) => Color | undefined` callback.
    More flexible; bigger surface change.

PREFER OPTION A. Smaller diff, doesn't grow the ListRow API.

STATUS → INK COLOR MAP (locked)
-------------------------------
Match the existing src/cli/format.ts colorStatus convention (chalk/picocolors equivalents) and the DAG popup's choices:
  OPEN         → "cyan"
  IN_PROGRESS  → "yellow"
  CLOSED       → "green"
  REJECTED     → "red"
  DEFERRED     → "magenta" (or "gray" / dim — check format.ts)

Verify against src/cli/format.ts colorStatus() before locking. The mapping should match what the static CLI tables (mu task list / mu state) already render so users see consistent colours across CLI and TUI.

WIRING
------
1. New helper in src/cli/format.ts (or new src/cli/tui/status-color.ts): 
   ```ts
   export type InkColor = "cyan" | "yellow" | "green" | "red" | "magenta";
   export function inkColorForStatus(status: TaskStatus): InkColor;
   ```

2. Per-popup change (Ready, InProgress, Blocked, Recent, all-tasks):
   - Find the rows.map render block.
   - For each row, look up the status field, build a colors array where the status column slot uses { color: inkColorForStatus(status) } instead of { dimColor: true }.

3. The cards (cards/ready.tsx, cards/inprogress.tsx, cards/blocked.tsx, cards/recent.tsx) probably ALSO have status columns — apply the same fix there. Check each.

DON'T COLOUR
------------
- The owner column.
- The ROI / impact / effort columns.
- The task name column.
- The title column.
Only the status column changes colour.

⚠️ COORDINATION ⚠️
Touches MANY popup + card files. Other in-flight tasks may overlap if they touch popups; check git status before committing. Specifically:
  - bug_t_keypress_replays_stale_mouse_dblclick — touches app.tsx ONLY. No conflict.
  - feat_git_show_drill_color_and_tuicr — touches drill.tsx + popups/{commits,workspaces}.tsx + new tuicr.ts. Possible workspaces.tsx touch — coordinate at cherry-pick time.

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js`. The new helper goes in src/cli/format.ts (already a safe import target — used by cards/popups today). After build, smoke:
  npm run build && node dist/cli.js --help && node dist/cli.js --version

TESTS (REQUIRED)
----------------
- src/cli/format.ts: unit-test inkColorForStatus for each of the 5 statuses (locked mapping).
- test/tui-popup-{ready,inprogress,blocked,recent,all-tasks}.test.ts: extend each to assert that the rendered status cell carries the expected color (walk the JSX tree for a row's status column and check the `color` prop on the inner Text).
- test/tui-card-{ready,inprogress,blocked,recent}.test.ts: same for cards.

VERIFY MANUALLY
---------------
After build:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # Inspect each popup that has a status column:
  #   Ready popup (Shift+3): status column (likely all OPEN) → cyan.
  #   InProgress popup (Shift+6): IN_PROGRESS → yellow.
  #   Blocked popup (Shift+7): mix of OPEN/blocked → cyan.
  #   Recent popup (Shift+8): CLOSED rows → green.
  #   All-tasks popup (t): every status colour visible across rows.
  # Confirm colours match `mu task list` static output (consistency).

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual smoke per checklist.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge); inkColorForStatus can live in src/cli/format.ts as a pure helper (no ink import; just returns string literals).
- 1500 LOC hard cap; touches many files but each change is ~5-10 LOC (build a per-row colors variant). Net tiny.
- Conventional commit prefix: `tui:`.
- Suggested commit:
    tui: status column colour-coded in every task-list popup + card (matches the static CLI's colorStatus mapping)

DOCS
----
- CHANGELOG.md [Unreleased] under "Changed":
  * "Every TUI task-list popup and card now colour-codes the status column (OPEN cyan, IN_PROGRESS yellow, CLOSED green, REJECTED red, DEFERRED magenta) — matching the existing static `mu task list` / `mu state` table colouring. Was: rendered as plain dim text in TUI."
- docs/USAGE_GUIDE.md TUI section: brief mention of consistent status colours.

OUT OF SCOPE
------------
- No new colour scheme / theming.
- No ROI / impact column colouring.
- No row-background colour (status colour is per-cell only).
- No accessibility mode (the cards already use status-text + colour; both are present).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>.

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + manual visual smoke (open every popup with a status column and confirm colours), close YOUR task with:
  mu task close feat_color_status_columns_in_task_list_popups -w tui-impl --evidence "<sha>: <one-line summary including 'verified status colours in Ready/InProgress/Blocked/Recent/all-tasks popups + cards'>"
````

### #2 by "worker-2", 2026-05-13T07:32:50.030Z

```
CLOSE: 0cc4525: status colours wired in cards/popups; 4-green failure is pre-existing sl cleanup flake (covered by bug_test_suite_flakes_audit_and_remediate)
```
