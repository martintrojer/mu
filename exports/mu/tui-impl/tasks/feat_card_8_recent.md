---
id: "feat_card_8_recent"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.2
roi: 225.00
owner: null
created_at: "2026-05-11T13:15:59.909Z"
updated_at: "2026-05-11T16:02:39.346Z"
blocked_by: ["feat_card_header_digit_prefix", "feat_column_aligned_lists"]
blocks: ["feat_more_cards_umbrella", "feat_popup_8_recent"]
---

# FEAT: Card 8 — Recently closed (last N CLOSED tasks with evidence); reads snapshot.recentClosed

## Notes (2)

### #1 by "π - mu", 2026-05-11T15:56:30.163Z

```
GOAL
----
Card 8 — Recent closed. Slot 8 was reserved per design_global_keymap.
Mirror Card 5/6/7 (commits 264585f95, 760fc6c, 4c50fc0) — same template.

WHY
---
Short-term memory: "what just shipped" is constantly relevant for
cherry-pick + verify cycles. Today the operator runs `mu state` or
`mu task list --status CLOSED -w …` separately. One glanceable
card surfaces the N most recent CLOSED tasks (with relative time
since close).

DATA
----
src/state.ts WorkstreamSnapshot.recentClosed (or similar — inspect
the type; if not present, derive from snapshot.tasks filtered by
status===CLOSED, sorted by updated_at desc, top 8). Use what's
there; don't extend the SDK.

If the snapshot doesn't yet expose recentClosed, look for
`closedRecent` / similar; otherwise add a minimal derivation INSIDE
the card (cheaper than extending the SDK for a single consumer).

CARD LAYOUT
-----------
Columns:

  glyph   id           STATUS   when      title
  PROTECT PROTECT      PROTECT  PROTECT   CLIP

  ✓       feat_card_5  CLOSED   3m ago    FEAT: Card 5 — Workspaces

Glyph: ✓ green for CLOSED.
Subtitle: "<N>" or "last <relTime since most recent close>".
Empty body: <Text dimColor>(none recently closed)</Text>

KEY WIRING
----------
- keys.ts: digit '8' was reserved → toggleCard(8). Slot 9 still reserved.
- app.tsx: render <RecentCard ... /> after Blocked; widen cardKeyFromId(8).
- src/cli/tui/state.ts: CardVisibility.recent = true default.
- help.tsx: extend digit prefix to ⁸; legend updated.

POPUP / FUTURE OBLIGATIONS (when slot-8 popup ships)
-----------------------------------------------------
Out of scope NOW. When the popup is added under
feat_more_cards_umbrella, it MUST consume:
  (a) feat_popup_search_filter — '/' filter via usePopupFilter
  (b) feat_track_drill_chains_to_task_drill — Enter chains rows
      into TaskDetailDrill (rows ARE tasks)

CONSTRAINTS / DOCS / TESTS
--------------------------
Same as Card 6/7. CHANGELOG, ARCHITECTURE.md, AGENTS.md updated
with the new file. New test/tui-card-recent.test.ts.

OUT OF SCOPE
------------
- Shift+8 popup (umbrella tracks it).
- Pagination (keep top-N for v0).
- Time-window filter (the popup will own that).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
  cd $(mu workspace path <agent> -w tui-impl) && \
  mu task close feat_card_8_recent -w tui-impl --evidence "<sha + 1-line summary>"
```

### #2 by "worker-3", 2026-05-11T16:02:39.346Z

```
CLOSE: 6dde3b3 tui: add Card 8 — Recent (slot 8 promoted); typecheck+lint+test(1455 pass, +11)+build all green
```
