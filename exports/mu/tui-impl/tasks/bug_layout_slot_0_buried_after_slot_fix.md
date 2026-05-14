---
id: "bug_layout_slot_0_buried_after_slot_fix"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: "worker-2"
created_at: "2026-05-12T16:58:48.999Z"
updated_at: "2026-05-12T17:36:56.113Z"
blocked_by: []
blocks: ["bug_tui_render_overflow_low_row_pane"]
---

# BUG: layoutColumns() packs cards by group then arrival order — slot 0 (Commits) ends up buried after slot 8 (Recent) in the stream group; right column overflows while left ends early; 2-col layout asymmetric

## Notes (4)

### #1 by "π - mu", 2026-05-12T17:00:18.836Z

```
MOTIVATION (verbatim user)
--------------------------
"after 99f4932211db41ff319efbed3c2dc41b63ba5b0a the tui cards doent reflwo correctly. activity log under commits leaving a non symmetrical look"
[screenshot showed right column: 3, 6, 7, 8, 0, 4 — slot 0 (Commits) buried between Recent (8) and Activity log (4); left column ends at Doctor (9) leaving big vertical gap; 2-col layout visibly asymmetric]

ROOT CAUSE (analysed live)
--------------------------
src/cli/tui/layout.ts layoutColumns() (lines 73-95):

  const small = visible.filter(id => CARD_CONFIGS[id].group === "small-pair");
  const task = visible.filter(id => CARD_CONFIGS[id].group === "task-list");
  const stream = visible.filter(id => CARD_CONFIGS[id].group === "stream");

  if (target === 2) return [small, [...task, ...stream]];

After fix_card_slot_layout_recents_commits_split (commit 99f4932):
  - slot 0 = Commits (group: stream)
  - slot 4 = Activity log (group: stream)
  - slot 8 = Recent (group: task-list, RESTORED to its old role)

`stream` array iterates `visible` in arrival order (0, 4) — Commits first, Activity log second. OK so far.

But `task` ends up [3, 6, 7, 8] and `[...task, ...stream] = [3, 6, 7, 8, 0, 4]`. Recent (8) lands BEFORE Commits (0), and Commits (slot 0, the lowest digit, the LAUNCH-NEW slot) is buried mid-column. User expectation: slot 0 is FIRST.

Secondary issue: left column gets only `small = [1, 2, 5, 9]` (4 cards), right column gets `[3, 6, 7, 8, 0, 4]` (6 cards). Vertical asymmetry.

WHAT THE USER WANTS
-------------------
1. **Slot 0 first.** Commits (slot 0) is the natural leader — lowest digit, recent-history glance.
2. **Symmetric column heights** so the dashboard doesn't look lopsided.

DESIGN
------
Two changes; both in layoutColumns() (pure function — easy to test):

CHANGE A — slot ORDER within a column reflects digit order, not arrival order
-----------------------------------------------------------------------------
After grouping (small / task / stream), sort each group by NUMERIC slot ASCENDING. Slot 0 wins over slot 4 in the stream group; slot 3 wins over slot 6/7/8 in task-list (already true by arrival order BUT make it explicit).

Then concatenate per-column. For 2 cols:
  right = [...task.sort(asc), ...stream.sort(asc)]
       = [3, 6, 7, 8, 0, 4]                         ← still wrong

The concat order itself (task then stream) is what buries Commits. Two options:

  OPTION A1 — interleave by SLOT NUMBER across groups within the same column:
    right = mergeAscending(task, stream)
          = [0, 3, 4, 6, 7, 8]                       ← Commits leads, Activity log next
    Pro: slot order is the user's mental model.
    Con: visual grouping by KIND is lost — task-list cards no longer cluster.

  OPTION A2 — keep groups clustered but reorder the GROUP CONCAT so stream leads:
    right = [...stream.sort(asc), ...task.sort(asc)]
          = [0, 4, 3, 6, 7, 8]                       ← Commits + Activity log first; tasks below
    Pro: keeps "stream cards (recent activity) at top, task lists below" — matches lazygit /
         k9s convention where the LOG / EVENT pane sits ABOVE the resource lists.
    Con: now task-list slot 3 (Ready, the highest-frequency card) is BELOW Activity log.
         Mitigated by CHANGE B (the user mostly wants symmetric heights, so right column
         is shorter overall).

RECOMMEND OPTION A1 (interleave by slot number across groups). Reasoning:
  - The user's locked decisions for slot 0 / 8 / etc were all explicitly DIGIT-based.
  - The user's complaint is "Commits is buried" — they expect slot 0 to lead.
  - The "clustering" intent was an engineer's heuristic, not a user request. Drop it.
  - In every column the cards render in slot-ascending order. Predictable, learnable, debuggable.

For 1 column: trivially sort by slot ascending.
For 3 cols: small / task / stream as today, but each sorted ascending. (OK because each column
            now holds cards of one group; no in-column slot conflict.)
For 4 cols: same as 3 cols logic, with the small group split across two columns. Each column
            sorted ascending.

CHANGE B — column-height balance
--------------------------------
The current 2-col split `[small, [...task, ...stream]]` is hardcoded by GROUP. With 4 small +
6 task/stream cards, the right column is 50% taller than the left. Two ways to balance:

  OPTION B1 — keep the group-based split for 2-col but use the EXISTING row-budget allocator
              (allocateRowBudgets()) to compress the taller column. The allocator already
              has min-row guarantees + max-caps + leftover redistribution. Right column with
              6 cards gets a smaller per-card budget; left with 4 gets more. Vertical
              alignment improves automatically.
              → Probably ALREADY HAPPENING; the screenshot shows the right column with
                ~4-row cards and the left with much taller cards. The visual asymmetry is
                because the LEFT column runs OUT of cards before the bottom, leaving empty
                space. Not a budget bug — a count bug.

  OPTION B2 — when target === 2, balance card COUNT across columns. Don't strictly group;
              put 5 cards in each column. E.g. all 10 visible cards sorted by slot ascending,
              alternate left/right or split halves.
              → Loses the "small cards stack tighter on the left" intent.

  OPTION B3 — when target === 2, keep the small-cards-left convention BUT add stream cards
              to the LEFT column when it would otherwise be much shorter.
              For 9 cards (typical):
                small = [1, 2, 5, 9]  (4 cards)
                task  = [3, 6, 7, 8]  (4 cards)
                stream= [0, 4]        (2 cards)
              Distribute as:
                left  = [...small, ...stream.sort(asc)] = [0, 1, 2, 4, 5, 9]   (6 cards if A1)
                right = [...task.sort(asc)]              = [3, 6, 7, 8]        (4 cards)
              OR more balanced:
                left  = [0, 1, 2, 4, 5]   (5 cards: stream + small minus Doctor)
                right = [3, 6, 7, 8, 9]   (5 cards: task-list + Doctor)
              → Loses the "streams cluster" but achieves balance.

RECOMMEND combining A1 + a revised 2-col B3 split:
  - 2-col left column: [0, 1, 2, 5, 9] (Commits + Agents + Tracks + Workspaces + Doctor)
                       i.e. small-pair + stream cards (the "compact / glance" cluster)
  - 2-col right column: [3, 4, 6, 7, 8] (Ready + Activity log + In-progress + Blocked + Recent)
                        i.e. task-list + the remaining stream
  - 5/5 balance.
  - Slot 0 leads its column. ✓
  - Activity log at slot 4 still leads the task-list cluster on the right. The user's
    complaint about "Activity log under Commits" goes away because they're now in different
    columns.

Re-examining: this is essentially "small + leading-stream LEFT, task-list + trailing-stream RIGHT".
Concretely:
  left  = sortAsc([...small, stream[0]])  = [0, 1, 2, 5, 9]  (the "sidebar")
  right = sortAsc([...task, ...stream.slice(1)]) = [3, 4, 6, 7, 8]  (the "main feed")

For 3-col (180+ cols), 4-col (240+ cols): keep the existing per-group split, just sort each
column by slot ascending (CHANGE A).

For 1-col (<120 cols): sort all visible cards by slot ascending.

LOCKED DECISIONS
----------------
- Within any column, cards render in NUMERIC slot order (0, 1, 2, ..., 9).
- 2-col split puts small-pair + Commits LEFT, task-list + Activity log RIGHT (achieves
  ~5/5 balance and slot 0 leads).
- 3-col / 4-col layouts keep their per-group columns (already balanced enough at those widths).
- 1-col layout = single ascending stack.

WIRING
------
- src/cli/tui/layout.ts layoutColumns():
  * For each grouped array, sort by slot ASC after filter.
  * Replace the 2-col split with the new 5/5 partition (small + stream[0:1] LEFT;
    task + stream[1:] RIGHT). Be careful when stream has 0/1/2+ cards (the user can
    toggle Commits OFF; Activity log can be off too).
  * 3-col and 4-col paths just sort each column ascending; no new partition logic.

- No changes to allocateRowBudgets / columnWidths / cards / app.tsx.

TESTS (REQUIRED)
----------------
- test/tui-layout.test.ts (extend; this is the existing test file for layoutColumns):
  * 2-col, all 10 cards visible: assert left = [0, 1, 2, 5, 9], right = [3, 4, 6, 7, 8].
  * 2-col, slot 0 toggled OFF (Commits hidden): assert left = [1, 2, 5, 9], right = [3, 4, 6, 7, 8].
  * 2-col, slot 4 toggled OFF (Activity log hidden): assert left = [0, 1, 2, 5, 9], right = [3, 6, 7, 8].
  * 2-col, BOTH stream cards off: left = [1, 2, 5, 9], right = [3, 6, 7, 8].
  * 2-col, only slot 3 visible: right = [3], left = [].
  * 1-col, all visible: single column = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] (ascending).
  * 3-col: each column sorted ascending; no slot inversion within a column.
  * 4-col: same.
- test/tui-dashboard-layout.test.ts (extend): walk-introspection that the rendered dashboard
  matches the expected card order per breakpoint.

VERIFY MANUALLY
---------------
Apply, build, then in a tmux pane wide enough for 2-col (~140+ cols):
  node /Users/mtrojer/hacking/mu/dist/cli.js state --tui -w tui-impl
  # Expected: LEFT column has Commits at the top, then Agents/Tracks/Workspaces/Doctor.
  #           RIGHT column has Ready, Activity log, In-progress, Blocked, Recent.
  #           Heights roughly balance.

VERIFY COMMAND
--------------
  npm run typecheck && npm run lint && npm run test && npm run build
ALSO bundle smoke: node dist/cli.js --help && node dist/cli.js --version

CONSTRAINTS
-----------
- Pure function change in layout.ts. No ink/react.
- 1500 LOC hard cap; layout.ts is ~240 LOC; this is a ~30 LOC change.
- Conventional commit prefix: `tui:`
- Suggested commit:
    tui: layout sorts each column by slot ASC; 2-col rebalances stream LEFT (small+Commits) / task RIGHT (lists+log) — fixes Commits buried after Recent + asymmetric column heights post slot-fix
- Four greens before commit + manual smoke at 2-col width.

DOCS
----
- CHANGELOG.md [Unreleased] under "Fixed":
  * "TUI dashboard 2-col layout no longer buries Commits (slot 0) below
    Recent (slot 8); each column now renders cards in numeric slot order
    (0..9 ascending). 2-col split rebalances to small-pair + Commits on
    the left, task-list + Activity log on the right (5/5 instead of 4/6)."
- docs/USAGE_GUIDE.md / docs/ARCHITECTURE.md: short note on the layout
  ordering invariant (cards render in slot-ascending order within each column).

OUT OF SCOPE
------------
- No new card groups / config (anti-feature).
- No mouse interaction (separate task).
- No per-user layout customisation (anti-feature, no config file).
- Don't change CARD_CONFIGS values; only the partition logic.

WORKSPACE
---------
You're in /Users/mtrojer/.local/state/mu/workspaces/tui-impl/<your-name>
(at HEAD = 99f4932 with the regression live).

⚠️ FINAL ACTION ⚠️
After committing + four greens green + manual smoke at 2-col width, close
YOUR task with:
  mu task close bug_layout_slot_0_buried_after_slot_fix -w tui-impl --evidence "<sha>: <one-line summary including 'verified Commits leads the left column at 2-col'>"
DO NOT just say "done" in chat — the orchestrator's `mu task wait` is watching.
```

