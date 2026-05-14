---
id: "feat_dag_popup_status_filters"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: "worker-3"
created_at: "2026-05-12T15:55:09.597Z"
updated_at: "2026-05-12T17:58:16.350Z"
blocked_by: ["fix_card_slot_layout_recents_commits_split"]
blocks: []
---

# FEAT: DAG popup per-status toggle key bindings (compose the visible set: OPEN/IN_PROGRESS/CLOSED/REJECTED/DEFERRED)

## Notes (3)

### #1 by "π - mu", 2026-05-12T15:56:07.501Z

```
MOTIVATION (verbatim user)
--------------------------
"feat.. the dag view needs to key binds to toggle/filter the different task states. like show only open etc"
"on toggle per state so the user can get the exact view they want"

ARCHITECTURAL FRAMING
---------------------
The DAG popup (g shortcut, src/cli/tui/popups/dag.tsx, landed in commit 0da2cfc) renders ALL tasks in the workstream as an ASCII forest. On a workstream with 100+ tasks (tui-impl has ~110 right now), it's overwhelming when the user only cares about a slice.

Per-status toggles let the user compose the visible set INDEPENDENTLY — show only OPEN, or show OPEN+IN_PROGRESS, or hide CLOSED + REJECTED + DEFERRED, etc. Five toggles, one per status. Default = ALL ON (current behaviour preserved).

DESIGN DECISIONS (locked from the user feedback)
------------------------------------------------
1. **Per-status toggles**, not preset modes (no "show open only" radio button).
2. Each toggle is INDEPENDENT — user composes any combination.
3. Default ALL ON (today's behaviour).
4. Visual indicator shown SOMEWHERE in the popup: which statuses are currently visible.

KEY BINDING DESIGN
------------------
5 statuses → 5 keys. Mnemonic-first. Conflict-check against existing DAG-popup keymap (q/Esc, j/k, g/G, Ctrl-D/U, /, n/N, y, Enter — defined in src/cli/tui/keys.ts dispatchPopupKey).

PROPOSED MNEMONICS (one letter per status):
  o → toggle OPEN
  i → toggle IN_PROGRESS
  c → toggle CLOSED
  r → toggle REJECTED
  d → toggle DEFERRED

CONFLICTS to verify:
  - 'r' in popup keymap: today UNUSED (refresh is dashboard-only). ✓
  - 'd' is NOT used in popup; Ctrl-D is page-down. Plain 'd' = free. ✓
  - 'o' / 'i' / 'c' all free in popup. ✓
  - These bindings should ONLY fire in the DAG popup, not other popups (other popups don't have a status concept). Wire as a popup-LOCAL keymap — see PopupShell / dispatchPopupKey for the mechanism, OR handle inline in dag.tsx like usePopupFilter does.

Alternative if 5 mnemonics feels noisy: one cycle key (e.g. 's' = cycle through status-filter PRESETS: all → open-only → ip-only → closed → all). REJECTED — user explicitly asked for per-state toggles to compose the exact view.

VISIBLE INDICATOR
-----------------
Show a small filter strip at the top of the DAG popup body (above the forest) OR in the popup title ("DAG · tui-impl · OPEN+IP" / "DAG · tui-impl · all"). The strip should show every status with its toggle state (e.g. " O[●] I[●] C[ ] R[ ] D[ ] "), letter-coded so the keybinding is discoverable.

Recommend: filter strip just below the popup title, above the forest body. Format suggestion (use the same colorStatus colours as the body):
   filters: [O]pen ●  [I]n_progress ●  [C]losed ○  [R]ejected ○  [D]eferred ○

DATA / RENDER
-------------
Two implementation paths:
  PATH A (filter the data): pass a Set<TaskStatus> into renderForest; skip tasks whose status isn't in the set when computing roots + children. Cleaner but the "roots" concept changes if you hide a parent (its dependents become orphans).
  PATH B (filter the rendered lines): renderForest emits a line per task; filter the lines after the fact based on the rendered task's status. Preserves the tree shape (a hidden parent renders as "(hidden CLOSED — N descendants)").

PATH B is preferred: keeps tree connectivity legible, doesn't surprise the user with orphans appearing/disappearing as they toggle.

But PATH B requires renderForest to either tag each line with the source task's status (so the filter can decide), or expose a per-task callback that returns a render hint (visible / collapse / show-as-stub).

SIMPLEST PATH C (recommended): filter at the loadFullDag layer.
  - Add an optional `statuses?: Set<TaskStatus>` param to loadFullDag (default = all).
  - When set, drop tasks NOT in the set from `tasks` map AND from `edges`.
  - When a node's parent is dropped, its dependents stay rooted (they ascend to roots since incoming edges to dropped parents are gone).
  - Document that this changes the tree shape — that's the user's intent (they explicitly asked for filtering).

PATH C is cleanest, smallest LOC, and the "tree-shape changes" is what the user wants ("the exact view").

STATE MANAGEMENT
----------------
- DagPopup component stores the filter set in useState<Set<TaskStatus>>(new Set(TASK_STATUSES)). Default: every status visible.
- Toggles flip membership; useMemo on dag rebuilds when set changes.
- No persistence (per anti-feature pledges — no config). Reopening the popup resets to all-on. Acceptable; the popup is a quick-glance affordance.

YANK MATRIX (no change)
-----------------------
'y' continues to yank `mu task tree <focused-id>` for the cursor row. The focused task is whatever the cursor is on AFTER filtering — so filtering changes which task 'y' refers to. That's fine.

TESTS
-----
- src/dag.ts: extend loadFullDag tests with a fixture that exercises the statuses filter.
  * 5 tasks, one per status; filter to {OPEN} → only OPEN task in result.
  * Hidden-parent case: A blocks B (A=CLOSED, B=OPEN). filter={OPEN} → B becomes a root.
- test/tui-popup-dag.test.ts: add tests for:
  * Initial state = all toggles ON (existing behaviour preserved).
  * Pressing 'o' toggles OPEN visibility (uses the existing walk()/keymap pattern).
  * Pressing 'c' hides CLOSED tasks from the rendered body.
  * The visible filter strip reflects toggle state (assert text via walk()).
- test/tui-keys.test.ts: assert 'o'/'i'/'c'/'r'/'d' inside the DAG popup map to the new toggle action (and DON'T fire in other popups).

WIRING
------
- src/cli/tui/popups/dag.tsx: add filter-set state + the toggle handler + the strip render. Pass filter set into loadFullDag.
- src/dag.ts: add optional statuses param to loadFullDag; filter tasks + edges accordingly.
- src/cli/tui/keys.ts: extend dispatchPopupKey (or add a dispatchDagPopupKey if cleanest) to recognise the 5 toggle keys when popupId === DAG slot. May be cleanest to handle the keys INLINE in dag.tsx via useInput, mirroring usePopupFilter — it's only 5 keys and only valid in this one popup.
- src/cli/tui/help.tsx: add a row "o/i/c/r/d  toggle DAG status filter (in DAG popup)".
- src/cli/tui/status-bar.tsx: when the DAG popup is active, add hint cluster "o/i/c/r/d toggle status".

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge; the new src/dag.ts param is pure).
- 1500 LOC hard cap. dag.tsx is 123 LOC today; this adds ~50 LOC max. dag.ts is 181; statuses filter adds ~20 LOC.
- Conventional commit prefix: tui:
- Suggested commit:
    tui: DAG popup per-status toggle keys (o/i/c/r/d compose the visible set; default all on)
- Four greens before commit.

DOCS
----
- CHANGELOG.md [Unreleased] under Added / TUI features.
- docs/USAGE_GUIDE.md TUI keymap: add the 5 toggle keys.
- skills/mu/SKILL.md TUI keymap: same.

OUT OF SCOPE
------------
- No persistence of toggle state (anti-feature: no config file).
- No "filter by impact / effort / ROI" (separate task if needed).
- No status-multiselect via the existing '/' filter primitive (that's substring-on-title; status is its own dimension).
- No mouse toggling of the strip (mouse input is its own task).

FINAL ACTION
------------
After committing + four greens green, close YOUR task with:
  mu task close feat_dag_popup_status_filters -w tui-impl --evidence "<sha>: <one-line summary>"
```

