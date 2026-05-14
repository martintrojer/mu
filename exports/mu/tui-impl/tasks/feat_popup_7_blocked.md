---
id: "feat_popup_7_blocked"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: null
created_at: "2026-05-11T16:29:29.866Z"
updated_at: "2026-05-11T16:39:57.909Z"
blocked_by: ["feat_card_7_blocked", "feat_popup_search_filter", "feat_track_drill_chains_to_task_drill"]
blocks: ["feat_more_cards_umbrella"]
---

# FEAT: Popup 7 — Blocked (Shift+7 / &); list blocked tasks + filter + Enter chains into TaskDetailDrill

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:29:53.514Z

```
GOAL
----
Add the matching popup for Card 7 — Blocked. Shift+7 (glyph &) opens
a fullscreen drill-down of every blocked task with j/k nav, '/'
substring filter, and Enter chains into TaskDetailDrill.

Carbon copy of feat_popup_6_inprogress recipe — same structure,
different data source.

DATA
----
WorkstreamSnapshot.blocked[] — Card 7 already consumes it.

POPUP LAYOUT
------------
Mirror Card 7 columns + extras for the popup width:

  glyph   id          STATUS  #blocks  top-blocker  ROI   title
  PROTECT PROTECT     PROTECT PROTECT  PROTECT      PROTECT  CLIP

Glyph: ⛓ (matches Card 7).

KEY MAP
-------
- y on focused row → yank `mu task tree <id> -w <ws>` (the most
  useful action: "show me what's blocking this"). Or yank
  `mu task show <id>` if tree is too heavy. Pick consistently with
  popups/ready.tsx if it has a "blocked" branch in its yank
  matrix.
- Enter → drill via TaskDetailDrill (rows are tasks; recursion
  contract applies).

KEYS WIRING
-----------
- src/cli/tui/keys.ts: dispatchGlobalKey '&' → openPopup(7).
- app.tsx: extend popup union to include 7; renderPopup case 7;
  popupNameForId(7) → "Blocked".

FILTER + DRILL CONTRACT
-----------------------
- Wire usePopupFilter() with blob `${id} ${title} ${blockerIds.join(" ")}`.
- Mode union "list" | "drill" → standard recursion.

CONSTRAINTS / DOCS / TESTS
--------------------------
Same as Popup 6 — see feat_popup_6_inprogress notes for the recipe.
New popups/blocked.tsx + test/tui-popup-blocked.test.ts. Update
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
  mu task close feat_popup_7_blocked -w tui-impl --evidence "<sha + 1-line summary>"
```

### #2 by "worker-3", 2026-05-11T16:39:57.909Z

```
CLOSE: ff1702a tui: add Blocked popup (Shift+7 / &); list + '/' filter + TaskDetailDrill chain; 4 greens (1572 tests)
```
