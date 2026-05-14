---
id: "bug_tui_drill_scrollview_wraps_long_lines"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.1
roi: 750.00
owner: null
created_at: "2026-05-12T07:14:24.889Z"
updated_at: "2026-05-12T07:18:36.982Z"
blocked_by: []
blocks: []
---

# BUG: DrillScrollView (task-detail / notes / git show / log payload / agent scrollback) line-wraps long body lines, breaking line counter accuracy and visual stability — needs wrap=truncate like every other row Text

## Notes (2)

### #1 by "π - mu", 2026-05-12T07:15:04.974Z

```
SYMPTOM (verbatim user)
-----------------------
"task detail render can line wrap. deal with this somehow"

Visible in any DrillScrollView consumer when a body line exceeds
the magenta drill width:
  - Tasks-popup → Enter → drill (mu task notes <id>): notes that
    contain the SKILL.md verb table, a long URL, or a numbered
    list with long line items wrap mid-paragraph. The wrap bumps
    every subsequent visible line down by one terminal row, so the
    "8 visible lines" we promised actually paint 9-12 terminal
    rows and either overflow the popup or push the bottom hint
    out of frame.
  - Workspaces-popup → Enter → commits → Enter → git show: diff
    lines longer than the drill width wrap; the file-name + hunk-
    header alignment breaks.
  - Log-popup → Enter → drill (full payload): long event payloads
    (workspace refresh, task notes summaries) wrap.
  - Agents-popup → Enter → drill (mu agent read): agent pane
    scrollback lines longer than drill width wrap.
  - Doctor-popup → Enter → drill (remediation paragraph): long
    remediation hints wrap.

The position label in the magenta top border ("L1-72/311") COUNTS
LOGICAL LINES (body.split("
").length) — wrapped lines are not
counted, so the user sees 72 line numbers but the drill paints 90+
terminal rows. The off-by-N in turn breaks the j/k stride (one j
moves one logical line, but visually the cursor seems to jump
multiple rows because previous wraps stretched the pane).

ROOT CAUSE — DRILLSCROLLVIEW HAS NO wrap="truncate"
---------------------------------------------------
src/cli/tui/popups/drill.tsx line 85-90:

    visible.map((ln, i) => (
      <Text key={`${start + i}`}>{ln === "" ? " " : ln}</Text>
    ))

Each line renders as a bare <Text> with ink's default wrap behaviour
("wrap"), which folds long lines onto subsequent terminal rows. Same
class as bug_tui_log_card_columns_misaligned (cards) and
bug_tui_log_popup_columns_misaligned (popup row Boxes) — the fix
already lives in the codebase: add wrap="truncate" + pin the parent
<Box> width.

FIX (single point change)
-------------------------
src/cli/tui/popups/drill.tsx — change the body-line render to:

    <Text key={`${start + i}`} wrap="truncate">{ln === "" ? " " : ln}</Text>

That's it. TitledBox already pins the magenta inner box's width via
its border layout, so wrap="truncate" engages immediately.

VERIFY (CHEAP)
--------------
1. npm run build
2. node dist/cli.js state --tui -w tui-impl
3. Open the Tasks popup (Shift+3), pick any task with multi-paragraph
   notes (the centralisation feedback notes from this session are a
   good test fixture), Enter to drill. Long lines should clip at the
   magenta border instead of wrapping.
4. Same for Workspaces (Shift+5 → Enter → Enter → git show).
5. Same for Log (Shift+4 → Enter).
6. Same for Agents (Shift+1 → Enter → scrollback).
7. Same for Doctor (Shift+9 → Enter on a check with long remediation).
8. After the fix: position counter (1-72/311) becomes faithful — N
   visible logical lines paint exactly N terminal rows.

OPTIONAL FOLLOW-UP — wrap="truncate-end"
----------------------------------------
ink supports wrap="truncate-end" which appends "…" to truncated
lines so the user knows the line was clipped. Default "truncate"
just hard-cuts. Truncate-end is friendlier but eats one column.
Pick truncate-end for drill body since the clip is more
informational than for tabular row data.

Implementer's call: ship "truncate" first (matches the existing
row convention); upgrade to "truncate-end" iff it doesn't break
the position counter math.

ALTERNATIVE — WRAP-AND-COUNT
----------------------------
A more invasive fix: pre-wrap the body to fit drill width before
splitting on 
, so wrapped lines count as separate logical lines
in the position counter and the j/k stride matches what the user
sees. ink doesn't expose its wrap algorithm; the wrap-and-count
path needs string-width + manual wrapping.

REJECT for v0.4: the truncate fix is one-line + matches the rest
of the codebase. wrap-and-count is a separate task and a v0.5
quality-of-life feature if real users ask for it.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- 1500 LOC hard cap per file (drill.tsx is ~110; +0).
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: DrillScrollView body lines clip with wrap="truncate" (was
         line-wrapping, breaking position counter + popup layout
         for any drill body whose lines exceeded the magenta width)

DOCS
----
- CHANGELOG.md (under v0.4.0 polish): bullet under TUI bugs fixed,
  cross-ref bug_tui_log_card_columns_misaligned + 
  bug_tui_log_popup_columns_misaligned (sibling fixes that landed
  on cards / popup rows; this completes the trio for drills).

TESTS
-----
- New test/tui-drill-scrollview.test.ts: static-source assertion
  that the body-line <Text> in src/cli/tui/popups/drill.tsx
  carries wrap="truncate".

OUT OF SCOPE
------------
- Don't add wrap-and-count.
- Don't change DrillScrollView's API surface.
- Don't change the position-counter math.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close bug_tui_drill_scrollview_wraps_long_lines -w tui-impl --evidence "<sha + summary>"
```

### #2 by "worker-3", 2026-05-12T07:18:36.982Z

```
CLOSE: 6c65929: DrillScrollView body <Text> now carries wrap="truncate" so long lines clip at the magenta border instead of wrapping; new test/tui-drill-scrollview.test.ts static-source guard; CHANGELOG entry under [0.4.0] TUI bugs fixed; four greens
```
