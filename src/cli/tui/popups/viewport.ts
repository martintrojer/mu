// Per-render popup viewport sizing — fixes bug_tui_popup_data_doesnt_fill.
//
// Before this helper landed every popup hardcoded
//
//     const VIEWPORT = 20;
//
// at module scope and used it for slice size, scroll-clamp, and
// (in log.tsx) cursor-centring math. After bug_tui_popups_fill_pane
// added flexGrow={1} + width={cols} so the popup Shell occupies
// the full pane, the row data inside the Shell was still capped at
// 20, leaving a band of empty space inside the popup border.
//
// The fix: each popup reads `useStdout().rows` at render time and
// calls `popupViewport(rows[, chromeOverride])` to get the slice
// size. The default `POPUP_CHROME_ROWS` budget (6) accounts for:
//
//   - 2 rows: Shell rounded border (top + bottom)
//   - 1 row: Shell title text
//   - 1 row: marginTop={1} between body and the popup-specific hint
//   - 1 row: the popup-specific hint line
//   - 1 row: <FilterPrompt> when filter is editing OR has a query
//
// (StatusBar at the bottom of <App> is OUTSIDE the popup region —
// `App` height-pins the popup branch above it — so it's not part
// of the popup chrome budget.)
//
// Per-popup overrides: callers that render extra in-body chrome
// (e.g. Workspaces drill's title + dim "(L-T/T)" indicator) pass
// `chromeOverride`. The floor (`POPUP_VIEWPORT_FLOOR`) keeps very
// small terminals usable at the cost of some hint clipping.
//
// Pure helper: no ink/react imports — re-exported separately so
// unit tests can assert boundaries without booting a render tree.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.
// This module is in src/cli/tui/popups/ but uses NO ink primitives;
// it's the seam that lets each popup compute its viewport at render
// time without growing a separate module per popup.

/** Default rows of chrome consumed inside a popup Shell.
 *  Subtracted from `stdout.rows` to get the body slice budget. */
export const POPUP_CHROME_ROWS = 6;

/** Minimum body rows. Keeps very-small terminals usable: at 12
 *  rows we'd otherwise compute 6 → users couldn't see the cursor. */
export const POPUP_VIEWPORT_FLOOR = 8;

/**
 * Compute how many body rows the popup may render given the current
 * terminal height. Pure: no ink, no globals — pass `rows` from
 * `useStdout().stdout?.rows ?? 24` at render time. The optional
 * `chromeOverride` lets popups with extra in-body chrome (e.g.
 * Workspaces drill renders an additional title + indicator pair)
 * subtract more than the default budget.
 *
 * @param rows  total terminal rows (NOT popup rows — caller passes
 *              `stdout.rows` directly; we own the chrome subtraction)
 * @param chromeOverride  override for `POPUP_CHROME_ROWS` (default 6)
 */
export function popupViewport(rows: number, chromeOverride?: number): number {
  const chrome = chromeOverride ?? POPUP_CHROME_ROWS;
  return Math.max(POPUP_VIEWPORT_FLOOR, rows - chrome);
}
