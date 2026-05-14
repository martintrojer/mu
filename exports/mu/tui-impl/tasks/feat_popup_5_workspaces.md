---
id: "feat_popup_5_workspaces"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: null
created_at: "2026-05-11T16:09:39.426Z"
updated_at: "2026-05-11T16:23:28.544Z"
blocked_by: ["feat_card_5_workspaces", "feat_popup_search_filter"]
blocks: ["feat_more_cards_umbrella"]
---

# FEAT: Popup 5 — Workspaces (Shift+5 / %); list per-agent workspace rows + Enter→commits drill + filter

## Notes (2)

### #1 by "π - mu", 2026-05-11T16:10:23.359Z

```
GOAL
----
Add the matching popup for Card 5 — Workspaces. Shift+5 (glyph %)
opens a fullscreen drill-down of every workspace row, with j/k
navigation, '/' filter (via use-popup-filter), and Enter to drill
into the per-workspace commits list (mu workspace commits <agent>
output) for cherry-pick discovery.

PRECEDENT
---------
- Card 5 (commit b5e8811) — the data layer the popup consumes.
- Existing popups (commit 7f7a1d9, then 71a404f for fill-pane and
  a96312c for filter primitive) are the structural template.
- popups/agents.tsx is the closest sibling (also list-of-non-tasks).

DATA
----
WorkstreamSnapshot.workspaces[] (or whatever Card 5 uses; copy the
exact source). With the existing withDirty: true flag, each row
has agent name, backend, parent_ref, commitsBehindMain, dirty.

POPUP LAYOUT
------------
Mirror Card 5 columns + 2 extras useful in the fullscreen view:

  glyph   agent       backend  behind  dirty   parent_ref     path
  PROTECT PROTECT     PROTECT  PROTECT PROTECT PROTECT        CLIP

  ★       worker-1    git      3       yes     abc123def456   ~/.local/state/mu/...

(path lives only in the popup; the card was too narrow.)

KEY MAP
-------
- y on focused row → yank `cd $(mu workspace path <agent> -w <ws>)`
  (the most useful action for cherry-pick / inspection workflows;
  per skills/mu, this is the canonical entry to a workspace).
- Enter on focused row → DRILL into a read-only inline list of
  commits since fork (mu workspace commits <agent> -w <ws> JSON).
  Renders as `<sha-short>  <subject>` per row, j/k scroll. Esc/q
  back to list. A second Esc/q closes the popup.

  (Drill is NOT a task list, so do NOT chain into TaskDetailDrill.
   Workspaces aren't tasks. The drill IS a list, though, so DO
   plug into use-popup-filter for the commits view too — '/'
   substring search across sha+subject is helpful when there are
   30+ commits.)

KEYS WIRING
-----------
- src/cli/tui/keys.ts: dispatchGlobalKey already maps '%' (US row
  Shift+5) to openPopup(5) per design_global_keymap. Verify it
  still does and that the 5 case isn't a placeholder no-op. If it
  is, promote it.
- src/cli/tui/app.tsx: extend the popup union from 1|2|3|4 to
  1|2|3|4|5 (and 6/7/8/9 should be added at the same time as a
  follow-up to avoid churn — but stay surgical: only add 5 here;
  the other 4 popups are separate tasks). renderPopup gets a case
  5 → <WorkspacesPopup ... />. popupNameForId(5) → "Workspaces".

FILTER + DRILL CONTRACT
-----------------------
- Wire usePopupFilter() (from src/cli/tui/use-popup-filter.tsx).
  Search blob: `${agent} ${backend} ${parent_ref} ${dirty?'dirty':''}`.
- Drill mode (popup → drill of commits) — local state machine
  "list" | "drill". Esc/q transitions: drill→list, list→close.
  Use popups/drill.tsx DrillScrollView for the commits body if it
  fits; if not, use a small ad-hoc list (no need to over-share).

CONSTRAINTS / DOCS / TESTS
--------------------------
- New file src/cli/tui/popups/workspaces.tsx.
- New test file test/tui-popup-workspaces.test.ts (mirror existing
  tui-popup-agents.test.ts pattern: pure-source + import-graph asserts;
  no ink-testing-library available).
- ARCHITECTURE.md cards/popups row: extend popups/{...,workspaces}.tsx
  list (5 popups now).
- AGENTS.md repo-layout block: extend popups/{...} list.
- CHANGELOG.md (under v0.4.0): bullet under TUI.
- StatusBar (status-bar.tsx) popup-name lookup gets a "Workspaces"
  case; existing tests in tui-status-bar.test.ts may need a row.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- Read-only TUI: never executes mutations; yank only.
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit: typecheck + lint + test + build.

OUT OF SCOPE
------------
- Cherry-pick action (read-only pledge — yank the workspace path).
- Workspace refresh action (yank `mu workspace refresh <agent>`).
- Workspace free / recreate (yank only).
- The other 4 card popups (6/7/8/9) — separate tasks under the
  same umbrella.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
  cd $(mu workspace path <agent> -w tui-impl) && \
  mu task close feat_popup_5_workspaces -w tui-impl --evidence "<sha + 1-line summary>"
```

### #2 by "worker-3", 2026-05-11T16:23:28.544Z

```
CLOSE: a6ecee3 tui: Workspaces popup (Shift+5/%) — list + commits drill + dual filter; 4 greens (typecheck/lint/1548 tests/build)
```
