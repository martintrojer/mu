---
id: "bug_tui_drill_double_hints"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.1
roi: 500.00
owner: "worker-2"
created_at: "2026-05-12T08:29:50.383Z"
updated_at: "2026-05-12T08:41:23.531Z"
blocked_by: []
blocks: []
---

# BUG: drill view shows TWO hint lines — magenta TitledBox bottomLabel (per-popup hint) AND the global StatusBar popup-drill hint underneath; one of them must go to avoid the visual collision

## Notes (3)

### #1 by "π - mu", 2026-05-12T08:30:25.044Z

```
SYMPTOM (verbatim user)
-----------------------
"double hints in drill view"

  ╰─ j/k scroll · Ctrl-D/U half page · y yanks `mu task notes` · Esc/q back to list ─────╯
                                      Recent · drill · j/k scroll · Esc back · ? help · q back

Two separate hint surfaces stacked on top of each other:
  - LINE 1: the magenta DrillScrollView bottom border carries
    `bottomLabel="j/k scroll · Ctrl-D/U half page · y yanks `mu task
    notes` · Esc/q back to list"` (added in Layer 2 of nit_tui_drill_inset_title_and_hints,
    commit f173eb7).
  - LINE 2: the global StatusBar's popup-drill hint cluster (in
    src/cli/tui/status-bar.tsx renderHints / hintsPlain) prints
    `Recent · drill · j/k scroll · Esc back · ? help · q back`.

Both surfaces fight for the same role (drill-mode key recipe). The
TitledBox bottomLabel was supposed to carry the YANK target only;
the j/k/Ctrl-D/U/Esc cluster was meant to live in the StatusBar
(per the task notes I wrote when filing nit_tui_drill_inset_title_and_hints
earlier — search for "j/k/Esc/q nav cluster lives in the global
StatusBar").

ROOT CAUSE — POPUPS PASS NAVIGATION HINTS INTO bottomLabel
----------------------------------------------------------
Worker mis-implemented Layer 2 by passing the FULL hint string
(navigation + yank) into the TitledBox bottomLabel. Examples:

  popups/recent.tsx (drill mode):
    hint="j/k scroll · Ctrl-D/U half page · y yanks `mu task notes` · Esc/q back to list"

  popups/inprogress.tsx (drill mode):
    same shape

  popups/blocked.tsx (drill mode):
    same shape

The StatusBar already shows j/k/Esc/q for popup-drill mode
(status-bar.tsx line 107). Per the original Layer-2 spec, the
bottomLabel should be the YANK RECIPE ONLY:

  hint="y yanks `mu task notes`"

…so the StatusBar shows nav and the magenta border shows the
drill-specific yank target. No duplication.

FIX
---
For every popup that drills into TaskDetailDrill (or DrillScrollView
generally), shorten the drill-mode hint string to the yank-recipe
only. Audit:

  src/cli/tui/popups/agents.tsx       drill (mu agent read scrollback)
  src/cli/tui/popups/blocked.tsx      drill (mu task notes)
  src/cli/tui/popups/doctor.tsx       drill (per-check remediation)
  src/cli/tui/popups/inprogress.tsx   drill (mu task notes)
  src/cli/tui/popups/log.tsx          drill (event payload, mu log --since N -n 1)
  src/cli/tui/popups/ready.tsx        drill (mu task notes)
  src/cli/tui/popups/recent.tsx       drill (mu task notes)
  src/cli/tui/popups/tracks.tsx       drill (mu task notes)
  src/cli/tui/popups/workspaces.tsx   commits-drill (git show <sha>) AND show-drill (git show <sha>)

For each: replace the drill-mode `hint=` value with the yank-only
short form (typically already exists in the file as a per-popup
constant — see the Layer-1 list-mode hint as the template).

VERIFY (CHEAP)
--------------
1. npm run build
2. node dist/cli.js state --tui -w tui-impl
3. Open Tasks popup (Shift+3), Enter to drill into a task with notes.
   Magenta bottom border should show only the yank recipe (e.g.
   "y yanks `mu task notes`"). The StatusBar still shows the nav
   cluster.
4. Repeat for every popup with a drill.

TESTS
-----
- Extend test/tui-popup-shells.test.ts (or test/tui-popup-*.test.ts):
  per-popup static-source assertion that the drill-mode TitledBox
  bottomLabel does NOT contain "j/k" / "Esc" / "Ctrl-D" — i.e. it's
  yank-only. Catch the next regression.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: drill-mode bottomLabel becomes yank-only (was duplicating
         nav cluster from the global StatusBar)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish): bullet under TUI bugs fixed,
  cross-ref nit_tui_drill_inset_title_and_hints (the original Layer-2
  spec was clear; consumers drifted).

OUT OF SCOPE
------------
- Don't change the StatusBar hint cluster.
- Don't change Layer 1 (popup Shell bottomLabel for list-mode is
  CORRECT — that's the only hint surface in list mode; the StatusBar
  shows yank/Enter/etc and the bottomLabel adds the per-popup yank
  recipe context. No collision in list mode.).
- Don't change the TitledBox API.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_drill_double_hints -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-2", 2026-05-12T08:41:15.866Z

```
FILES: src/cli/tui/popups/agents.tsx; src/cli/tui/popups/blocked.tsx; src/cli/tui/popups/recent.tsx; src/cli/tui/popups/tracks.tsx; src/cli/tui/popups/workspaces.tsx; test/tui-popup-shells.test.ts; CHANGELOG.md
COMMANDS: npx biome check src/cli/tui/popups test/tui-popup-shells.test.ts CHANGELOG.md (failed format only); npx biome check --write src/cli/tui/popups test/tui-popup-shells.test.ts CHANGELOG.md (exit 0); npm run typecheck (exit 0); npx vitest run test/tui-popup-shells.test.ts (exit 0); npm run lint (exit 0); npm run typecheck && npm run lint && npm run test && npm run build (exit 0)
FINDINGS: Drill-mode nav hints were still renderable in Blocked, Recent, Tracks task-list, and Workspaces show/commits drill surfaces; Agents lacked a yank recipe in scrollback drill and used loading as the only bottom label. TaskDetailDrill, Log, Doctor, Ready, In-progress already used yank-only DrillScrollView hints.
DECISION: Removed duplicate nav text from drill surfaces; kept list-mode hints unchanged. Added yank-only labels for Agents scrollback and both Workspaces drill depths, and made Workspaces commits drill use a nested magenta TitledBox/DrillScrollView bottom label instead of in-body nav text.
NEXT: None.
VERIFIED: Four greens pass in workspace: npm run typecheck && npm run lint && npm run test && npm run build. Added static source coverage to test/tui-popup-shells.test.ts to reject renderable drill hints containing j/k/Ctrl-D/Esc back.
ODDITIES: Workspaces commits drill was not using DrillScrollView for the commit list; fixed narrowly with nested TitledBox to preserve list rendering while moving its yank recipe into bottomLabel.
```

### #3 by "worker-2", 2026-05-12T08:41:23.531Z

```
CLOSE: a1df87c: drill-mode bottom labels are yank-only; four greens pass
```
