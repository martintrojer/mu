---
id: "bug_tui_card_body_collapses_into_bottom_border"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.3
roi: 250.00
owner: "worker-2"
created_at: "2026-05-12T12:33:10.247Z"
updated_at: "2026-05-12T12:46:29.554Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "feat_tui_commits_card", "review_repo_core_files_past_refactor_signal"]
---

# BUG: card body rows render INTO the rounded bottom border line when total dashboard height is exhausted (Tab-switch trigger; Ready/Tracks cards visibly clobber bottom border with second body row)

## Notes (3)

### #1 by "π - mu", 2026-05-12T12:33:10.594Z

```
SYMPTOM (verbatim user)
-----------------------
"ready card render error might have been triggered by tab switching":

  ╭─ ³ Ready · 2 ──────...─╮
  │ w7c_server_side_mute_notification  ROI 60  ... │
  ╰─w7b_custom_emoji_search_picker     ROI 55  ...─╯

The 2nd body row is rendered INTO the bottom rounded border line (you can see `w7b_...` immediately after the `╰─` corner glyph + dash). Same pattern reported on Tracks card too.

REPRO TRIGGER
-------------
User reports it MAY be triggered by Tab-switching workstreams. Both repro'd cards are tiny (Ready=2 tasks, Tracks=1 row), so the bottomLabel inset code path (cards/ready.tsx:64 `more > 0 ? '+N more · Shift+3' : undefined`) is NOT firing — bottomLabel === undefined. The bottom border is the ink-drawn rounded border, not the inset label.

ROOT-CAUSE HYPOTHESIS
---------------------
TitledBox's body Box has `flexShrink={1}` (commit 65a5fad — bug_tui_dashboard_top_card_scrolls_off fix) which lets Yoga shrink any card. When the dashboard's 9 cards' summed natural height exceeds stdout.rows, Yoga distributes the deficit. For a card with N body rows, Yoga can shrink the body to <N rows. ink's ROUNDED border machinery draws top/sides/bottom around the ALLOCATED area; with body height=1 + 2 children, the SECOND child's text overflows past the body and ink draws the bottom border ON TOP OF / overlapping the overflowing child's character cells.

Visible result: the second body row's text appears INSIDE the bottom border line (between the corner glyphs).

Tab-switch likely TRIGGERS this because the active workstream changes total card heights mid-frame; the prior workstream's heights drove Yoga's allocation; the new workstream's heights overflow into the bottom border on the next render before Yoga rebalances.

POSSIBLE FIXES
--------------

OPTION A: Add `overflow="hidden"` to the inner border Box. ink's overflow=hidden inside a borderStyle="round" Box should clip children to the body area, dropping overflowing rows cleanly instead of overlapping the bottom border. NEEDS VERIFY: does ink's render actually honour overflow on a Boxes with borders?

OPTION B: Force the body Box to render at least minHeight = N (body row count). Prevents Yoga from shrinking below the natural content height. Trades the bottom-card-overflow safety net (the original bug 65a5fad fixed) for the corruption. Net loss.

OPTION C: Drop flexShrink={1} from the inner body Box but keep it on the outer column container. The outer container's overflow=hidden (already in app.tsx) clips at the dashboard level; cards can keep their natural height and bottom-card chrome clips cleanly. Re-introduces the topmost-card-scrolls-off symptom unless Yoga distributes height differently.

OPTION D: Use ink's `overflowY="hidden"` only (not generic overflow). Targets only vertical overflow, may have different render behaviour.

RECOMMEND: Try OPTION A first (one line, smallest change, most precise). If it doesn't fix it, OPTION D. If neither, fall back to per-card maxRows clamping (the recommendation that was already on review_repo_core_files but never shipped because we deferred it).

DIAGNOSTIC RECIPE
-----------------
1. node dist/cli.js state --tui -w tui-impl,gchatui (multi-ws to enable Tab-switch trigger).
2. Press Tab a few times. Watch Ready + Tracks cards.
3. If the 2nd row renders into the bottom border on either, repro confirmed.
4. Toggle Doctor (key 9) off. Test again.
5. Toggle Recent (key 8) off. Test again.
6. With cards 1-7 only, repro should disappear.

If steps 4-5 fix it, the issue is "9 cards + dashboard chrome > stdout.rows" — Cards 8/9 are the heaviest bodies and pushing them off makes the rest fit.

VERIFY (post-fix)
-----------------
1. node dist/cli.js state --tui -w tui-impl,gchatui in a 25-row pane.
2. Tab-switch repeatedly.
3. Every card's bottom border renders cleanly with body content above it (never inside it).
4. With pane resized to 60 rows: full bodies render, no clipping.
5. With pane resized to 12 rows: too-small guard kicks in OR cards clip cleanly at the bottom (last cards' bodies cut, NOT bottom borders inset).

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: card body rows no longer collapse into the rounded bottom
         border when Yoga shrinks card height (was rendering body
         row content INSIDE the ╰── bottom border line)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish): bullet under TUI bugs fixed,
  cross-ref bug_tui_dashboard_top_card_scrolls_off (the prior
  flexShrink fix that introduced this side-effect).

OUT OF SCOPE
------------
- Don't drop flexShrink={1} entirely (it solves the topmost-card-scroll bug).
- Don't ship per-card maxRows in this task (separate refactor).
- Don't add a scrollable dashboard.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_card_body_collapses_into_bottom_border -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "π - mu", 2026-05-12T12:35:55.819Z

```
ADDITIONAL SYMPTOM (verbatim user)
----------------------------------
"cards renders empty row with more hints":

  │ Track 7   ...  │
  │ Track 8   ...  │
  │                │   ← phantom blank body row
  ╰─ +2 more · Shift+2 ──────...──╯