### #2 by "π - mu", 2026-05-12T17:01:06.167Z

```
REVISION (after user feedback)
------------------------------
"slot 0 should not be on top, bottom is better. but the cards needs to stack nicely when possible"

Locked changes vs the previous design note:
- Slot 0 (Commits) should appear at the BOTTOM of its column, not the top.
- All other slots ascending above it.
- Symmetric / balanced column heights remain the priority.

REVISED ORDERING RULE
---------------------
Within any column, sort by slot number ASCENDING **but with slot 0 placed LAST**.

So the canonical column order is: 1, 2, 3, …, 9, 0.
Equivalently: treat slot 0 as if it were "slot 10" for sort purposes.

Pure helper:
  function compareSlot(a: CardId, b: CardId): number {
    const ka = a === 0 ? 10 : a;
    const kb = b === 0 ? 10 : b;
    return ka - kb;
  }

Apply this comparator to EVERY column at the end of layoutColumns(). Replaces the
"sort by slot ASC" rule from the previous note.

REVISED 2-COL PARTITION
-----------------------
The previous note proposed putting Commits in the LEFT column to lead it. With slot 0
at the BOTTOM, the partition reasoning shifts: we want column heights balanced AND
Commits at the bottom of WHICHEVER column it lands in.

Two equally good options:

  OPTION X — keep current group split, just sort each column:
    LEFT  = small-pair sorted = [1, 2, 5, 9]                   (4 cards)
    RIGHT = (task + stream) sorted with slot 0 last
          = sortWithSlot0Last([3, 6, 7, 8, 0, 4])
          = [3, 4, 6, 7, 8, 0]                                  (6 cards)
    Heights: 4 vs 6 — STILL asymmetric (the original complaint).

  OPTION Y — rebalance to 5/5 with stream cards split, slot 0 at the bottom of its column:
    LEFT  = sortWithSlot0Last([1, 2, 4, 5, 9])  = [1, 2, 4, 5, 9]    (5 cards: small + Activity log)
    RIGHT = sortWithSlot0Last([3, 6, 7, 8, 0])  = [3, 6, 7, 8, 0]    (5 cards: task-list + Commits)
    Heights: 5/5 balanced. ✓
    Slot 0 at the bottom of the right column. ✓
    Activity log (4) sits between small-pair cards on the left — fine; it is a stream
    card and the user already accepts streams cluster differently in different layouts.

  OPTION Z — true 5/5, slot 0 + slot 4 BOTH at the bottom of their respective columns:
    Same as Y but with the "stream" cards (0, 4) explicitly as TRAILERS in their columns:
    LEFT  = small-pair + Activity log trailing = [1, 2, 5, 9, 4]
    RIGHT = task-list  + Commits trailing      = [3, 6, 7, 8, 0]
    Both columns end with a stream card at the bottom — symmetric "footer log" feel.

RECOMMEND OPTION Z. It generalises the user's "slot 0 at the bottom" into a CONVENTION:
"stream cards live at the bottom of their column" (they are footer-log-shaped — the
Activity log and Commits log both fit this mental model). The result:
  - 2-col split is 5/5 balanced.
  - Slot 0 (Commits) at the bottom of the right column.
  - Slot 4 (Activity log) at the bottom of the left column.
  - Symmetric bottom edges.
  - Other cards in slot ASC order above.

CONCRETE LAYOUT (target = 2 cols, all 10 cards visible)
-------------------------------------------------------
  LEFT (5 cards, top → bottom):       RIGHT (5 cards, top → bottom):
    Agents         (1)                  Ready          (3)
    Tracks         (2)                  In-progress    (6)
    Workspaces     (5)                  Blocked        (7)
    Doctor         (9)                  Recent         (8)
    Activity log   (4)                  Commits        (0)

GENERALISED RULE FOR layoutColumns()
------------------------------------
1. Group as before: small-pair / task-list / stream.
2. For 1-col: single column = sortWithStreamLast(all visible).
3. For 2-col: 
     leftSmall  = small-pair (visible)
     rightTask  = task-list (visible)
     leftStream = stream cards whose slot-id is in the LEFT half   (rule below)
     rightStream= the rest of stream
     LEFT  = sortBySlotAsc(leftSmall) ++ sortBySlotAsc(leftStream)
     RIGHT = sortBySlotAsc(rightTask) ++ sortBySlotAsc(rightStream)
   Stream split rule: distribute stream cards in slot-ASC order; ALTERNATE columns
   starting with LEFT. With 2 stream cards (0, 4): slot 4 → LEFT, slot 0 → RIGHT.
   Generalises if more stream cards are added later.
4. For 3-col: small-pair / task-list / stream as today; sort each column by slot-asc;
   stream column already trails by virtue of being its own column.
5. For 4-col: split small into top-pair (1,2) / bottom-pair (5,9); task; stream.
   Each column sort by slot-asc; stream column trails.

Note: the special "slot 0 LAST" rule only matters within a MIXED-GROUP column. With pure
small / task / stream columns (3-col, 4-col), slot 0 ends up alone in the stream column
anyway. So the comparator can stay simple:
  compareSlot(a, b) = (a === 0 ? 10 : a) - (b === 0 ? 10 : b);
…and applied uniformly.

UPDATED TESTS
-------------
- 2-col, 10 cards visible: assert LEFT = [1, 2, 5, 9, 4], RIGHT = [3, 6, 7, 8, 0].
- 2-col, slot 0 OFF: LEFT = [1, 2, 5, 9, 4], RIGHT = [3, 6, 7, 8].
- 2-col, slot 4 OFF: LEFT = [1, 2, 5, 9],   RIGHT = [3, 6, 7, 8, 0].
- 2-col, BOTH stream OFF: LEFT = [1, 2, 5, 9], RIGHT = [3, 6, 7, 8].
- 1-col, all visible: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]    (slot 0 last; rest ascending).
- 3-col, all visible: small=[1,2,5,9], task=[3,6,7,8], stream=[4,0]
  → columns: [[1,2,5,9], [3,6,7,8], [4,0]]
- 4-col, all visible: top-small=[1,2], bottom-small=[5,9], task=[3,6,7,8], stream=[4,0]

EVERYTHING ELSE FROM THE ORIGINAL NOTE STILL APPLIES (constraint set, commit prefix,
manual smoke recipe, docs updates). The OPTION X/Y/Z discussion in the original note
is superseded by the locked decision above (OPTION Z + slot-0-last comparator).

UPDATED SUGGESTED COMMIT
------------------------
  tui: layout sorts each column slot-ASC with slot 0 (Commits) trailing; 2-col rebalances streams across columns so heights match and slot 0 sits at the bottom of its column
```

