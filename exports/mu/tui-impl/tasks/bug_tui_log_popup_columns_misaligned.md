---
id: "bug_tui_log_popup_columns_misaligned"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: null
created_at: "2026-05-12T06:21:22.626Z"
updated_at: "2026-05-12T06:53:56.304Z"
blocked_by: []
blocks: []
---

# BUG: Activity log popup (Shift+4) — rows wrap to second line and columns drift across rows; the wrap=truncate fix from bug_tui_log_card_columns_misaligned didn't catch the popup payload-rest cell

## Notes (2)

### #1 by "π - mu", 2026-05-12T06:22:04.164Z

```
SYMPTOM (verbatim user repro)
-----------------------------
mu state --tui -w tui-impl, Shift+4 to open Activity log popup.
Rows wrap to a second terminal line and columns drift across rows:

  │ #4194  16:24:56  π - mu    task note           feat_popup_6_inprogress (note #1268 by π - mu)                                            │
  │ #4195  16:25:01  worker-2  ·                  task.claim    feat_popup_6_inprogress    actor=worker-2    self=0    task claim feat_popup_6_inprogre… │
  │ #4204  16:29:23  system    workspace refresh   worker-3 (backend=git, fromRef=refs/remotes/origin/HEAD, replayed=11)                     │
  │ #4205  16:29:29  system    task add            feat_popup_7_blocked (impact=50, effort=0.2, blocked-by=feat_card_7_blocked,feat_popup_s… │

(line 2 / row #4195 visibly extends past the right border without the
wrap=truncate clipping in.)

WHERE THE wrap="truncate" FIX MISSED
------------------------------------
The earlier bug_tui_log_card_columns_misaligned (commit 209a103)
added wrap="truncate" to the OUTERMOST <Text> in every card and
popup row, INCLUDING src/cli/tui/popups/log.tsx (line 287). So the
outer Text *does* carry wrap="truncate".

But ink's truncate only kicks in when the parent <Box> has a
defined width. In popups/log.tsx the per-row <Box> at line 286
DOES NOT set width={contentWidth}:

  return (
    <Box key={e.seq}>                       ← no width prop
      <Text wrap="truncate">                ← wrap can't engage
        ...

Without width on the parent Box, ink computes the Box width from
its content (which IS the unbounded joined cells), so wrap="truncate"
becomes a no-op — there is nothing to truncate to.

CARDS WORK because they live inside TitledBox, whose inner Box has
width={contentWidth} or paddingX={1} pushing flexbox to fill the
parent. Popups have a hand-rolled Shell in popups/log.tsx (line 314)
whose root Box has width={cols} but the per-row Boxes inside still
inherit ambient width via flex, which is fragile.

ROOT CAUSE — ROW BOXES NEED EXPLICIT WIDTH
------------------------------------------
Every popup file's per-row <Box key=...> needs width={contentWidth}.
Audit:

  src/cli/tui/popups/agents.tsx
  src/cli/tui/popups/blocked.tsx
  src/cli/tui/popups/doctor.tsx
  src/cli/tui/popups/inprogress.tsx
  src/cli/tui/popups/log.tsx          ← user's repro
  src/cli/tui/popups/ready.tsx
  src/cli/tui/popups/recent.tsx
  src/cli/tui/popups/tracks.tsx
  src/cli/tui/popups/workspaces.tsx

Note: cards/*.tsx may have the same latent bug — confirm their
per-row Box also pins width. If layoutColumns is fed a contentWidth
narrower than the rendered row, ink wraps. Pin everywhere.

ALSO: the COLUMN ALIGNMENT DRIFT (different rows starting their
"verb" cell at different x-positions) is a layoutColumns problem.
The padded cells should each be padded to widths[i] before
rendering. Audit popups/log.tsx line 282-296: padded[] comes from
renderRow, which DOES padCell. So columns SHOULD line up. The
visible drift in the user repro is because some rows' rest column
overflows, pushing the visible content past the border, and ink
seems to re-wrap across rows (because no width pin).

→ Fixing the width pin should fix BOTH wrapping AND the visible
  column drift in one shot.

FIX — LINE-PRECISE
------------------
For each popup file, change every per-row outer <Box> from:

  <Box key={...}>

to:

  <Box key={...} width={contentWidth}>

(wrap="truncate" is already on the inner <Text> from prior fix.)

Verify per-card too — same pattern.

VERIFY (CHEAP)
--------------
1. npm run build
2. node dist/cli.js state --tui
3. Shift+4 → activity log popup. Rows must clip (with terminal-
   default truncation glyph or just hard cut) at the right border.
   No wrap to second line. Column boundaries identical across rows.
4. j/k to scroll. Resize the pane narrower. Same expectation.
5. Repeat Shift+1..Shift+9 to confirm every popup is also clipped.

TESTS
-----
- Extend test/tui-card-render-width.test.ts: per-card / per-popup
  static-source assertion that the per-row Box has width={...}
  (contentWidth or cols or contentWidth-derived) — accept any
  defined width identifier; reject empty <Box key=...> { children }.
  This is the regression guard.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file.
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: pin per-row Box width so wrap="truncate" can clip (popup +
         card rows were wrapping past the border because parent
         Box had no width prop)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish): bullet under TUI bugs fixed,
  reference both bug_tui_log_card_columns_misaligned (predecessor)
  and this one.

OUT OF SCOPE
------------
- Don't refactor popups Shell into TitledBox here — that's
  nit_tui_drill_inset_title_and_hints (in flight, worker-3).
- Don't change the gutter convention (still {"  "}).

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_log_popup_columns_misaligned -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-3", 2026-05-12T06:53:56.304Z

```
CLOSE: 85102c6: pin width={contentWidth} on per-row Box in all 9 popups + 9 cards so ink wrap=truncate engages; static-source guard added
```
