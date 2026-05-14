---
id: "feat_card_footer_inset"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.1
roi: 600.00
owner: null
created_at: "2026-05-11T13:37:49.527Z"
updated_at: "2026-05-11T19:08:44.969Z"
blocked_by: ["bug_card_header_inset", "feat_card_header_digit_prefix"]
blocks: ["tui_impl_complete"]
---

# FEAT: render '+M more · Shift+N' hint inside the BOTTOM border line of each card (saves a row, mirrors the top-border title)

## Notes (4)

### #1 by "π - mu", 2026-05-11T13:37:50.133Z

```
Same row-saving idea as bug_card_header_inset (title in the top
border) but applied to the bottom edge for the truncation hint:

  ╭─ ³ Ready · 14 ────────────────────────╮
  │  build_x         ROI 100              │
  │  review_x        ROI  60              │
  │  ship_x          ROI  50              │
  ╰── +11 more · ³ ──────────────────────╯
                     ^   ^
                     │   │
                     │   superscript matches the popup-open key
                     │   (per feat_card_header_digit_prefix)
                     dim/grey divider

Today every card renders the "+M more · open popup (ShiftN)" hint
on its OWN row INSIDE the box, costing 1 row of the card's vertical
budget. After feat_responsive_layout's per-card row balancing lands,
that row is much more precious — 1/5th of a card budgeted at 5 rows.

DESIGN:
  - When data.length > visibleRows, render the bottom border with
    inset text instead of plain dashes.
  - Format: `+<M> more · <superscript-digit>` (matches the help
    overlay's key-hint convention).
  - Subdued/dim colour, same border colour family.
  - When data.length <= visibleRows, render the plain bottom border
    (no need for the hint).

INTEGRATION:
  - Lives in src/cli/tui/titled-box.tsx (the same TitledBox primitive
    bug_card_header_inset will introduce). Add a new optional prop
    `bottomLabel?: string` (and matching colours).
  - Cards pass bottomLabel only when truncated; otherwise omit.
  - Component sketch:
       <TitledBox title="³ Ready · 14"
                  bottomLabel={truncated ? `+${more} more · ³` : undefined}>
         {visibleRows.map(...)}
       </TitledBox>

INTERACTION:
  - Lands AFTER bug_card_header_inset (TitledBox primitive must
    exist first).
  - Lands AFTER feat_card_header_digit_prefix (uses the same
    superscript glyph helper).
  - Lands AFTER feat_responsive_layout (only matters once cards have
    a real per-card row budget; until then, the cards have generous
    static caps and rarely truncate).
  - Lands BEFORE feat_more_cards_umbrella (new cards 5-9 should
    consume the bottom-inset hint from day one, not retrofit later).

SCOPE GUARDS:
  - No animations / transitions on the hint appearing/disappearing.
  - The hint takes the SAME superscript glyph as the top-border
    title's leading digit — the visual rhyme is the affordance.
  - If the bottomLabel is too long for the border (rare; "+999 more")
    truncate the rest of the dash-fill, not the label.

POLISH (optional, document but don't ship in v0):
  - When `Enter` is pressed on a card and that card's truncation hint
    is showing, drill into the popup automatically (per
    feat_popup_enter_drill). This is a nice escalation but requires
    cross-task wiring; ship the visual first, escalation later.
```

### #2 by "π - mu", 2026-05-11T13:38:16.253Z

```
CORRECTION: NO superscript in the bottom hint.

The top border's superscript (¹²³⁴) is an affordance for the toggle
key. The bottom hint already SAYS "Shift+N" (or "ShiftN") in plain
text — the superscript would be redundant and visually noisy at the
bottom edge.

Updated format:

  ╭─ ³ Ready · 14 ────────────────────────╮
  │  build_x         ROI 100              │
  │  review_x        ROI  60              │
  │  ship_x          ROI  50              │
  ╰── +11 more · Shift+3 ─────────────────╯

The superscript stays a TOP-edge convention only (key for toggle).
The bottom-edge hint uses plain "Shift+N" so it reads as a literal
keystroke instruction, not a visual flourish.

Component sketch updated:
  <TitledBox title="³ Ready · 14"
             bottomLabel={truncated ? `+${more} more · Shift+${cardId}` : undefined}>
    {visibleRows.map(...)}
  </TitledBox>
```

### #3 by "π - mu", 2026-05-11T16:43:19.630Z

