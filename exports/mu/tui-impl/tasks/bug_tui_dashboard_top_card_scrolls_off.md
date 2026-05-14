---
id: "bug_tui_dashboard_top_card_scrolls_off"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.3
roi: 266.67
owner: null
created_at: "2026-05-12T06:27:23.865Z"
updated_at: "2026-05-12T06:47:17.725Z"
blocked_by: []
blocks: []
---

# BUG: Dashboard topmost card (Agents) sometimes scrolls off the top of the viewport — overflow=hidden fix from bug_tui_tab_switch_stale_render Layer 2 didn't fully cover the single-ws case when total card height > rows

## Notes (2)

### #1 by "π - mu", 2026-05-12T06:28:17.786Z

```
SYMPTOM (verbatim user)
-----------------------
"the first agent card is still (sometimes) scroll 'out of' the
viewport."

This is on the SINGLE-WS dashboard (no multi-ws TabStrip). The
user's frame shows the Agents card top border (╭─ ¹ Agents ─...─╮)
missing, with body rows visible. Same visual class as the
multi-ws TabStrip Layer 2 bug
(bug_tui_tab_switch_stale_render commit 71947a9), but the prior
fix only catches the case where the EXTRA row comes from the
TabStrip.

WHAT'S ALREADY IN PLACE
-----------------------
src/cli/tui/app.tsx dashboard branch (line 342):

    <Box flexDirection="column" height={rows} overflow="hidden">
      <TabStrip ... />          ← null when N=1
      ...9 cards...
      <Box flexGrow={1} />
      <StatusBar ... />
    </Box>

`height={rows}` + `overflow="hidden"` are supposed to clip past the
terminal bottom. They DO clip when overflow exists in the popup +
help branches per the same pattern. But ink's overflow="hidden"
behaviour with flex children is not always "clip below"; in some
ink versions / terminals the OPPOSITE end clips (the child that
overflows gets pushed off the TOP because flexbox tries to honour
flexGrow={1}'s "fill any remaining space" intent and the TabStrip
docs say this can re-anchor the layout).

ROOT-CAUSE HYPOTHESIS — flexGrow={1} SPACER FIGHTS overflow="hidden"
-------------------------------------------------------------------
The frame structure is:
   1. TabStrip (0 or 1 row)
   2..10. nine card components, each ~varies in height
   11. <Box flexGrow={1} />     ← demands "fill remaining space"
   12. StatusBar (1 row)

When the cards' total natural height >= rows-1, the flexGrow={1}
spacer becomes 0-sized (correct). When it's <, the spacer absorbs
the rest (correct).

BUT: ink computes flex child sizes via Yoga. Yoga's overflow
handling for height={N} + flex children is to give children their
natural height first; if children collectively exceed N, Yoga
clips the LAST child past the terminal (i.e. clips the bottom).
HOWEVER: when children include a flexShrink default of 1 and the
parent forces a hard `height`, Yoga can shrink any flex item — and
the FIRST card's <Box> (TitledBox) may have `flexShrink={1}` by
default. The shrink target for the topmost card is then "shrink
the first child by N rows" which can collapse its top border.

OR — more likely — ink's terminal renderer composes the frame as a
diff. When the alt-screen cursor is at row 1 col 1 and the new
frame is rows+1 tall, the FIRST line of the diff goes "above" row
1 and the terminal scrolls one line, dropping the topmost row. The
overflow="hidden" pinned at the root is supposed to prevent ink
from emitting that overshoot — but ink only honours overflow on
INNER children's positioning, not on the rendered byte stream's
total height. So if any single sub-component is taller than its
allocated slot, ink still emits the bytes, the terminal scrolls,
and the topmost frame line is lost.

VERIFY (cheap)
--------------
1. node dist/cli.js state --tui                      # single-ws
2. Resize the terminal so the 9 cards' natural total height
   EXACTLY matches stdout.rows (eyeball — no TabStrip needed).
3. Top border of Agents card MISSING is the bug.
4. Resize +1 row taller: top border reappears.
5. Resize -1 row shorter: top border lost more visibly.
6. Toggle a card off (press '1' to hide Agents): the now-topmost
   card (Tracks) loses ITS top border instead. Confirms the bug
   is "cards collectively don't fit in rows".

ROOT-CAUSE — REAL ANSWER
-----------------------
The 9 cards together have a NATURAL HEIGHT (sum of their own
borders + body lines) that EXCEEDS rows for normal terminal sizes.
Card 9 (Doctor) and Card 8 (Recent) both have multi-row bodies
that grow. There is no per-card height clamp; each card renders
its natural height regardless of the dashboard's budget.

The flexGrow={1} spacer goes to 0 in this case (correct), but the
sum of card heights is > rows-1, so the parent Box's height={rows}
clips. Ink's clip behaviour for a column-flex parent that overflows
is to render past `height`, leaving the terminal to scroll. The
visible result: topmost card loses chrome.

FIX OPTIONS (escalating cost)
-----------------------------

OPTION A — TIGHT: cap card body heights so they fit.
  Each card declares a maxRows budget; the body slices to that.
  Already done for some popups (popupViewport). Apply to cards.
  Cost: per-card prop wiring + body slicing in 9 files. ~50 LOC.

OPTION B — DEFENSIVE: pin every card to flexShrink={1} + minHeight=2
  (border only) so when overflow happens, ink shrinks every card by
  the right number of body rows instead of letting any single card
  exceed its slot. ink's flex algorithm THEN clips the bottom card's
  body, not the topmost card's border.
  Cost: one-line edit in TitledBox or in each card's outer Box.
  Best-bang-for-buck if it works.

OPTION C — RESPONSIVE: feat_responsive_layout (deferred to v0.5).
  Reflow cards into columns on wide terminals; scroll when overflow.
  Out of scope for this bug.

OPTION D — HARD: make the dashboard SCROLLABLE.
  Treat the cards stack like a popup body: render only the visible
  slice, j/k scrolls. Major UX change; out of scope.

RECOMMENDED: OPTION B FIRST. Try wrapping the cards' parent <Box>
(or each card's outer <Box>) with `flexShrink={1}` so Yoga has
permission to shrink them. Verify the topmost card keeps its border
under various terminal heights. If B doesn't fix it (because cards
are TitledBox and TitledBox uses borderStyle which prevents shrink),
fall through to OPTION A: each card has a contentRows prop or a
useTerminalSize-derived clamp.

SECOND RECOMMENDED: Card 8 (Recent) and Card 9 (Doctor) are the
two heaviest. Adding per-card maxRows in just those two MIGHT be
enough. Quick sanity check: temporarily comment out Card 9 in the
dashboard and see if the bug disappears.

INTERACTION
-----------
- Worker-3 is in flight on nit_tui_drill_inset_title_and_hints
  (TitledBox refactor of popup Shells). NOT touching cards. No
  collision.
- Worker-2 is in flight on bug_tui_inprogress_recent_drill_viewport_clipped
  (popup VIEWPORT consts). NOT touching cards. No collision.
- This bug is best done after both land so the worker has a stable
  base for adding per-card sizing.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: dashboard cards no longer scroll the topmost border off
         when total card height > rows (added per-card flexShrink /
         maxRows clamp; ink's overflow=hidden was insufficient on
         its own when a flex child exceeded its slot)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish): bullet under TUI bugs fixed,
  cross-ref bug_tui_tab_switch_stale_render Layer 2 (the
  TabStrip-only sibling).

OUT OF SCOPE
------------
- Don't ship feat_responsive_layout here (deferred, v0.5).
- Don't add a scrollable dashboard.
- Don't change the overflow="hidden" pin (it's still needed; the
  issue is per-card overflow, not the parent Box's overflow).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_dashboard_top_card_scrolls_off -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-3", 2026-05-12T06:47:17.725Z

```
CLOSE: 84084e6: pin flexShrink=1 + overflow=hidden on TitledBox outer Box (Option B); also rolled forward Layer-2 dashboard-root overflow=hidden from main since this workspace's parent ref pre-dates 71947a9. 4 greens; new tui-app-frame-height.test.ts assertions guard both invariants.
```
