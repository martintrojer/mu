---
id: "bug_tui_render_overflow_low_row_pane"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.3
roi: 266.67
owner: "worker-2"
created_at: "2026-05-12T17:19:07.974Z"
updated_at: "2026-05-12T18:02:09.613Z"
blocked_by: ["bug_layout_slot_0_buried_after_slot_fix"]
blocks: []
---

# BUG: TUI render is corrupted on low-row-count panes — card borders bleed through each other, columns interleave, footer hints appear out of place (low-rows manifestation; not the same as the just-fixed hook crash)

## Notes (3)

### #1 by "π - mu", 2026-05-12T17:20:17.503Z

```
MOTIVATION (verbatim user)
--------------------------
"bug, render is incorrect on very low-row-count panes. realted to your fix?"
[screenshot showed columns interleaving on the same line: `╰─ +1 more · Shift+1 ─` from column 1 followed by `i│─port_file_size_budget_test ROI 60 PORT file size budget…─│` from column 2; multiple cards appear to render OVER each other; activity-log header appears mid-line stacked with workspaces card content]

NOT THE TAB STRIP HOOK CRASH
----------------------------
The hook crash (bug_tab_strip_conditional_hook_crash) was fixed in commit 68a4f3b before this report came in. This is a SEPARATE bug — the render is happening (no crash), but it's CORRUPTED.

ROOT CAUSE HYPOTHESIS
---------------------
The 40x10 minimum guard in src/cli/tui/app.tsx (lines 126-133) catches the extreme case:
  if (cols < 40 || rows < 10) {
    return <Text color="red">terminal too small ({cols}x{rows}) — need at least 40x10…</Text>;
  }

But "rows ≥ 10" is far too lenient. With 10 rows TOTAL:
  - 1 row tab strip (multi-ws)
  - 1 row status bar
  - That leaves 8 rows for the dashboard.
  - 8 rows split across N visible cards (default 9 cards visible) = ~0.9 rows per card.
  - Each card needs minimum chrome (4 rows: top border + header line + bottom border + footer inset) PLUS ≥2 body rows = 6 rows minimum per card.
  - Per-card row budget allocator (allocateRowBudgets in src/cli/tui/layout.ts) detects this:
      if (bodyAvailable <= minTotal) {
        for (const e of entries) out[e.id] = e.minRows;
        return out;
      }
    It assigns minRows to every card and returns. But the SUM of minRows + chrome can EXCEED the available height, and the cards then stack via flexbox in ink and OVERFLOW the parent — which ink renders by interleaving with siblings (the user's screenshot effect).

The screenshot suggests: the budget allocator picks min-rows for each card, the resulting total VERTICAL height exceeds the pane height, and ink's flex layout doesn't clip cleanly — instead borders from card N appear inline with card N+1's content.

THREE REMEDIES (locked: ship all three)
---------------------------------------
A. **Raise the minimum guard from 10 rows to MIN_VIABLE_ROWS** (a calculated number, not 10).
   - Compute MIN_VIABLE_ROWS = 1 (tab strip) + 1 (status bar) + per-column min stack.
   - Per-column min stack = sum of (minRows + chrome) for the cards in the FATTEST column for the current breakpoint (which is the right column at 2-col with task-list cards: e.g. 5 cards × (3+4) = 35 rows minimum).
   - That's prohibitive on most terminals — no one runs a 35-row pane.
   - PRAGMATIC FIX: instead of a static MIN_VIABLE_ROWS, ALLOW LOW ROWS but…

B. **In the row-budget allocator, when min-rows-total exceeds available, START HIDING CARDS** (lowest priority first) instead of returning min-rows for everyone (which causes overflow).
   - Priority order (toggle off when space is tight): Doctor (9) > Recent (8) > Workspaces (5) > Tracks (2) > Blocked (7) > InProgress (6) > Activity log (4) > Commits (0) > Agents (1) > Ready (3).
   - The order: keep the action-critical cards (Ready, Agents, Commits, Activity log) until last; cull the diagnostic ones (Doctor, Recent, Workspaces) first.
   - Stop culling once min-rows-total fits.

C. **Add an outer height clip on the dashboard container** so ink's flex layout can't render past the available rows even if the inner allocation is wrong (a safety net behind A+B).
   - In src/cli/tui/app.tsx: wrap <DashboardColumns> in a <Box height={dashRows}> with overflow="hidden" if ink supports it (check the ink version's Box props), else cap row counts before render.
   - This guarantees no card spills past the screen even if the allocator is over-budgeted.

DESIGN DECISION (LOCKED)
------------------------
Implement all three:
  - A: lower the hardcoded "terminal too small" threshold to ABSOLUTE minimum (e.g. 5 rows: 1 tab + 1 status + 3 for one card chrome). Past that, show the "too small" panic.
  - B: make the budget allocator culling-aware — when min-rows-total exceeds budget, cull cards in the priority order above until it fits, then redistribute budget to remaining cards.
  - C: outer clip in app.tsx so even if A+B miss something the rendering can't be corrupt — just truncated.

OUTPUT
------
- src/cli/tui/layout.ts: extend allocateRowBudgets() OR add a sibling cullCardsForRows() helper that takes (visibleCardIds, availableRows) → reducedCardIds. The dashboard layer calls it BEFORE allocateRowBudgets so the allocator never sees an impossible budget.
- src/cli/tui/app.tsx:
  * Lower the row threshold in the "too small" guard (5 rows or so).
  * Compute the available-for-cards rows; pass into the new culler.
  * Apply the resulting visibleCardIds to layoutColumns + allocateRowBudgets.
  * Add a height-bounded outer container around the dashboard so flex overflow CAN'T corrupt sibling rows.
  * If cards were culled, show a small dim hint at the bottom: "+N cards hidden · resize taller".

⚠️ CO-DESIGN WITH IN-FLIGHT bug_layout_slot_0_buried_after_slot_fix ⚠️
That bug (worker-2 is on it) rewrites layoutColumns(). The culling step proposed here CALLS layoutColumns AFTER culling. Make sure the worker for THIS bug rebases on top of bug_layout_slot_0_buried's fix once it lands. Block this task on that one.

TESTS (REQUIRED)
----------------
- test/tui-layout.test.ts (extend): cullCardsForRows() fixtures.
  * 9 cards visible + 80 available rows → no culling.
  * 9 cards visible + 30 rows → cull Doctor + Recent + Workspaces; assert reduced set.
  * 9 cards visible + 10 rows → cull aggressively; only Ready + Agents + maybe Activity log left.
  * 9 cards visible + 4 rows → cull all but the highest-priority one (Ready).
  * 0 cards visible (all toggled off) + any rows → returns [].
  * Cards that the user explicitly toggled OFF stay off (don't resurrect them just because there's room).
- test/tui-dashboard-layout.test.ts: walk-introspection that on a small pane the dashboard renders only the surviving cards and a "+N cards hidden" hint.
- test/tui-row-budget-overflow.test.ts (NEW): integration-shaped test that stress-renders the dashboard at 5/10/20/40-row heights and asserts:
  * No card's bottom border sits on the same line as another card's content (regression for the user-reported corruption).
  * The total rendered height fits inside the simulated pane height.

VERIFY MANUALLY
---------------
- After build:
  cd /Users/mtrojer/hacking/mu
  # In a small tmux pane (resize to ~15 rows tall):
  node dist/cli.js -w tui-impl
  # EXPECTED: clean render with several cards culled + a "+N hidden" hint;
  # NO interleaved borders / overlapping content.
  # Resize taller; cards reappear progressively.
  # Resize shorter than 5 rows: panic message renders cleanly.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke: node dist/cli.js --help && node dist/cli.js --version

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; layout.ts is ~240 LOC; this adds ~50 LOC.
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: cull low-priority cards on small panes so the dashboard never overflows the available rows (was: borders interleaved when rows < ~30); outer height clip as safety net
- Four greens before commit + manual smoke at 15-row pane height.

DOCS
----
- CHANGELOG.md [Unreleased] under "Fixed":
  * "TUI dashboard no longer renders interleaved card borders / overlapping content on low-row-count panes. The row-budget allocator now culls low-priority cards (Doctor → Recent → Workspaces → …) until the surviving set fits the available rows; a `+N cards hidden · resize taller` hint replaces them at the bottom. An outer height clip on the dashboard container is the final safety net."
- docs/USAGE_GUIDE.md TUI section: short note on the cull behaviour.

OUT OF SCOPE
------------
- Don't change CARD_CONFIGS minRows / maxRows (anti-feature: stable card config).
- Don't add a config to override the cull priority (anti-feature).
- Don't hide the tab strip on small panes (it's already minimal at 1 row; user navigation is critical).
- Don't change the "too small" threshold to be runtime-adjustable (anti-feature).

ORDERING
--------
Block on bug_layout_slot_0_buried_after_slot_fix (worker-2 is on it now). That fix rewrites the column-partition logic; this task uses layoutColumns AFTER its rewrite.

FINAL ACTION
------------
After committing + four greens green + manual smoke at multiple pane heights, close YOUR task with:
  mu task close bug_tui_render_overflow_low_row_pane -w tui-impl --evidence "<sha>: <one-line summary including 'verified clean render at 15-row pane'>"
```