### #3 by "worker-2", 2026-05-12T17:36:52.235Z

```
FILES: src/cli/tui/layout.ts; test/tui-layout.test.ts; test/tui-dashboard-layout.test.ts; CHANGELOG.md; docs/USAGE_GUIDE.md; docs/ARCHITECTURE.md
COMMANDS: mu task notes bug_layout_slot_0_buried_after_slot_fix -w tui-impl (exit 0); npm run typecheck (exit 0); npm run lint (exit 0); npm run test -- tui-layout.test.ts tui-dashboard-layout.test.ts (exit 0); npm run test (first run hit unrelated/flaky cli-task-wait timeout + vcs tmpdir cleanup, rerun targeted failed files exit 0, full rerun exit 0); npm run build (exit 0); node dist/cli.js --help && node dist/cli.js --version (exit 0); tmux 140-col smoke of node dist/cli.js state --tui -w tui-impl (exit 0)
FINDINGS: Commit 99f4932 put stream cards after task-list cards in 2-col, so right column became [3,6,7,8,0,4] and Commits was buried below Recent with a 4/6 column count split.
DECISION: Implemented revised OPTION Z. Slot 0 compares as trailing. 2-col splits stream cards as trailers: Activity log left, Commits right; 3/4-col keep group columns sorted with slot 0 last; 1-col sorts [1..9,0].
NEXT: none.
VERIFIED: afc32e4; full test suite/typecheck/lint/build green after rerun; bundle smoke green; manual 140-col tmux capture showed LEFT Agents/Tracks/Workspaces/Doctor/Activity log and RIGHT Ready/In-progress/Blocked/Recent/Commits.
ODDITIES: First full test run had two unrelated flaky failures; targeted rerun and full rerun both passed.
```

### #4 by "worker-2", 2026-05-12T17:36:56.113Z

```
CLOSE: afc32e4: layout rebalanced stream trailers; verified Commits sits at bottom of right column at 2-col, 5/5 balance
```
