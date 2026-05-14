---
id: "feat_popup_8_recent"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.2
roi: 225.00
owner: null
created_at: "2026-05-11T16:40:15.257Z"
updated_at: "2026-05-11T19:22:26.606Z"
blocked_by: ["feat_card_8_recent", "feat_popup_search_filter", "feat_track_drill_chains_to_task_drill"]
blocks: ["feat_more_cards_umbrella"]
---

# FEAT: Popup 8 — Recent (Shift+8 / *); list recently CLOSED tasks + filter + Enter chains into TaskDetailDrill

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:40:58.928Z

```
GOAL
----
Add the matching popup for Card 8 — Recent. Shift+8 (glyph *) opens
a fullscreen drill-down of recently CLOSED tasks with j/k nav,
'/' filter, and Enter chains into TaskDetailDrill (rows ARE tasks).

Templated repeat of feat_popup_6_inprogress — same recipe, different
data source.

DATA
----
WorkstreamSnapshot.recentClosed[] (or whatever Card 8 uses; copy
the exact source).

POPUP LAYOUT
------------
Mirror Card 8 columns + title widening for the popup:

  glyph   id              STATUS  closed-at    impact  effort  ROI   title
  PROTECT PROTECT         PROTECT PROTECT      PROTECT PROTECT PROTECT  CLIP

Glyph: ✓ green (matches Card 8).

KEY MAP
-------
- y → yank `mu task open <id> -w <ws>` (per ready.tsx yank matrix
  for CLOSED tasks: re-open is the typical act-intent for a
  recently-closed task you want to revisit). If a different verb
  feels right, mirror what popups/ready.tsx already does for the
  CLOSED branch of its yank matrix.
- Enter → drill via TaskDetailDrill (rows are tasks).

KEYS WIRING
-----------
- src/cli/tui/keys.ts: dispatchGlobalKey '*' → openPopup(8).
  Add '*': 8 to the glyphMap; widen the openPopup union.
- app.tsx: extend popup union to include 8; renderPopup case 8;
  popupNameForId(8) → "Recent".

FILTER + DRILL CONTRACT
-----------------------
- Wire usePopupFilter() with blob `${id} ${title} ${owner ?? ""}`.
- Mode union "list" | "drill" → standard recursion.

CONSTRAINTS / DOCS / TESTS
--------------------------
Same as Popup 6/7 — see feat_popup_6_inprogress notes for the recipe.
New popups/recent.tsx + test/tui-popup-recent.test.ts. Update
ARCHITECTURE.md / AGENTS.md / CHANGELOG.md / status-bar.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- Read-only TUI: yank only.
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
  cd $(mu workspace path <agent> -w tui-impl) && \
  mu task close feat_popup_8_recent -w tui-impl --evidence "<sha + 1-line summary>"
```

### #2 by "worker-2", 2026-05-11T19:22:26.606Z

```
CLOSE: e4efd66 tui: add Recent popup (Shift+8 / *) — list of CLOSED tasks + '/' filter + Enter→TaskDetailDrill chain; 1610 tests pass
```
