---
id: "feat_card_7_blocked"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.2
roi: 250.00
owner: null
created_at: "2026-05-11T13:15:59.616Z"
updated_at: "2026-05-11T15:53:05.671Z"
blocked_by: ["feat_card_header_digit_prefix", "feat_column_aligned_lists"]
blocks: ["feat_more_cards_umbrella", "feat_popup_7_blocked"]
---

# FEAT: Card 7 — Blocked tasks (what's waiting and on what); reads snapshot.blocked

## Notes (2)

### #1 by "π - mu", 2026-05-11T15:38:29.079Z

```
GOAL
----
Add Card 7 — Blocked tasks. Slot 7 was reserved per
design_global_keymap. Mirror Card 5 (commit 264585f95) and Card 6
(commit 760fc6c) — same template.

WHY
---
"What's blocking the umbrella" is the most common diagnostic
question during multi-wave orchestration. Today the operator must
walk the dependency tree manually via `mu task tree <id>`. One
glanceable card surfaces the blocked-tasks subset directly.

DATA
----
src/state.ts already exposes WorkstreamSnapshot.blocked:
  TaskRow[]  // tasks where status = OPEN AND has unsatisfied blockers
Use what's there. Render id + title + #blockers + ROI bucket. Don't
extend the SDK.

CARD LAYOUT
-----------
Columns (column-aligned via columns.ts; protect/clip per
feat_column_aligned_lists):

  glyph   id           STATUS   #blocks   ROI    title
  PROTECT PROTECT      PROTECT  PROTECT   PROTECT  CLIP

  ⛓       review_x     OPEN     2          75    Review X
  ⛓       cherry_x     OPEN     1          60    Cherry-pick X

Glyph: ⛓ for blocked (chain link). Use a dim colour.
Subtitle: "<N>" or "<N> · top blocker: <id>" if non-empty.
Empty body: <Text dimColor>(none blocked)</Text>

KEY WIRING
----------
- src/cli/tui/keys.ts: digit '7' was reserved → toggleCard(7).
  Slots 8-9 stay reserved.
- src/cli/tui/app.tsx: render <BlockedCard ... /> after the
  In-progress card; widen cardKeyFromId(7) → "blocked".
- src/cli/tui/state.ts (TUI): add `blocked: boolean` to CardVisibility;
  default true.
- src/cli/tui/help.tsx: extend the digit prefix to ⁷; legend
  "...In-progress/Blocked (1-7)".

POPUP / FUTURE OBLIGATIONS (when slot-7 popup ships)
-----------------------------------------------------
Out of scope NOW. When the popup is added under
feat_more_cards_umbrella, it MUST consume:
  (a) feat_popup_search_filter — '/' filter via usePopupFilter
  (b) feat_track_drill_chains_to_task_drill — Enter chains rows
      into TaskDetailDrill (rows ARE tasks)

CONSTRAINTS / DOCS / TESTS
--------------------------
Same as Card 6 spec — refer to feat_card_6_inprogress notes for
the exhaustive recipe (test file mirror, CHANGELOG, ARCHITECTURE,
AGENTS.md).

OUT OF SCOPE
------------
- Shift+7 popup (umbrella tracks it).
- Schema additions.
- Live blocker-tree explorer (just the count + top-blocker token
  for v0).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
  cd $(mu workspace path <agent> -w tui-impl) && \
  mu task close feat_card_7_blocked -w tui-impl --evidence "<sha + 1-line summary>"
```

### #2 by "worker-3", 2026-05-11T15:53:05.671Z

```
CLOSE: a7565ca00b9433fe2c62bee15b91cd3ca5da1350 + tui: add Card 7 — Blocked (digit 7 promoted from reserved); reads snapshot.blocked + per-row getTaskEdgesWithStatus; mirrors Card 6 shape, 4 greens (1444 tests pass, was 1432)
```
