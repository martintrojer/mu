---
id: "feat_responsive_layout"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: "worker-2"
created_at: "2026-05-11T13:16:45.777Z"
updated_at: "2026-05-12T15:52:19.875Z"
blocked_by: ["bug_tui_render_ghosting", "bug_tui_top_align", "feat_more_cards_umbrella", "feat_resurrect_state_card"]
blocks: []
---

# FEAT: dynamic responsive layout — reflow cards based on terminal/pane size (e.g. side-by-side wide, stacked narrow)

## Notes (5)

### #1 by "π - mu", 2026-05-11T13:16:46.066Z

```
Today's dashboard stacks all 4 cards in a single column regardless of
terminal width. On a wide tmux pane (e.g. 200+ cols) that wastes a
huge amount of horizontal real estate; cards should arrange in
columns/grids when space allows.

DESIRED BEHAVIOUR (btop / lazygit / k9s convention):

  Narrow (<80 cols):       Medium (80-160):           Wide (>160):
    1 Agents                ┌── 1 Agents ──┬─ 2 Tracks ──┐    2x2 grid
    2 Tracks                │              │             │     1│2
    3 Ready                 │              │             │     ─┼─
    4 Activity log          ├──────────────┴─────────────┤     3│4
                            │ 3 Ready                    │
                            ├────────────────────────────┤   …or 1x4 row at
                            │ 4 Activity log             │   ultra-wide
                            └────────────────────────────┘

EXACT BREAKPOINTS TO PROPOSE (will refine in implementation):
  cols < 60:    1 column (current behaviour)
  60-119:       1 column  (cards already wide enough; stacking still
                          better than cramped 2-col)
  120-179:      2 columns (Agents+Tracks side-by-side; Ready full-width;
                          Activity-log full-width)
  180+:         2x2 grid (each card half-width, half-height ish)

Or, simpler heuristic: aim for each card to have ≥60 cols of internal
width; pack as many columns as fit.

INTEGRATION POINTS:
1. src/cli/tui/app.tsx <Dashboard> currently renders cards in a flat
   <Box flexDirection="column">. Replace with a layout component
   that:
   a. Reads stdout.columns via useStdout.
   b. Buckets cards into N columns per the breakpoint matrix.
   c. Renders each column as a <Box flexDirection="column">; wraps
      them in a <Box flexDirection="row" gap={1}>.
   d. Per-card minWidth/minHeight from design_card_iface honoured —
      a card whose minWidth doesn't fit in its column gets pushed to
      the next break.

2. Cards toggled OFF should not occupy column slots — repack.

3. Resize event handling already added in Wave 7 (useStdout); just
   needs the layout logic plugged in.

INTERACTION WITH OTHER TASKS:
- Lands AFTER feat_more_cards_umbrella ideally (more cards = more
  reason to grid them; the heuristic gets a real workout).
- Does NOT block bug_card_header_inset / feat_card_header_digit_prefix
  (those are per-card render, not layout).
- v0.next "ultra-wide 1x4 row" is a polish stretch goal.

SCOPE GUARDS:
- No config file (no MU_TUI_LAYOUT=…); breakpoints are hardcoded
  per the no-persistence design pillar.
- No Esc-to-resize gesture; reflow happens on terminal SIGWINCH only.
- Popups stay fullscreen (per design_popup_lifecycle); responsive
  layout is dashboard-only.

FOLLOW-ON: feat_responsive_popup_layout (same idea for popups
internal panes — Tasks popup's list/detail split could be 50/50 wide,
80% top + 20% bottom narrow). NOT logged yet; promote when it hits
real friction.
```

### #2 by "π - mu", 2026-05-11T13:36:43.224Z

