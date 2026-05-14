---
id: "feat_tui_all_tasks_popup"
workstream: "tui-impl"
status: CLOSED
impact: 65
effort_days: 0.4
roi: 162.50
owner: "worker-2"
created_at: "2026-05-12T15:57:06.633Z"
updated_at: "2026-05-12T18:23:28.906Z"
blocked_by: ["fix_card_slot_layout_recents_commits_split"]
blocks: ["audit_status_bar_hint_consistency"]
---

# FEAT: TUI top-level all-tasks list popup with per-status toggles + sort toggles + Enter drill (complements DAG; list/sort mental model)

## Notes (3)

### #1 by "π - mu", 2026-05-12T15:58:12.850Z

```
MOTIVATION (verbatim user)
--------------------------
"feat. we do need some kind of way in the tui to list all tasks. and then have similar per status toggles. maybe the dag covers this mostly, but would be nice with a list view that you can drill in from. this view should also have sort toggles. this can be another toplevel key bind"

ARCHITECTURAL FRAMING
---------------------
The DAG popup (g) is graph-shaped: it shows blocking relationships, but the user has to scan the forest to find a task. Many discovery flows are LIST-shaped:
  - "show me every OPEN task sorted by ROI"
  - "what's the OLDEST blocked task in this workstream?"
  - "list every task I've ever closed for evidence diff"

The Ready / In-progress / Blocked / Recent cards each show a slice; this popup is the FULL list with per-status filters + sort toggles + Enter drill. Complementary to the DAG, not a replacement.

DECISIONS (locked from user feedback)
-------------------------------------
1. New top-level key binding (dashboard-only).
2. Per-status toggles (mirror feat_dag_popup_status_filters: o/i/c/r/d). Default = ALL ON (today's `mu task list` behaviour).
3. Sort toggles. Reuse src/cli.ts TASK_SORT_KEYS = ["roi","recency","age","id"] — 4 keys.
4. Enter drills into TaskDetailDrill (mirror the existing per-card popup pattern).
5. NO persistence (anti-feature pledge — no config file).
6. Read-only (yank `mu task show <id>`; never execute mutations).

KEY BINDING
-----------
Top-level dashboard key: 't' (mnemonic = tasks). Conflict-check src/cli/tui/keys.ts dispatchGlobalKey:
  - 't' currently UNUSED on dashboard. ✓
  - In popup, 't' is unused. ✓ (numeric/Shift-numeric/g are taken; t is free)

Status toggles inside the popup (5 keys; same as the parallel feat_dag_popup_status_filters task):
  o → toggle OPEN
  i → toggle IN_PROGRESS
  c → toggle CLOSED
  r → toggle REJECTED
  d → toggle DEFERRED
  (verify each is free in the popup-local keymap; `r` was previously dashboard-refresh-only, `d` is unused, `i/c/o` all free)

Sort toggles inside the popup (4 keys):
  s → cycle through TASK_SORT_KEYS (roi → recency → age → id → roi)
  S → reverse cycle (id → age → recency → roi → id)
OR — more lazygit-style — separate keys per sort key:
  s → cycle (recommended; one key, mnemonic, easy to remember)
DEFAULT sort: "roi" (matches `mu task list` default; same as Ready card).
DEFAULT direction: descending (highest ROI first; same as `mu task next`). Add 'R' (capital R) → reverse-direction toggle? Possibly overkill; see "OUT OF SCOPE" below.

DECISION: ship 's' = cycle sort key only; direction toggle is OUT OF SCOPE (defer to v0.6 if friction).

VISIBLE STATE (in popup)
------------------------
Filter strip + sort indicator at the top of the popup body, between PopupShell title and the list:
  filters: [O]pen ●  [I]n_progress ●  [C]losed ○  [R]ejected ○  [D]eferred ○
  sort: [s]ort=ROI ↓ (10 tasks visible / 110 total)

Use existing colorStatus colours for the status letters. Sort indicator just text.

DATA / RENDER
-------------
- Reuse src/tasks.ts listTasks(db, workstream) — it already returns every task in the ws regardless of status.
- Apply status filter at the rendered layer (filter the array after fetch; cheap — these are in-memory rows).
- Apply sort key by reusing the existing comparator from src/cli.ts (find the comparator factory used by `mu task list --sort`; reuse not duplicate).
- Render via the centralised list primitives (ListRow + applyScroll + usePopupViewport + usePopupFilter for substring-on-title `/` filter — combined with status filter; the two compose).

POPUP COMPONENT (NEW)
---------------------
- src/cli/tui/popups/all-tasks.tsx
- Mirror src/cli/tui/popups/ready.tsx (already a task-list popup with cursor + Enter drill).
- Add the status-filter set (useState<Set<TaskStatus>>) + sort key (useState<TaskSortKey>) + filter-strip render.
- Enter on focused row → TaskDetailDrill (existing, no new code; same pattern as Ready/Blocked/InProgress popups).
- Yank: 'y' yanks `mu task show <id>` for the focused row (mirror existing list popups).

WIRING
------
- src/cli/tui/keys.ts: 't' on dashboard → openPopup({ kind: "allTasks" }) variant. Also wire 'T' (Shift+T) → same (mnemonic consistency with the digit/Shift-digit pattern, even though there's no card slot).
- src/cli/tui/app.tsx: PopupId widened to include the new popup; renderPopup branch + popupNameForId returning "All tasks".
- src/cli/tui/help.tsx: add "t  All tasks popup" row + the in-popup keys (o/i/c/r/d  status toggle; s  cycle sort).
- src/cli/tui/status-bar.tsx: dashboard hint cluster includes "t tasks". When the popup is active, the hint cluster includes the in-popup keys.

⚠️ COORDINATION WITH SIBLING TASK ⚠️
feat_dag_popup_status_filters wires identical o/i/c/r/d toggles into the DAG popup. To DRY:
  - Extract a tiny shared hook src/cli/tui/popups/use-status-filter.ts that exposes:
      const { statuses, toggle, render: <FilterStrip statuses={statuses} /> } = useStatusFilter();
  - Both DAG popup and All-tasks popup consume this hook.
  - Behaviour: same five toggles, same default (all on), same render strip.
  - This avoids two divergent implementations.

If feat_dag_popup_status_filters lands FIRST, this task imports the hook from there.
If THIS task lands first, define the hook here; DAG-popup task picks it up.
EITHER WAY: the hook lives in src/cli/tui/popups/use-status-filter.ts (or src/cli/tui/use-status-filter.tsx — match the convention of use-popup-filter.tsx which is at src/cli/tui/use-popup-filter.tsx).

⚠️ BUNDLE CYCLE WARNING ⚠️
Don't import from `../../../cli.js` (causes top-level-await deadlock; SYMPTOM: bundled `node dist/cli.js --help` exits silently). The TASK_SORT_KEYS export from src/cli.ts MIGHT be safe (it's a const, not a function), but to be SAFE move TASK_SORT_KEYS into src/tasks/sort.ts (NEW) and import from there in both the popup AND the existing src/cli/tasks/queries.ts consumer. Refactor signal — small + safe.

After build, smoke MANUALLY:
  npm run build && node dist/cli.js --help && node dist/cli.js --version
If silent, grep `from "../../../cli.js"` in src/cli/tui/.

TESTS
-----
- test/tui-popup-all-tasks.test.ts (NEW):
  * Initial render shows every task across all statuses, sorted by ROI desc.
  * Pressing 'c' hides CLOSED tasks (assert via walk()).
  * Filter strip shows current toggle state.
  * Pressing 's' cycles sort key; sort indicator updates.
  * Enter on focused row dispatches the TaskDetailDrill open action.
  * 'y' yanks `mu task show <id>`.
- test/tui-keys.test.ts: extend with 't' on dashboard → openPopup(allTasks); o/i/c/r/d/s inside the popup map to the right actions.
- test/tui-help-overlay.test.ts: new rows.
- test/tui-status-bar.test.ts (or equivalent): 't tasks' appears in dashboard hint cluster.
- src/tasks/sort.ts (NEW if extracted): unit test the comparator (already covered indirectly by `mu task list --sort` tests; promote to direct unit test if extracting).

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO: node dist/cli.js --help && node dist/cli.js --version (bundle smoke)

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap. The new popup file ~150-200 LOC; the shared hook ~50 LOC.
- Conventional commit prefix: tui:
- Suggested commit:
    tui: 't' all-tasks popup with per-status toggles (o/i/c/r/d) + sort cycle (s); Enter drills into task detail
- Read-only TUI (yank `mu task show`; never execute mutations).

DOCS
----
- CHANGELOG.md [Unreleased] under Added / TUI features.
- docs/USAGE_GUIDE.md TUI keymap: 't' + the in-popup keys.
- skills/mu/SKILL.md TUI keymap: same.
- docs/ARCHITECTURE.md src/cli/tui/popups/ row: extend with all-tasks.tsx + use-status-filter.

OUT OF SCOPE
------------
- No persistence of toggles / sort key (anti-feature: no config).
- No reverse-direction toggle ('R') — defer to v0.6 if friction.
- No filter by impact / effort / ROI (defer; '/' substring + status toggles cover most use cases).
- No bulk operations (read-only TUI pledge).
- No edit-from-popup (read-only).
- No saved views / presets (anti-feature).

ORDERING
--------
This is a v0.5 feature. Independent of all other open tasks except for the optional shared use-status-filter hook coordination with feat_dag_popup_status_filters. Either order works; document the chosen approach in the commit message.

FINAL ACTION
------------
After committing + four greens green + bundle smoke, close YOUR task with:
  mu task close feat_tui_all_tasks_popup -w tui-impl --evidence "<sha>: <one-line summary>"
```