Different from the original bug (body collapsing INTO border): here the card has SPARE vertical space — 8 rows of content but maybe 9 rows of body height — and ink fills the extra row with whitespace inside the rounded border. The bottom-label inset row then sits BELOW that phantom blank.

Both symptoms are facets of the SAME underlying issue: the dashboard's flex layout doesn't always allocate exactly `content rows` to each card body. When it allocates LESS, content overflows into the border (original symptom). When it allocates MORE, blank rows pad the body (new symptom).

POSSIBLE FIX (REVISED)
----------------------
Don't use flexShrink={1} as the safety net for both. Instead:
  - Compute total natural card height across visible cards.
  - Compute available height = stdout.rows - tab strip - status bar.
  - If natural <= available: render each card at natural height (no flex-shrink, no flex-grow). Spare height stays as one trailing flex spacer below the cards (which we already have in app.tsx).
  - If natural > available: deterministically clamp the heaviest cards' bodies to maxRows so the sum fits. Don't rely on Yoga.

This requires a small per-card "naturalRows" function (== children count + chrome) and a layout pass in app.tsx.

OR (SMALLER FIX): keep flexShrink=1, BUT add `height={children-count + 2}` (rows + top-padding-noop + bottom-padding-noop) on the inner body Box when bottomLabel is set, so Yoga has a stronger natural height to anchor to. Body never grows past content; if Yoga still needs to shrink, it shrinks predictably.

OR (SMALLEST FIX, TRY FIRST): set `flexShrink={0}` on the inner body Box (keep on outer container only). The inner body never shrinks below content height; the outer column container with overflow=hidden clips at the dashboard level. Re-introduces the topmost-card-scroll bug ONLY when total card height exceeds dashboard height by enough that even Yoga can't help — which is the scenario the dashboard-clip already handles.

RECOMMEND: try the smallest fix first (flexShrink={0} on inner body Box only). If the topmost-card-scroll bug returns under stress, walk up the option tree.

ALSO IN SCOPE: tracks card row counter shows "1 tasks" instead of "1 task" — singular/plural nit. Fix in cards/tracks.tsx if convenient (line ~70).

⚠️ REVISED FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_card_body_collapses_into_bottom_border -w tui-impl --evidence "<sha + summary covering BOTH symptoms>"
```

### #3 by "worker-2", 2026-05-12T12:46:29.554Z

```
CLOSE: 711e45f: inner TitledBox body flexShrink=0 fixes body/border overlap + bottomLabel blank-row symptom; tests/typecheck/lint/build pass
```
