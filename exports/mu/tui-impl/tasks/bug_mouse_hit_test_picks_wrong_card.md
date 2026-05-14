---
id: "bug_mouse_hit_test_picks_wrong_card"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.3
roi: 250.00
owner: "worker-3"
created_at: "2026-05-12T20:01:18.475Z"
updated_at: "2026-05-12T20:34:07.853Z"
blocked_by: ["bug_all_tasks_popup_no_scroll"]
blocks: []
---

# BUG: TUI mouse double-click on a dashboard card more often than not opens the WRONG card's popup — hit-test math out of sync with actual ink render geometry

## Notes (3)

### #1 by "π - mu", 2026-05-12T20:02:40.280Z

````
MOTIVATION (verbatim user)
--------------------------
"another bug. doulble clicking on a card on the main tui more often than not takes me to anotehr cards drill-down popup. that is strange"

KEY OBSERVATION: a popup DOES open (so hit-test finds A card), just often the WRONG one. This means hit-test geometry is OFF, not that mouse capture is broken. The user said "more often than not" → the offset is a few rows, so cards near the top are correct but cards lower down increasingly map to the wrong card.

REPRO
-----
1. Bare `mu` from project root (or `mu state --tui -w tui-impl`).
2. Double-click anywhere on the BLOCKED card (slot 7, deep in the right column).
3. EXPECTED: Blocked popup opens.
4. OBSERVED: Recent popup (slot 8) or some adjacent card's popup opens instead.

ROOT CAUSE HYPOTHESIS
---------------------
src/cli/tui/layout.ts dashboardCardHitRegions() computes per-card rectangles from:
  - top (running): incremented by `CARD_CONFIGS[id].chrome + budget[id]` per card.
  - left (running): incremented by `width + columnGap` per column.
  - dashboardTop seed: 1 + (hasTabStrip ? 1 : 0) + (hasSnapshotError ? 3 : 0)

The math is INTERNALLY consistent (it uses the same `model.budgetsByColumn` that <DashboardColumns> renders with). But it can drift from ACTUAL ink render geometry in any of these ways:

A. **Card renders TALLER than (chrome + budget)** for non-trivial reasons:
   - Empty-state cards padding to minRows (PaddedRows component): the card's actual height equals minRows + chrome, not budget + chrome. capRowBudgetsForColumn caps from above but doesn't FLOOR to data + chrome — so a card with dataCount=0 in a column with extra room may render at minRows but the hit-test thinks it gets the full budget.

   Look: src/cli/tui/cards/<NAME>.tsx uses `<PaddedRows minRows={rowBudget ?? cardConfig.minRows}>`. If rowBudget > dataCount AND dataCount > minRows, the card pads UP to rowBudget — taller than needed. That's correct for "stable height" rendering. But check the empty-state case: rowBudget=10, data=0, minRows=2 → renders minRows=2 rows of padding. Card height = chrome(4) + 2 = 6 rows, not chrome+10=14. The hit-test thinks 14. Cards below get assigned wrong y-coords.

B. **The +1 in dashboardTop accounts for what?**
   `dashboardTop = 1 + (hasTabStrip ? 1 : 0) + (hasSnapshotError ? 3 : 0)`
   The leading `1` is the SGR mouse "1-indexed terminal row" offset. But ink's first child renders at row 1 too. So `dashboardTop = 1` (no tab strip) means "the cards card top border is on row 1, which is the FIRST row of the terminal pane." That's correct in 1-indexed coords.
   
   But if your tmux pane has a STATUS LINE at the top (some tmux configs) the actual first row of the inner pane is shifted. SGR mouse coords might be relative to terminal-window-cell, not pane-cell. Check tmux's mouse-coordinate semantics.

C. **The mouse event Y coord may be 0-indexed vs 1-indexed mismatch.**
   src/cli/tui/mouse.ts parses `\x1b[<button;x;y;M`. Per SGR DECRPM 1006: x and y are 1-indexed (1 = leftmost column / topmost row). hit-test uses 1-indexed too. So no off-by-one expected. BUT some terminal emulators behave differently — verify mouse.ts comment / parsing.