### #2 by "worker-2", 2026-05-12T18:23:28.537Z

```
FILES:    src/cli/tui/popups/all-tasks.tsx; src/cli/tui/{app,keys,help,status-bar,state}.tsx; src/state.ts; src/tasks/sort.ts; tests under test/tui-popup-all-tasks.test.ts, test/tasks-sort.test.ts, test/cli-task-sort.test.ts plus key/help/status/snapshot fixtures; docs/USAGE_GUIDE.md, CHANGELOG.md, docs/ARCHITECTURE.md, skills/mu/SKILL.md
COMMANDS: mu task notes feat_tui_all_tasks_popup -w tui-impl; npm run typecheck; npm run lint; npm run test; npm run build; node dist/cli.js --help; node dist/cli.js --version; manual tmux smoke with node dist/cli.js -w tui-impl and keys t/s/c/y/Enter; git commit
FINDINGS: DAG already had shared useStatusFilter; task sort logic lived in src/cli.ts, so extracting src/tasks/sort.ts avoided TUI importing the CLI bundle root.
DECISION: Implemented keybind-only t popup, no card/digit slot, default ROI desc, s cycle only, read-only yanking mu task show. TUI snapshot opts into allTasks via withAllTasks; popup can fall back to listTasks.
NEXT: audit_status_bar_hint_consistency can now audit the t all-tasks dashboard/status-bar hints.
VERIFIED: npm run typecheck && npm run lint && npm run test && npm run build all passed; bundle smoke help/version returned output; manual smoke opened All tasks, filtered CLOSED with c, cycled sort with s, yanked command, and drilled into notes.
ODDITIES: Full test suite emits existing agent-name hint noise; no failures. Manual smoke used private tmux socket and was cleaned up.
```

### #3 by "worker-2", 2026-05-12T18:23:28.906Z

```
CLOSE: a65eefe: added keybind-only TUI all-tasks popup with status filters, sort cycle, TaskDetailDrill, yank, tests/docs; four greens + bundle/manual smoke
```