```
ADDITIONAL SCOPE: dynamic per-card row budget (avoid one card
crowding out the others).

Today each card hardcodes its row limit:
  cards/agents.tsx — no cap (renders all agents)
  cards/tracks.tsx — slice(0, 8)
  cards/ready.tsx  — slice(0, 10) (ROW_LIMIT)
  cards/log.tsx    — slice(0, 8)  (ROW_LIMIT)

Problem: on a workstream with 50 in-progress tasks and 100 events,
the Tasks/Log cards expand vertically (or hit their static cap and
hide everything else). On a workstream with 1 of each, the Agents
card may have all the height to itself and look comically tall.

WANTED: the dashboard divides the available vertical budget across
visible cards proportionally to a card's "weight" (its data size,
clipped to a per-card range). Long lists STILL show the top-N rows
plus a "+M more · open popup (Shift+N)" hint at the bottom — the
popup is always the full-list drill-down per design_card_iface.

ALGORITHM:

  available_rows = stdout.rows - status_bar - chrome
  visible        = cards visible (per visibility flags)
  for each card c in visible:
    natural_rows[c] = min(c.data_count + c.chrome, c.maxRows)
    weight[c]       = clamp(c.data_count, c.minRows, c.maxRows)
  total_weight = sum(weight[c] for c in visible)

  if sum(natural_rows) <= available_rows:
    each card gets natural_rows  # no contention
  else:
    each card gets max(c.minRows, floor(available_rows * weight[c] / total_weight))
    distribute leftover via largest-remainder

  rows_to_render = card_budget - chrome  # i.e. the per-card slice.

PER-CARD CONFIG:
  Each card declares { minRows, maxRows, chrome } in its module.
    chrome = 2 (top border + section header) + 1 (bottom border)
              + 1 (footer "+N more" hint when truncated) = ~4

  Suggested defaults:
    Agents:   minRows=2, maxRows=10  (small lists; rarely huge)
    Tracks:   minRows=2, maxRows=8
    Ready:    minRows=3, maxRows=15  (most-watched; let it grow)
    Log:      minRows=3, maxRows=12  (popup is the place for full log)

WHAT THIS MEANS PER CARD:
  - If the budget says "5 rows of data", the card slices(0, 5) and
    shows "+M more · open popup (Shift+N)" if data.length > 5.
  - If the budget says "20 rows" but the card maxRows=10, it caps
    at 10 (no point over-displaying); the leftover goes to other
    cards in the next reflow pass.

INTERACTION WITH THE OUTER REFLOW:
  - In a 2-column layout (per the breakpoint table above), each
    column gets its own vertical budget; rows split per-column. The
    weighted-share calc runs per column.
  - Toggling a card OFF redistributes its budget to siblings on the
    next render.

WHY THIS MATTERS:
  - Cards are GLANCEABLE. The "+M more" hint is the contract: the
    card never claims to be exhaustive. Popups are exhaustive.
  - Without dynamic balancing, a noisy workstream looks broken (one
    card eats the screen). With it, the dashboard density is constant
    — one of btop's strongest UX properties.

TEST SURFACE:
  - Pure function for the budget allocator (no React); take
    (available_rows, [cards with data_count]) → row_per_card.
    Unit-test against fixtures (1 huge card, 4 even cards, etc.).
  - Verify "+M more" hint text appears when capped.
```

### #3 by "π - mu", 2026-05-12T05:15:59.734Z

