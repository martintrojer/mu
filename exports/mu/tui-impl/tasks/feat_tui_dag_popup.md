---
id: "feat_tui_dag_popup"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.4
roi: 150.00
owner: "worker-2"
created_at: "2026-05-12T12:44:55.720Z"
updated_at: "2026-05-12T14:40:05.145Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui"]
---

# FEAT: TUI dashboard top-level shortcut to pop up the current workstream's task DAG visualisation (full graph, not the per-task tree drilldown that already exists in popups)

## Notes (3)

### #1 by "π - mu", 2026-05-12T12:44:56.064Z

```
MOTIVATION (verbatim user)
--------------------------
\"feat; add a top level shortcut in tui dash that pops up the current DAG visualization\"

CURRENT STATE
-------------
- Static CLI: 'mu task tree <id>' (src/cli/tasks/tree.ts) renders a per-task ASCII tree of blockers + dependents. Single-rooted; needs an id.
- Static CLI: 'mu state' / mission control shows tracks (parallel-tracks union-find) but not the full edge graph.
- TUI Tracks card + Tracks popup show track summaries (one entry per track with goal-roots count) but no edge visualisation.

GAP: there is no whole-workstream DAG view (every task + every blocks edge). For larger workstreams (90+ tasks like tui-impl right now), the parallel-tracks summary hides the actual dependency shape.

DESIGN
------
New popup slot. Available top-level keys to bind:
  - Slot 0 was 'reserved by convention (no promotion task today)' per keys.ts. Could promote.
  - OR a new symbol key e.g. 'g' (graph) / 'd' (dag) / Shift+G / Shift+D.

Recommend: 'g' (mnemonic = graph) for dashboard toggle of a Card 0 OR Shift+0 = ')' for the popup. Pick one based on what stays consistent with the existing 1-9/!@#$ pattern. Slot 0 is the natural slot if we follow the pattern.

Card 0 (optional): no — the DAG is too dense for a static card. Skip the card; make this popup-only via a NEW keybinding. 'g' is the cleanest mnemonic.

POPUP SHAPE
-----------
Reuse src/cli/tui/popups/* infrastructure (PopupShell + DrillScrollView + applyScroll). The DAG renders as ASCII text (use the same renderTree logic from src/cli/tasks/tree.ts but adapted to render ALL tasks, not from a single root).

Two render modes:
  (1) FOREST: render every task that has no blockers (= every root) as a separate sub-tree, with dependents below. Concatenate sub-trees with a blank-line separator. Same algo as renderTree but seeded with every root.
  (2) FLAT GRAPH: list every task once; for each task, list its 'blocked-by' edges as bullet children (single-line per edge).

Recommend: FOREST (mode 1). It mirrors 'mu task tree' which users already know.

Body content goes through DrillScrollView (already wraps long lines; j/k scroll). Renders inside a PopupShell with title 'DAG · <ws>'.

DATA SOURCE
-----------
Add a small helper to src/tasks.ts (or a new src/dag.ts):
  loadFullDag(db, workstream): { roots: TaskRow[], edges: Map<string, string[]> }
Where edges maps task name → list of names it blocks.

Reuse renderTree's per-task ASCII machinery; loop over roots.

WIRING
------
- src/cli/tui/keys.ts:
    Add 'g' → { kind: 'openPopup', cardId: 0 } (or new 'openDag' action variant).
- src/cli/tui/app.tsx:
    Widen PopupId to include 0 (or 'dag' string variant).
    Add <DagPopup /> render branch.
    popupNameForId(0) = 'DAG'.
- src/cli/tui/popups/dag.tsx (NEW): the popup component. Mirrors popups/log.tsx structurally — load body once on mount, drill via useDrillKeymap.
- src/cli/tui/help.tsx: add the 'g' key + 'DAG popup' description row.
- src/cli/tui/status-bar.tsx: extend the global hint cluster's left zone to mention 'g DAG'.

YANK MATRIX
-----------
Read-only popup (per ROADMAP pledge). 'y' yanks 'mu task tree <id>' for the focused task (where 'focused' is the cursor row in the rendered DAG body).

LIST-MODE PROPS
---------------
Match the other popups' interface signature so the dispatcher works without special-casing.

TESTS
-----
- test/tui-popup-dag.test.ts: source-level + behavioural assertions (PopupShell delegation, useDrillKeymap wiring, renderForest helper unit tests).
- test/tui-keys.test.ts: extend with 'g' → openPopup(0) (or whatever slot you pick).
- test/tui-help-overlay.test.ts: extend with the new help row.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: 'g' shortcut pops up workstream DAG (forest of every root + dependents; reuses task-tree renderer)

DOCS
----
- CHANGELOG.md (under v0.4.0 or v0.4.1 features): bullet under TUI features.
- docs/USAGE_GUIDE.md TUI keymap: add 'g  DAG popup' row.
- skills/mu/SKILL.md TUI keymap: same.
- docs/ARCHITECTURE.md src/cli/tui/popups/ row: extend with dag.tsx.

OUT OF SCOPE
------------
- Don't add an interactive DAG editor (read-only TUI pledge).
- Don't add a non-ASCII renderer (mermaid / graphviz is a separate task — promote when real friction).
- Don't add filtering on status / impact within the DAG (the existing usePopupFilter primitive can be added later if asked).
- Don't add per-edge styling (just the existing renderTree ASCII).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_tui_dag_popup -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "worker-2", 2026-05-12T14:40:04.824Z

```
FILES: src/dag.ts; src/cli/tasks/tree.ts; src/cli/tui/{app.tsx,keys.ts,help.tsx,status-bar.tsx,state.ts}; src/cli/tui/popups/dag.tsx; src/index.ts; test/tui-popup-dag.test.ts; test/tui-keys.test.ts; test/tui-help-overlay.test.ts; test/tui-status-bar.test.ts; docs/USAGE_GUIDE.md; docs/ARCHITECTURE.md; CHANGELOG.md; skills/mu/SKILL.md
COMMANDS: mu state -w tui-impl; mu task notes feat_tui_dag_popup -w tui-impl; npm run typecheck; npm run lint; npx vitest run targeted TUI/DAG tests; npm run typecheck && npm run lint && npm run test && npm run build (all exit 0); git commit
FINDINGS: TUI had no slot-0 popup path; task tree rendered via private console recursion; docs still mentioned older TUI key ranges/F1 in a few places.
DECISION: Added src/dag.ts for loadFullDag/renderForest/renderTaskTree; wired g and Shift+0 to PopupId 0; DagPopup uses PopupShell + DrillScrollView with no nested TitledBox.
NEXT: Precise cursor-row to task-id yank remains TODO; current yank tracks the root nearest the scroll top (documented in CHANGELOG).
VERIFIED: Four-greens passed: typecheck, lint, full vitest suite (2040 tests), build. Commit 0504ea7.
ODDITIES: Full suite prints existing agent-name hint noise from fixtures.
```

### #3 by "worker-2", 2026-05-12T14:40:05.145Z

```
CLOSE: 0504ea7: TUI g/Shift+0 DAG popup renders full workstream forest; four greens passed
```