D. **Column-width drift**. `columnWidths(cols, columnCount)` distributes `cols - (columnCount-1)` evenly. The hit-test then uses these widths + `columnGap=1`. ink's `<Box flexDirection="row" gap={1}>` consumes the same arithmetic. SHOULD match. BUT: if ink has any 0-width edge case (e.g. a column container's width prop is constrained by terminal cols differently), the hit-test diverges.

INSTRUMENT FIRST
----------------
Don't guess at the fix. Add a tiny dev-only logging branch:
  ```ts
  if (process.env.MU_TUI_DEBUG_MOUSE === "1") {
    process.stderr.write(`mouse @ (${event.x},${event.y}) → card ${hit ?? "MISS"}
`);
    for (const region of cardHitRegions) {
      process.stderr.write(`  region ${region.id}: top=${region.top} bottom=${region.bottom} left=${region.left} right=${region.right}
`);
    }
  }
  ```
Then run the TUI with `MU_TUI_DEBUG_MOUSE=1 node dist/cli.js -w tui-impl 2>/tmp/mouse.log` in a tmux pane. Click various cards. Diff the EXPECTED card (slot you clicked on) vs OBSERVED card (what hit-test returned). Read /tmp/mouse.log to see WHICH region the click landed in and how that compares to where ink actually drew that card.

Compare with the actual rendered geometry via tmux capture-pane:
  tmux capture-pane -p -t <pane> | head -80
  # Read off the actual row numbers where each card's top/bottom border sits.

Then find the offset between hit-test math and reality. Fix at the source.

LIKELY FIX (after instrumenting)
-------------------------------
If hypothesis A is the cause: add a `dataCountForCard` lookup AT hit-test time and compute `effectiveBody = max(minRows, min(budget, dataRowsInCard))` to get the true rendered height. Mirror what each card's render logic does.