### #2 by "worker-3", 2026-05-12T17:58:12.847Z

```
FILES: src/dag.ts; src/cli/tui/use-status-filter.tsx; src/cli/tui/popups/dag.tsx; src/cli/tui/help.tsx; src/cli/tui/status-bar.tsx; src/index.ts; test/dag.test.ts; test/tui-popup-dag.test.ts; test/tui-use-status-filter.test.ts; test/tui-keys.test.ts; test/tui-help-overlay.test.ts; test/tui-status-bar.test.ts; docs/USAGE_GUIDE.md; docs/ARCHITECTURE.md; CHANGELOG.md; skills/mu/SKILL.md
COMMANDS: npm run typecheck exit 0; npm run lint exit 0; npm run test exit 0; npm run build exit 0; node dist/cli.js --help exit 0; node dist/cli.js --version exit 0; manual tmux smoke exit 0
FINDINGS: DAG popup now uses shared status filter toggles o/i/c/r/d and passes visible statuses into loadFullDag. loadFullDag drops hidden tasks and edges, so visible children of hidden parents become roots.
DECISION: Implemented PATH C per task notes; hook is popup-local/no persistence and exported for next-wave all-tasks popup reuse.
NEXT: Sibling all-tasks popup can import useStatusFilter and StatusFilterStrip directly.
VERIFIED: Commit 04783bc; full four-green gate passed plus bundle smoke and tmux toggle smoke (CLOSED off/on, reopen resets all-on).
ODDITIES: Manual tmux smoke needed target :1.1 because this tmux uses one-based window/pane indices.
```

### #3 by "worker-3", 2026-05-12T17:58:16.350Z

```
CLOSE: 04783bc: DAG popup status toggles o/i/c/r/d with shared use-status-filter hook; four greens + bundle/manual smoke
```
