---
id: "bug_tui_agents_card_still_scrolls_off"
workstream: "tui-impl"
status: CLOSED
impact: 80
effort_days: 0.3
roi: 266.67
owner: null
created_at: "2026-05-12T10:18:26.711Z"
updated_at: "2026-05-12T11:07:19.203Z"
blocked_by: []
blocks: []
---

# BUG: Agents card top row STILL scrolls outside the viewport — bug_tui_dashboard_top_card_scrolls_off (commit 65a5fad: flexShrink + overflow=hidden) didn't fully fix it; user re-reports the symptom

## Notes (2)

### #1 by "π - mu", 2026-05-12T10:18:27.027Z

```
SYMPTOM (verbatim user)
-----------------------
"agent card top row still renders outside the viewport"

After commit 65a5fad shipped (added overflow=hidden to all three frame branches AND flexShrink={1} to TitledBox), the user is STILL seeing the topmost card's top border scroll off.

DIAGNOSTIC — WHAT 65A5FAD DID + WHY IT'S NOT ENOUGH
---------------------------------------------------
Look at src/cli/tui/app.tsx + src/cli/tui/titled-box.tsx and verify:
  (a) overflow="hidden" is on the dashboard root <Box height={rows} flexDirection="column">.
  (b) TitledBox's outer Box / inner Box has flexShrink={1}.

If both are true, ink's flex algorithm SHOULD let Yoga shrink the cards to fit. But the user reports it's not happening. Possible causes:
  - flexShrink={1} is on the wrong Box (outer vs inner of TitledBox).
  - A card's body has hardcoded height that defeats shrink (cards/recent.tsx, cards/doctor.tsx have multi-row bodies — check for any `height={N}` prop).
  - Card 9 (Doctor) when populated with many rows pushes the natural sum way past `rows` and Yoga shrinks the LAST card's body but the topmost card was already pushed off the visible viewport because the parent Box's overflow="hidden" CLIPS at the bottom (correct) but the PARENT IS STILL EMITTING the rows past `height` first (terminal scrolls).

REPRO RECIPE FOR DIAGNOSIS
--------------------------
1. node dist/cli.js state --tui (in a real TTY).
2. Resize the pane until the bug shows (probably ~25 rows tall + 9 cards visible).
3. Press 9 to toggle the Doctor card off — does the bug disappear?
4. Press 8 to toggle Recent off — same?
5. If the bug ONLY shows when both 8 + 9 are on, the cause is "natural card heights sum to > rows, Yoga's shrink doesn't help any card stay non-overflowing".

POSSIBLE FIXES (escalating cost)
--------------------------------

OPTION A: per-card maxRows clamp. Card 8 (Recent) + Card 9 (Doctor) explicitly clamp their body slice to a configurable max (e.g. 8 rows like the static `mu state` card uses). 9 small per-card edits.

OPTION B: the dashboard root needs to not just `overflow="hidden"` but actively render in REVERSE so the BOTTOM clips, not the TOP. Test: swap the children order. If the bottom clips and topmost stays visible, the issue is just the rendering anchor.

OPTION C: add a guard rail at the dashboard render site that filters which cards to render based on their natural-height sum vs the available height. If sum > height, drop low-priority cards (Doctor + Recent first). Visible-by-priority instead of all-9.

The 4-greens fix from 65a5fad assumed Yoga could always shrink children. The empirical user feedback says Yoga can't shrink TitledBox enough (rounded borders + paddingX make minimum height = 3 per card; 9 cards × 3 = 27 minimum > most pane heights).

⚠️ This is INDEPENDENT of bug_tui_drill_text_no_width_pin (sibling task) — implementer can grab them in parallel; no file collision.

VERIFY
------
After fix:
  - Single-ws TUI in a 25-row pane: every card top border visible OR cards visibly clipped at the bottom (graceful degradation), never the top.
  - Toggle cards on/off — topmost card always renders fully.
  - Resize pane: cards re-flow without losing the topmost border.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: dashboard topmost card border STAYS visible when 9 cards
         exceed pane height (commit 65a5fad's flexShrink+overflow
         pair was insufficient — Yoga can't shrink TitledBox below
         border+padX minimums)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish): bullet under TUI bugs fixed,
  cross-ref bug_tui_dashboard_top_card_scrolls_off (the prior
  attempt) and bug_tui_tab_switch_stale_render Layer 2 (the original
  multi-ws TabStrip variant).

OUT OF SCOPE
------------
- feat_responsive_layout (deferred to v0.5).
- Don't add a scrollable dashboard.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_agents_card_still_scrolls_off -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "π - mu", 2026-05-12T11:07:19.203Z

```
CLOSE: 5e334f6: cascade-fixed by drill nested-TitledBox drop. The original symptom (topmost card border scrolls off) was caused by wrapped long lines pushing the card-stack height past the viewport; with the wrap fix, lines clip and total card height stays within bounds. User confirmed visually.
```