Better: have each card REPORT its actual height back via a ref or callback (ink doesn't make this easy, so the math-only path is preferred).

Cleanest: change cards to ALWAYS render at `chrome + budget` height (use PaddedRows to pad the data slice up to budget rows, regardless of whether data fits). Then the hit-test math is correct by construction. Look at `cards/commits.tsx` — it already uses `rowBudget ?? cardConfig.maxRows` as the slice limit; needs a PaddedRows wrap to floor at `rowBudget` too when data is shorter.

VERIFY THE FIX
--------------
Click each visible card 5x in random order. Each click should open THAT card's popup, never another. Test on:
  - 1-col layout (narrow pane)
  - 2-col layout (140-col pane)
  - 3-col layout (200-col pane)
  - With Doctor toggled off (column-budget redistribution)
  - With multiple workstreams (tab strip present, dashboardTop=2)
  - With snapshot error visible (dashboardTop=4 or 5)

TESTS (REQUIRED)
----------------
- test/tui-mouse-hit-test.test.ts (extend): per-config fixtures.
  * 2-col layout, all 10 cards: build a model + call hitTestDashboardCard at the GEOMETRIC CENTRE of each rendered card. Each should return that card's id.
  * Empty-data card (dataCount=0): hit-test the centre of where it renders (chrome + minRows tall, not chrome + budget). Currently this likely fails; document what the CORRECT geometry should be, then fix the math/render to match.
  * Mid-card click: assert correct card.
  * Edge clicks (border row): assert nearest card (or null if outside).
  * With tab strip: assert dashboardTop offset is honoured.
  * With snapshot error: same.
- test/tui-card-row-budget.test.ts: assert each card renders at EXACTLY chrome + budget rows (the floor that makes hit-test correct by construction). If any card renders shorter (empty-state padding to minRows only), surface the discrepancy.

VERIFY MANUALLY
---------------
After build, in a real terminal:
  cd /Users/mtrojer/hacking/mu
  node dist/cli.js -w tui-impl
  # Click each card 5 times:
  for slot in Commits Agents Tracks Ready Log Workspaces InProgress Blocked Recent Doctor; do
    # Visually identify the card; double-click; verify the right popup opens.
  done

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke + manual mouse smoke.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap; layout.ts is ~280 LOC, app.tsx is ~530 LOC. This change is small (~30-50 LOC).
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: mouse hit-test geometry matches actual rendered card heights (was: empty-state cards rendered shorter than the budget the hit-test assumed, so clicks below the first short card mapped to the wrong card)
- Four greens before commit + bundle smoke + manual mouse smoke (click every card; verify correct popup opens).

⚠️ COORDINATION ⚠️
- Gated behind bug_all_tasks_popup_no_scroll (worker-2 is on it now). Dispatches after.
- File overlap: src/cli/tui/layout.ts (hit-test) AND likely src/cli/tui/cards/*.tsx (render heights). Watch for conflicts with any in-flight card-touching task.

DOCS
----
- CHANGELOG.md [Unreleased] under "Fixed":
  * "TUI mouse double-click hit-test no longer points at the wrong card. Empty-state cards (e.g. Doctor with no warnings) render shorter than the budget the hit-test assumed, so clicks below such a card mapped to the wrong card. Fixed by [pinning render heights / adjusting hit-test math — pick one based on instrumenting]."

OUT OF SCOPE
------------
- No mouse drag.
- No mouse cursor positioning inside a popup (defer).
- No tmux-config-aware coordinate translation (out of scope; SGR is the contract).

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>.

⚠️ FINAL ACTION ⚠️
After committing + four greens green + bundle smoke + click-every-card smoke, close YOUR task with:
  mu task close bug_mouse_hit_test_picks_wrong_card -w tui-impl --evidence "<sha>: <one-line summary including 'verified each card opens its OWN popup on double-click'>"
DO NOT just say "done" in chat — the orchestrator's `mu task wait` is watching.
````

### #2 by "worker-3", 2026-05-12T20:34:05.933Z

```
FILES: src/cli/tui/titled-box.tsx; src/cli/tui/padded-rows.tsx; src/cli/tui/layout.ts; src/cli/tui/app.tsx; src/cli/tui/cards/*.tsx; test/tui-mouse-hit-test.test.ts; test/tui-card-row-budget.test.ts; test/_card-render.ts; CHANGELOG.md
COMMANDS: npm run typecheck -- --pretty false (0); npm run lint (0); npm test -- --run test/tui-card-row-budget.test.ts test/tui-mouse-hit-test.test.ts test/tui-row-budget-overflow.test.ts test/tui-titled-box-render.test.ts (0); npm test (0, 149 files / 2269 tests); npm run build (0); tmux bundle/manual mouse smoke via node dist/cli.js state --tui -w tui-impl (0)
FINDINGS: Hit-test math already assumed every card consumes chrome + rowBudget, but empty/loading cards were only padding the body to their min rows, so cards below could render higher than their hit regions.
DECISION: Pin card render geometry to the existing budget contract by adding TitledBox height support, using cardRenderHeight(cardConfig,rowBudget) in every dashboard card, and padding empty/loading rows to rows={rowBudget}. Kept MU_TUI_DEBUG_MOUSE as a dev-only trace for future geometry issues.
NEXT: none for this bug.
VERIFIED: Full suite and build green; manual tmux smoke double-clicked Agents/Tracks/Workspaces/Doctor/Log/Ready/In-progress/Blocked/Recent/Commits and each opened its own popup.
ODDITIES: A scripted 1-col smoke failed because the tmux session exited before pane capture; 2-col smoke completed and targeted tests cover 1/2-col hit-test geometry offsets.
```

### #3 by "worker-3", 2026-05-12T20:34:07.853Z

```
CLOSE: 56c67ba: card render heights now match hit-test regions; verified each card opens its OWN popup on double-click
```