### #2 by "worker-2", 2026-05-12T18:02:09.328Z

```
FILES: src/cli/tui/layout.ts; src/cli/tui/app.tsx; test/tui-layout.test.ts; test/tui-dashboard-layout.test.ts; test/tui-row-budget-overflow.test.ts; docs/USAGE_GUIDE.md; CHANGELOG.md
COMMANDS: npm install exit 0; npm run lint exit 0; npm run typecheck exit 0; npm run test exit 0; npm run build exit 0; node dist/cli.js --help exit 0; node dist/cli.js --version exit 0; manual tmux smoke at 15/5/4 rows exit 0
FINDINGS: low-row panes were allowed past the guard and allocateRowBudgets could return impossible minRows for all cards; React hook guard needed to remain after hooks to avoid hook-count crash when resizing below threshold.
DECISION: added cullCardsForRows, dashboard available-row clipping, hidden-card hint, row-budget cap, and lowered panic threshold to 5 rows.
VERIFIED: full suite green; bundle smoke green; verified clean render at 15-row pane, clean culled render at 5 rows, panic at 4 rows.
ODDITIES: tmux smoke showed tmux window numbering starts at 1 on this host, so pane id targeting was more robust than :0.0.
```

### #3 by "worker-2", 2026-05-12T18:02:09.613Z

```
CLOSE: f96304a: culls low-priority TUI cards on short panes with outer clip; verified clean render at 15-row pane
```
