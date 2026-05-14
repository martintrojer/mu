---
id: "nit_tui_status_bar_card_range"
workstream: "tui-impl"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-11T16:41:11.897Z"
updated_at: "2026-05-11T19:00:02.598Z"
blocked_by: []
blocks: ["tui_impl_complete"]
---

# NIT: status bar still says '1-4 toggle' — should be '1-9 toggle' now that all reserved card slots are filled

## Notes (3)

### #1 by "π - mu", 2026-05-11T16:41:57.184Z

```
GOAL
----
Update the status-bar dashboard-mode hint to reflect that ALL nine
reserved card digit slots are now filled (1-9, not 1-4 from when
v0 only had four cards).

LINE-PRECISE EDIT
-----------------
src/cli/tui/status-bar.tsx:84

  -   return \"1-4 toggle · !@#$ popup · ?/F1 help · q quit · +/- tick · r refresh\";
  +   return \"1-9 toggle · !@#$%^&*( popup · ? help · q quit · +/- tick · r refresh\";

(The '?' help part is the sibling nit_tui_remove_f1_help_toggle
task. If that one merges first, your edit only needs the '1-4'→'1-9'
+ glyph-list widening; if you merge first, leave the '?/F1' string
alone here and let that task drop the F1 reference. Pick one
consistent merge order.)

The shifted-glyph cluster '!@#$%^&*(' should be considered for
truncation on narrow terminals — the existing LEFT-zone-drop policy
in status-bar.tsx already handles that, but if the hint cluster
itself is too wide for cols < ~80, the dispatchHint helper may need
a 'narrow' variant. Out of scope: only widen the cluster if the
existing truncation logic still fits on a 60-col pane; if it
doesn't, file a follow-up task instead of bloating this one.

PARALLEL HINT — popup-mode hint
-------------------------------
While editing status-bar.tsx, audit the popup-mode hint cluster
too. The popup-mode hint at line ~111 lists the popup-only
verbs; nothing there says '1-4' so probably no change needed. If
it lists the popup glyphs, widen them too.

DOCS
----
- skills/mu/SKILL.md (if it shows the status-bar hint string): no
  change needed; SKILL.md already lists 1-9 cards in the keymap.
- CHANGELOG.md (under v0.4.0): bullet under TUI nits fixed (or
  fold into the same release-bullet as the rest of the
  status-bar polish).

TESTS
-----
- test/tui-status-bar.test.ts: any case asserting the dashboard
  hint contains the literal '1-4' needs to be updated to '1-9'.
  Same for the glyph-cluster assertion if it pins '!@#$' literally.

CONSTRAINTS
-----------
- ink/react ONLY in src/cli/tui/* (ROADMAP pledge).
- Conventional commit prefix: tui:
- Four greens before commit.
- Suggested commit:
    tui: status-bar dashboard hint reflects 1-9 cards (was 1-4)

OUT OF SCOPE
------------
- Don't redesign the hint copy. One-line surgical edit.
- Don't change the LEFT-zone drop policy.
- Don't change the popup hint glyphs unless they're literally
  wrong.

⚠️ FINAL ACTION ⚠️
After committing, run from the workspace dir:
    mu task close nit_tui_status_bar_card_range -w tui-impl --evidence \"<sha + summary>\"
```

### #2 by "π - mu", 2026-05-11T16:46:45.092Z

```
CORRECTION (2026-05-11) — USE LITERAL 'Shift 1-9'
-------------------------------------------------
The earlier note suggested widening the popup glyph cluster from
'!@#$' to '!@#$%^&*('. The user's preference (verbatim): "no say
literally 'Shift 1-9' much easyer to understand".

The cryptic shifted-glyph cluster is layout-dependent (those glyphs
are the US-keyboard Shift+digit pairs; non-US layouts produce
different post-shift characters per design_global_keymap ODDITY)
AND visually noisy. Plain English wins.

UPDATED LINE-PRECISE EDIT
-------------------------
src/cli/tui/status-bar.tsx:84

  -   return "1-4 toggle · !@#$ popup · ?/F1 help · q quit · +/- tick · r refresh";
  +   return "1-9 toggle · Shift 1-9 popup · ? help · q quit · +/- tick · r refresh";

(Two changes: '1-4' → '1-9'; '!@#$ popup' → 'Shift 1-9 popup'. The
'?/F1 help' → '? help' part is the sibling
nit_tui_remove_f1_help_toggle task; resolve coherently.)

The dashboard-hint <Key>/<Text> rendering at the same call site
(the JSX version below the legacy string return) — if the dashboard
hint is rendered as JSX rather than a literal string, apply the
same change to the JSX:

  BEFORE (JSX form, ~lines 86-92):
    <Key>1-4</Key> <Text dimColor>toggle ·</Text> <Key>!@#$</Key>
    <Text dimColor>popup ·</Text> <Key>?/F1</Key> <Text dimColor>help ·</Text>
    <Key>q</Key> <Text dimColor>quit ·</Text> <Key>+/-</Key>
    <Text dimColor>tick ·</Text> <Key>r</Key> <Text dimColor>refresh</Text>

  AFTER:
    <Key>1-9</Key> <Text dimColor>toggle ·</Text>
    <Key>Shift 1-9</Key> <Text dimColor>popup ·</Text>
    <Key>?</Key> <Text dimColor>help ·</Text>
    <Key>q</Key> <Text dimColor>quit ·</Text>
    <Key>+/-</Key> <Text dimColor>tick ·</Text>
    <Key>r</Key> <Text dimColor>refresh</Text>

WHY 'Shift 1-9' (no '+')
------------------------
The user wrote "Shift 1-9", not "Shift+1-9". Match their spelling
exactly — fewer characters, less visual noise. The popup-mode
sibling task nit_tui_status_bar_popup_shift_range used "Shift+1-9";
update that to "Shift 1-9" too for consistency. (Drop the '+'.)

This applies to:
  - dashboard hint (this task): "Shift 1-9 popup"
  - popup-list hint (sibling task): "Shift 1-9 switch popup"
  - help overlay (src/cli/tui/help.tsx:34, "!@#$" line): swap to
    "Shift 1-9" too — the help overlay should match the status bar
    so the visual language is uniform.

TESTS UPDATED
-------------
- test/tui-status-bar.test.ts: assert dashboard hint contains
  "Shift 1-9" (NOT "!@#$" or "Shift+1-9").
- test/tui-keys.test.ts: still asserts that '!' '@' '#' '$' (and
  '%' '^') open popups — the keymap binding doesn't change, only
  the user-facing hint label. Don't touch the keymap tests.

REMINDER — sibling tasks
-----------------------
- nit_tui_status_bar_popup_shift_range (popup-mode hint): change
  "Shift+1-9" → "Shift 1-9" before shipping.
- help.tsx HelpRow listing keys="!@#$": swap to keys="Shift 1-9".
```

### #3 by "worker-3", 2026-05-11T19:00:02.598Z

```
CLOSE: d163e9d — dashboard hint widened from '1-4 toggle / !@#$ popup' to '1-9 toggle / Shift 1-9 popup' in status-bar.tsx (string + JSX) + help.tsx HelpRow
```
