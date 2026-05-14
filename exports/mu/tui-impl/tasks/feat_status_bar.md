---
id: "feat_status_bar"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.2
roi: 375.00
owner: null
created_at: "2026-05-11T13:22:52.742Z"
updated_at: "2026-05-11T14:24:55.859Z"
blocked_by: ["bug_tui_render_ghosting", "bug_tui_top_align", "feat_card_header_digit_prefix", "feat_resurrect_state_card"]
blocks: ["feat_tui_multi_workstream", "tui_impl_complete"]
---

# FEAT: status bar on the bottom line — move tick rate, add key hints, absorb the existing one-liner footer

## Notes (2)

### #1 by "π - mu", 2026-05-11T13:22:53.078Z

```
A single dedicated status row at the very bottom of the dashboard,
btop/lazygit/k9s convention. Replaces the current ad-hoc "footer
line + tick indicator" pair below the cards.

LAYOUT (one row, full pane width):

  ╭─...cards...─╮
  ⁰ reset · ¹/²/³/⁴ toggle · ⇧¹-⁴ open · ?/F1 help · q quit · 1.00s ⏱

Three logical zones:
  LEFT:    last yank line (was the "footer:" — `mu task claim foo …
           [copied]`)
  CENTER:  rotating key-hint cluster (cycle every few seconds OR
           always-shown abbreviated set)
  RIGHT:   tick rate (was the bottom-right indicator)

Use ink's <Box justifyContent="space-between"> for the three
sections; use <Spacer /> if needed.

KEY-HINT FORMAT:
  Show the most useful global keys, abbreviated. lazygit / btop pattern:
    ¹²³⁴ toggle · ⇧¹-⁴ popup · ?/F1 help · q quit · +/- tick · r refresh
  When a popup is open, swap to popup-relevant keys:
    j/k nav · y yank · / filter · Esc close · ? help

DESIGN POINTS:
1. Single row only (1 line tall). No border. dim-coloured by default;
   use bright colour for the single-key glyphs.
2. Move the tick-rate indicator from the current "marginTop=1
   justifyContent=space-between" Box (lines 218-222 of app.tsx) into
   this new bar.
3. Move the "last yank" footer text into this bar's LEFT zone. The
   `[copied]`/`[no clipboard]` suffix stays.
4. Status bar context-switches:
   - Dashboard:   global keys
   - Popup open:  popup-local keys (the popup currently shows these
                  in its body; status bar replaces that, popup body
                  gets cleaner)
   - Help open:   "Esc/?/q close help" (just the dismiss hints)
5. Truncate the LEFT zone (last-yank line) before truncating the
   CENTER zone — the keys are critical, the yank text is recoverable
   via the clipboard.

INTEGRATION:
- Renders below the cards in <App>'s dashboard JSX.
- Renders below the popup in <App>'s popup branch — same component,
  different `mode` prop.
- Renders below the help overlay too.
- Always exactly one line at the bottom; everything else above it.

INTERACTION WITH OTHER TASKS:
- Lands AFTER bug_tui_top_align (alt-screen gives a known fixed
  bottom row).
- Pairs with bug_card_header_inset / digit-prefix work — the digit
  glyphs (¹²³⁴) used in headers should match those used in the
  status bar. Define them ONCE in src/cli/tui/glyphs.ts (or
  similar) and import in both places.
- Replaces the dashboard footer that exists today.
- Inside popups, REPLACES the per-popup "j/k navigate · y yank ·
  Esc/q close" footer text (popups currently render their own;
  with a global status bar, that's redundant and noisy).

COMPONENT SKETCH:
  src/cli/tui/status-bar.tsx
  export type StatusMode = "dashboard" | "popup" | "help";
  export interface StatusBarProps {
    mode: StatusMode;
    tickMs: number;
    footer: FooterState | null;   // last yank
    popupName?: string;           // for the popup mode label, e.g. "Tasks"
  }
  export function StatusBar(props: StatusBarProps): JSX.Element;

ACCEPTANCE:
- Tick rate visible in bottom-right at all times (not absent in any mode).
- Last-yank line visible in bottom-left until cleared with `c`.
- Key hints visible in center; auto-switches with mode.
- Help overlay shows the same content (no surprise when ?/F1).
```

### #2 by "worker-3", 2026-05-11T14:24:55.859Z

```
CLOSE: commit 298ae97: src/cli/tui/status-bar.tsx (3-zone bar with dashboard/popup/help modes), wired into App, popup footers trimmed, +11 tests. All 4 greens (1382/1382 tests).
```
