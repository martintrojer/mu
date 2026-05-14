---
id: "feat_popup_6_inprogress"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: null
created_at: "2026-05-11T16:24:26.745Z"
updated_at: "2026-05-11T16:32:54.487Z"
blocked_by: ["feat_card_6_inprogress", "feat_popup_search_filter", "feat_track_drill_chains_to_task_drill"]
blocks: ["feat_more_cards_umbrella"]
---

# FEAT: Popup 6 — In-progress (Shift+6 / ^); list IN_PROGRESS tasks + filter + Enter chains into TaskDetailDrill

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:24:56.456Z

```
GOAL
----
Add the matching popup for Card 6 — In-progress. Shift+6 (glyph ^)
opens a fullscreen drill-down of every IN_PROGRESS task with j/k
nav, '/' substring filter, and Enter chains into TaskDetailDrill
(notes timeline) — since rows ARE tasks.

PRECEDENT
---------
- Card 6 (commit 760fc6c) — data layer (snapshot.inProgress).
- popups/ready.tsx (Tasks popup) — closest sibling: list of tasks,
  Enter→TaskDetailDrill chain, '/' filter wired. COPY ITS PATTERN.
- use-popup-filter.tsx (a96312c) — the primitive.
- popups/task-detail.tsx (29e3ba9) — the drill leaf.

DATA
----
WorkstreamSnapshot.inProgress[] — Card 6 already consumes it.

POPUP LAYOUT
------------
Mirror the In-progress card columns; consider widening the title
column in the popup (more pixels available):

  glyph   id          STATUS    owner       since-claim   ROI   title
  PROTECT PROTECT     PROTECT   PROTECT     PROTECT       PROTECT  CLIP

  ⚙       review_x    IN_PROG   reviewer-1  12m ago       60    Review X
  ⚙       cherry_x    IN_PROG   worker-2    34m ago       55    Cherry-pick X

Glyph: ⚙ (matches Card 6).

KEY MAP
-------
- y on focused row → yank `mu task close <id> -w <ws> --evidence "..."`
  (the most likely act-intent for IN_PROGRESS tasks; or release —
  pick whichever Tasks popup uses for IN_PROGRESS rows: per ready.tsx
  it's task close --evidence). Stay consistent with that yank
  matrix.
- Enter on focused row → DRILL via <TaskDetailDrill task=... />
  (the popups/task-detail.tsx leaf; rows ARE tasks so this is the
  feat_track_drill_chains_to_task_drill recursion contract.

KEYS WIRING
-----------
- src/cli/tui/keys.ts: dispatchGlobalKey '^' (US-row Shift+6) → openPopup(6).
- app.tsx: extend popup union to include 6; renderPopup case 6 →
  <InProgressPopup ... />; popupNameForId(6) → "In-progress".

FILTER + DRILL CONTRACT
-----------------------
- Wire usePopupFilter(). Search blob: `${id} ${title} ${owner ?? ""}`.
- Mode union "list" | "drill" (where drill = task-detail).
  Esc/q transitions: drill→list, list→close. Standard recursion
  per feat_track_drill_chains_to_task_drill.

CONSTRAINTS / DOCS / TESTS
--------------------------
- New file src/cli/tui/popups/inprogress.tsx.
- New test file test/tui-popup-inprogress.test.ts.
- ARCHITECTURE.md popups list: extend to include inprogress.
- AGENTS.md repo-layout block: extend popups/{...} list.
- CHANGELOG.md (under v0.4.0): bullet under TUI.
- StatusBar (status-bar.tsx) popupNameForId case for "In-progress".

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- Read-only TUI: yank only.
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.

OUT OF SCOPE
------------
- Other card popups (7/8/9) — separate tasks.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
  cd $(mu workspace path <agent> -w tui-impl) && \
  mu task close feat_popup_6_inprogress -w tui-impl --evidence "<sha + 1-line summary>"
```

### #2 by "worker-2", 2026-05-11T16:32:54.487Z

```
CLOSE: 4db9a34 tui: add In-progress popup (Shift+6 / ^); list IN_PROGRESS tasks + '/' filter + Enter→TaskDetailDrill chain + ROI col; 4 greens (typecheck+lint+1562 tests+build)
```
