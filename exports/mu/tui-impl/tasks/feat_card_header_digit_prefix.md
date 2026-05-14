---
id: "feat_card_header_digit_prefix"
workstream: "tui-impl"
status: CLOSED
impact: 60
effort_days: 0.1
roi: 600.00
owner: null
created_at: "2026-05-11T13:14:29.018Z"
updated_at: "2026-05-11T14:25:36.430Z"
blocked_by: ["bug_card_header_inset"]
blocks: ["feat_card_5_workspaces", "feat_card_6_inprogress", "feat_card_7_blocked", "feat_card_8_recent", "feat_card_9_doctor", "feat_card_footer_inset", "feat_status_bar"]
---

# FEAT: prefix card section headers with their toggle digit (btop-style: '1 Agents', '2 Tracks', etc.)

## Notes (3)

### #1 by "π - mu", 2026-05-11T13:14:29.370Z

```
btop renders each pane's header as e.g. '1 cpu', '2 mem', '3 net'
where the leading digit IS the toggle key. Same convention here:

  ╭─ 1 Agents · 3 alive ──────╮
  ╭─ 2 Tracks · 1 · 4 ready ──╮
  ╭─ 3 Ready · 5 ─────────────╮
  ╭─ 4 Activity log · last ↑8 ╮

Render the digit slightly differently (yellow/bold) so it reads as a
shortcut, matching the help-overlay's yellow key column.

Fits cleanly into bug_card_header_inset (the TitledBox/header-in-
border task) — natural to do them together. Pairs with the Wave 5
card design notes; effectively one extra prop on each card's header
text.
```

### #2 by "π - mu", 2026-05-11T13:15:07.559Z

```
CORRECTION: btop uses Unicode SUPERSCRIPT digits (¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ⁰),
not plain digits. The superscript visually distinguishes the keybind
from regular header text without needing a separator. Match that:

  ╭─ ¹ Agents · 3 alive ─────╮
  ╭─ ² Tracks · 1 · 4 ready ─╮
  ╭─ ³ Ready · 5 ────────────╮
  ╭─ ⁴ Activity log · ↑8 ────╮

Glyph table (cards 1-9 + reserved 0):
  1 → ¹  (U+00B9)
  2 → ²  (U+00B2)
  3 → ³  (U+00B3)
  4 → ⁴  (U+2074)
  5 → ⁵  (U+2075)
  6 → ⁶  (U+2076)
  7 → ⁷  (U+2077)
  8 → ⁸  (U+2078)
  9 → ⁹  (U+2079)
  0 → ⁰  (U+2070)

Help overlay (help.tsx) should also display these glyphs so the
visual language matches what's on the dashboard.

Implementation: a tiny `superscriptDigit(n: number): string` helper
in titled-box.tsx (or a new src/cli/tui/glyphs.ts if other
superscript/subscript needs surface) returning the right codepoint.
```

### #3 by "worker-2", 2026-05-11T14:25:36.430Z

```
CLOSE: b361acc: glyphs.ts + TitledBox cardId prop + 4 cards + help overlay
```