```
ADDENDUM (2026-05-11) — USER OBSERVATION ON NATURAL CARD PAIRS
--------------------------------------------------------------
After v0.4 shipped 9 cards (each at full pane width by default),
the user notes that several cards now look "narrow" in a tall pane
because their CONTENT is short (≤8 rows). At reasonable terminal
widths (120-179 cols range from the breakpoint matrix above),
several cards are natural side-by-side pairs:

  PAIR 1 — Agents + Tracks
    Both top-of-dashboard, both small (≤8 rows typical).
    Agents card: agent name + status + owned-task summary + idle.
    Tracks card: track number + leading goal + counts.
    Already paired in the original 120-179 breakpoint suggestion.

  PAIR 2 — Workspaces + Doctor
    Both small (workspaces: per-agent count, typically ≤4 rows;
    doctor: only non-OK checks, typically 0-3 rows).
    Both information-dense per row but row count is bounded.
    Both stay at the same height across ticks (rare to have many
    workspaces or many failing doctor checks). This is the
    cleanest "vertical split" pair on a wide pane.

  PAIR 3 — In-progress + Blocked  (already implicit in the matrix)
    Both task-list cards, both small in a typical workstream.
    Together they answer "what's running + what's stuck".

  STAYS FULL-WIDTH:
    Ready, Recent, Log
    Long lists; benefit from full row width for the title column.

UPDATED BREAKPOINT SUGGESTION
-----------------------------
The previous matrix only handled Agents+Tracks at 120-179. Extend
it to layer the new cards:

   cols < 60:     1 column (single-stack, current behaviour)
   60-119:        1 column (cards still readable stacked)
  120-179:        2 columns:
                    LEFT: Agents | Tracks | Workspaces | Doctor
                          (the four "small" cards stacked)
                    RIGHT: Ready | In-progress | Blocked | Recent | Log
                          (the five "list" cards stacked)
                  → density is roughly balanced; both columns have
                    ~15-30 rows of content typical.
  180-239:        3 columns:
                    LEFT: Agents | Tracks | Workspaces
                    MID: Ready | In-progress | Blocked
                    RIGHT: Recent | Log | Doctor
  240+:           4 columns (rare; matches lazygit on wide monitors)

The exact pairing should still be a PURE FUNCTION over (cols,
visibleCardIds[]) → columnAssignments — easy to unit-test with
fixtures, and easy to tweak later when more cards are toggled
off/on by the user.

PAIR-AWARE PACKING (cheaper than full bin-packing)
--------------------------------------------------
Instead of weight-balancing each render, use a static "preferred
neighbour" tag per card:

  small-pair:  Agents, Tracks, Workspaces, Doctor
  task-list:   Ready, In-progress, Blocked, Recent
  stream:      Log

…then the layout algorithm packs all small-pair cards into the
narrowest column, all task-list cards into the next column, and
stream into its own column when there's room. This is ~30 LOC
vs the full bin-packer's ~200, and it produces visually-stable
layouts (a card doesn't jump columns when its content grows by
one row).

DONT FORGET — THE BOTTOM-INSET HINT FROM feat_card_footer_inset
---------------------------------------------------------------
When a card is in a narrower column, its "+M more · Shift+N"
truncation hint must STILL render correctly inside the bottom
border. TitledBox already handles this via the `bottomLabel` prop
+ `computeBorderRowDashes(cols)` helper (commit 1f25a25). The
helper takes the per-card cols at render time, not the terminal
cols, so it'll naturally narrow with the column. ✓

NUDGE — REVISIT "PER-ROW WORKSTREAM COLUMN" QUESTION
----------------------------------------------------
With 2-3 column layouts AND multi-workstream tabs (commit d0266a3),
re-confirm the existing decision (per the cross-ref note on
feat_tui_multi_workstream): no per-row workstream column on cards.
Tabs encode ws identity; each card is per-tab. Column layout
doesn't change that.
```

### #4 by "worker-2", 2026-05-12T15:52:15.966Z

```
FILES: src/cli/tui/layout.ts; src/cli/tui/app.tsx; src/cli/tui/cards/*.tsx; src/cli/tui/titled-box.tsx; src/cli/tui/padded-rows.tsx; test/tui-layout.test.ts; test/tui-card-row-budget.test.ts; test/tui-dashboard-layout.test.ts; docs/USAGE_GUIDE.md; docs/ARCHITECTURE.md; CHANGELOG.md; skills/mu/SKILL.md
COMMANDS: npm run typecheck exit 0; npm run lint exit 0; npm run test exit 0 (136 files / 2133 tests); npm run build exit 0; node dist/cli.js --help exit 0 with 3337 bytes; node dist/cli.js --version exit 0 with 6 bytes; rg ../../../cli.js in src/cli/tui exit 1 (no matches)
FINDINGS: Dashboard now uses pure pair-aware layout breakpoints and per-column row budgets. Cards declare shared config and accept dynamic budget/column width.
DECISION: Kept Recent popup-only; slot 8 Commits is stream group with Activity log. Row allocator returns body-row budgets and accounts for chrome per column.
NEXT: Popup responsive layout remains out of scope.
VERIFIED: Four greens + bundle smoke after commit 9f32e88.
ODDITIES: Full test suite emits existing agent-name convention hints from fixtures.
```

### #5 by "worker-2", 2026-05-12T15:52:19.875Z

```
CLOSE: 9f32e88: responsive multi-column TUI dashboard with dynamic per-card row budgets; typecheck/lint/test/build + bundle smoke pass
```