```
PROMOTED — USER REPORT (2026-05-11)
-----------------------------------
The user reports the bug as it ships today (commit 5cccd34 / 1b5c36a):

    │ Track 8     cfp_p_app_refresh_unseen_views_inplace            (1 tasks · 1 ready) │
    │ … +2 more · open Tracks popup (Shift+2)                                            │
    ╰────────────────────────────────────────────────────────────────────────────────────╯

The "+2 more" line is rendered as a BODY ROW INSIDE the rounded
border (consuming a full content row + still showing the bottom
border as a plain `─` fill), instead of being inset into the bottom
border line itself.

Originally this task was blocked by feat_responsive_layout under the
premise that cards rarely truncate without a real row budget. In
practice every card 1-9 already ships with hardcoded N-row caps
(tracks top-8, ready top-10, recent top-N, log fixed-height tail,
…) AND every one of them already renders an in-body "+M more · …"
line. So the bug is observable today, not theoretical.

Unblocking this task; bumping priority by deed.

UPDATED SCOPE
-------------
1. Extend TitledBox (src/cli/tui/titled-box.tsx) with an optional
   `bottomLabel?: string` prop. When set, the BOTTOM border row
   renders the same way the top one renders the title:

       ╭─ ³ Ready · 14 ─────────────────────────╮
       │  build_x         ROI 100               │
       │  review_x        ROI  60               │
       │  ship_x          ROI  50               │
       ╰── +11 more · Shift+3 ──────────────────╯

   Implementation mirrors the existing top-border code path:
   - Build the bottom row ourselves as a single <Text> chunk
     (corner + dash + ' ' + label + ' ' + dash-fill + corner).
   - Set the inner <Box>'s `borderBottom={false}` (currently it sets
     `borderTop={false}`; you'll have BOTH false now).
   - Stack the bottom-row <Text> below the inner Box.
   - Reuse computeTopRowDashes' geometry — split it into a generic
     `computeBorderRowDashes(cols, label)` (no superscript on the
     bottom row per the design correction note above) and call from
     both top + bottom render branches.

2. Update each card to use the new `bottomLabel` prop INSTEAD of
   the in-body "+M more · …" line:

     src/cli/tui/cards/agents.tsx
     src/cli/tui/cards/tracks.tsx
     src/cli/tui/cards/ready.tsx
     src/cli/tui/cards/log.tsx
     src/cli/tui/cards/workspaces.tsx
     src/cli/tui/cards/inprogress.tsx
     src/cli/tui/cards/blocked.tsx
     src/cli/tui/cards/recent.tsx
     src/cli/tui/cards/doctor.tsx

   Each card today computes a `truncated` flag + `<MoreLine />` (or
   inline equivalent) at the bottom of its body. Replace those with:

       <TitledBox title=… subtitle=… cardId={N}
                  bottomLabel={truncated ? `+${more} more · Shift+${N}` : undefined}>
         {visibleRows.map(...)}
       </TitledBox>

   …and DELETE the in-body more-line render branches.

3. Geometry must stay aligned: the bottom row width must match the
   top row width AND the inner Box's content width — same `cols`
   computation. Test with multiple title widths + multiple
   bottomLabel widths.

CONSTRAINTS / DOCS / TESTS
--------------------------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file (TitledBox is ~150 LOC; +30-40 for
  the bottom branch fits well under).
- Conventional commit prefix: tui:
- Four greens before commit.

TESTS
-----
- test/tui-titled-box.test.ts: extend with bottomLabel cases —
  geometry pin + dash-fill width, rendering when subtitle is
  present, the no-bottom-label path is unchanged from the current
  shape (regression guard).
- For each card test file (test/tui-card-*.test.ts): assert that
  the source no longer contains the literal "+ more" / "+ ${more}"
  in-body string — it now lives in the bottomLabel prop. Crude
  regex assertion is enough.

DOCS
----
- CHANGELOG.md (under v0.4.0): bullet under TUI bugs/polish.
- docs/ARCHITECTURE.md src/cli/tui/ table: extend the titled-box.tsx
  description to mention bottomLabel.

OUT OF SCOPE
------------
- Don't add the polish "Enter on a card with bottomLabel auto-drills
  into the popup" — separate task (file follow-up if asked).
- Don't change the popup-mode hint cluster.
- Don't redesign the in-popup `+M more` rendering (popups don't have
  a bottomLabel today; if they need one, separate task).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close feat_card_footer_inset -w tui-impl --evidence "<sha + summary>"
```

### #4 by "worker-2", 2026-05-11T19:08:44.969Z

```
CLOSE: 2bc63d8 — inset '+M more · Shift+N' hint into the bottom border of all 9 TitledBox cards via new bottomLabel prop + computeBorderRowDashes helper; 1590 tests pass
```
