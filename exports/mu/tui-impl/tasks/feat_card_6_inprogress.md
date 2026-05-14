---
id: "feat_card_6_inprogress"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: null
created_at: "2026-05-11T13:15:59.334Z"
updated_at: "2026-05-11T15:35:09.033Z"
blocked_by: ["feat_card_header_digit_prefix", "feat_column_aligned_lists"]
blocks: ["feat_more_cards_umbrella", "feat_popup_6_inprogress"]
---

# FEAT: Card 6 — In-progress tasks (claimed + owners); fills the 'what's actually running' glance

## Notes (2)

### #1 by "π - mu", 2026-05-11T15:24:48.285Z

```
GOAL
----
Add Card 6 — In-progress tasks. Slot 6 was reserved in
design_global_keymap. Mirrors Card 5 — Workspaces' shape (commit
264585f95 = the canonical reference impl).

WHY
---
Today the operator must cross-ref:
  - the Agents card (who's busy) +
  - the Ready card (which says nothing about IN_PROGRESS)
to figure out "what's actually running right now". Card 6 is one
glanceable list of every IN_PROGRESS task with id, title, owner,
ROI bucket, and (new dimension) the time-since-claim so you can
tell stale-claims from fresh ones at a glance.

REFERENCE IMPL (look at this first)
-----------------------------------
Read commit 264585f95 — it's the definitive recent example of
"new card slot promoted from reserved" with all the wiring touched.
It demonstrates the EXACT pattern:
  - new src/cli/tui/cards/<name>.tsx (cardId + TitledBox)
  - keys.ts (digit toggleCard)
  - app.tsx (render + cardKey union widening)
  - state.ts in tui (CardVisibility flag default-on)
  - help.tsx (legend digit superscript)
  - test/tui-card-<name>.test.ts (pure-helper + null/empty/populated FC smoke)
  - docs/CHANGELOG.md + docs/ARCHITECTURE.md + AGENTS.md updated

Replicate that pattern.

DATA
----
src/state.ts already exposes WorkstreamSnapshot.inProgress:
  TaskRow[]   // tasks where status = IN_PROGRESS
Each TaskRow has: name, title, status, owner, impact, effort_days,
updated_at (and more — inspect src/tasks.ts TaskRow). Use what's
there; don't extend the SDK unless absolutely required.

For "time since claim": owner-flip events in agent_logs are the
authoritative source, but reading them per row inside the snapshot
loader would be expensive. Cheapest first cut: derive from
TaskRow.updated_at (close-enough as a proxy for "last lifecycle
flip"). Render as relative time (e.g. "2m ago") via the existing
src/cli/format.ts relTime helper if exported, OR pure-format inline.

If you DO need a true claim_at column, file a follow-up task; do
NOT extend the schema in this card task.

CARD LAYOUT
-----------
Columns (column-aligned via src/cli/tui/columns.ts; clipping policy
per feat_column_aligned_lists):

  glyph   id          STATUS   owner       since-claim   title
  PROTECT PROTECT     PROTECT  PROTECT     PROTECT       CLIP

  ⚙       t04_design  IN_PROG  worker-1    3m ago        Design X
  ⚙       review_x    IN_PROG  reviewer-1  12m ago       Review X
  ⚙       cherry_x    IN_PROG  worker-2    34m ago       Cherry-pick X

Glyph: ⚙ for IN_PROGRESS (mirrors STATUS_EMOJI used in agent rows
where applicable — pick whichever matches the existing convention
in cards/agents.tsx; consistency > novelty).

Subtitle pattern (mirror Card 5):
  empty case → "0"
  populated  → "<N>" or "<N> · <K> stale" (where stale = since-claim
               > some threshold, e.g. 15m). Pick a tasteful threshold;
               mu's idle threshold is 5min default per skills/mu —
               5min for "stale" claim is reasonable.

Empty state body: <Text dimColor>(none in progress)</Text>

KEY WIRING
----------
- src/cli/tui/keys.ts: digit '6' was reserved (returns noop today
  per the post-Card-5 commit). Promote it to toggleCard(6). Slots
  7-9 stay reserved.
- src/cli/tui/app.tsx: render <InProgressCard ... /> after the
  Workspaces card; widen cardKeyFromId(6) → "inProgress" (or
  whatever key you use in CardVisibility).
- src/cli/tui/state.ts (the TUI module, not src/state.ts): add
  `inProgress: boolean` to CardVisibility; DEFAULT_CARD_VISIBILITY
  defaults to true.
- src/cli/tui/help.tsx: extend the card-digit prefix string to
  include ⁶ and update the legend ("¹²³⁴⁵⁶ — toggle ...").

POPUP
-----
Shift+6 (^) popup is OUT OF SCOPE for this card task. The umbrella
feat_more_cards_umbrella tracks the matching popup as a follow-up.
Leave Shift+6 as the existing reserved noop in keys.ts.

WHEN THE POPUP DOES SHIP (next task), it MUST follow:
  (a) feat_popup_search_filter — '/' search via usePopupFilter
  (b) feat_track_drill_chains_to_task_drill — Enter chains rows
      into TaskDetailDrill (the Tasks-popup leaf), since rows ARE
      tasks.
Drop a forward-ref note on feat_more_cards_umbrella reminding the
next worker (the umbrella note already has reminders for both
primitives — keep them coherent).

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- Read-only TUI: never executes mutations.
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit: typecheck + lint + test + build.
- Suggested commit:
    tui: add Card 6 — In-progress (slot 6 promoted from reserved)

DOCS
----
- CHANGELOG.md (under v0.4.0): bullet under TUI.
- docs/ARCHITECTURE.md src/cli/tui/ table: extend the cards/* row.
- AGENTS.md repo-layout block: extend the cards/{...} list.

TESTS
-----
- test/tui-card-inprogress.test.ts (NEW): mirror tui-card-workspaces.test.ts:
    pure helpers (sinceClaim formatter, glyphFor, isStale, formatSubtitle)
    + import-graph + null-snapshot smoke + empty + populated.
- test/tui-keys.test.ts: '6' moved from reserved to toggleCard(6);
  digits 7-9 stay reserved.
- test/tui-app.test.ts: import the new card; existing structural
  asserts widen.
- test/tui-app-frame-height.test.ts (now exists from
  bug_tui_render_ghosting_v2): no change needed; it asserts the
  Box props, not the children list.

OUT OF SCOPE
------------
- The Shift+6 popup (umbrella tracks it).
- Schema additions / new SDK columns.
- Live event-stream subscription (the snapshot poll is enough; same
  as every other card).
- A "claim time" history view (a single relative-time column is
  enough for v0).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
  cd $(mu workspace path <agent> -w tui-impl) && \
  mu task close feat_card_6_inprogress -w tui-impl --evidence "<sha + 1-line summary>"
```

### #2 by "worker-3", 2026-05-11T15:35:09.033Z

```
CLOSE: af0f0533dc3ee0223d70503f88efb661332418f4 + tui: add Card 6 — In-progress (digit 6 promoted from reserved); reads snapshot.inProgress, mirrors Card 5 shape, 4 greens (1432 tests pass)
```
