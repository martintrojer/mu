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
// size. The default `POPUP_CHROME_ROWS` budget (3) accounts for:
//
//   - 2 rows: Shell rounded border (top + bottom)
//   - 1 row: <FilterPrompt> when filter is editing OR has a query
//
// Title + per-popup hint no longer cost body rows after
// nit_tui_drill_inset_title_and_hints — both inset into the top
// and bottom border lines respectively (Layer 1 of that fix), so
// the budget drops from 6 to 3. Drill bodies pick up ~3 extra
// visible rows for free. (StatusBar at the bottom of <App> is
// OUTSIDE the popup region — `App` height-pins the popup branch
// above it — so it's not part of the popup chrome budget.)
//
// Per-popup overrides: callers that render extra in-body chrome
// (e.g. Workspaces drill's title + dim "(L-T/T)" indicator) pass
// `chromeOverride`. The floor (`POPUP_VIEWPORT_FLOOR`) keeps very
// small terminals usable at the cost of some hint clipping.
//
// `popupViewport(rows[, chromeOverride])` is a PURE helper (no ink,
// no globals) so unit tests can assert the chrome math without
// booting a render tree. The matching `usePopupViewport()` ink hook
// (below) wraps it so every popup is one line:
//
//     const viewport = usePopupViewport();
//
// instead of the boilerplate trio of `useStdout`, `stdout?.rows ??
// 24`, and a `popupViewport(...)` call. Both ship from the same
// module because the hook IS the centralisation seam — splitting
// them would just make every popup import twice.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.
// This module is in src/cli/tui/popups/, so the hook's `useStdout`
// import is in-bounds.

import { useStdout } from "ink";

/** Default rows of chrome consumed inside a popup Shell.
 *  Subtracted from `stdout.rows` to get the body slice budget.
 *  Was 6 before nit_tui_drill_inset_title_and_hints; dropped to 3
 *  once the title (top border) and per-popup hint (bottom border)
 *  stopped costing body rows. */
export const POPUP_CHROME_ROWS = 3;

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
 * @param chromeOverride  override for `POPUP_CHROME_ROWS` (default 3)
 */
export function popupViewport(rows: number, chromeOverride?: number): number {
  const chrome = chromeOverride ?? POPUP_CHROME_ROWS;
  return Math.max(POPUP_VIEWPORT_FLOOR, rows - chrome);
}

/**
 * Ink hook: returns the popup body viewport for the current render.
 * Wraps `useStdout()` + the `stdout?.rows ?? 24` fallback + the
 * `popupViewport()` chrome math so every popup is one line:
 *
 *     const viewport = usePopupViewport();
 *
 * Pass `chromeOverride` when the popup renders extra in-body chrome
 * (e.g. Workspaces drill's title + indicator pair); otherwise the
 * default `POPUP_CHROME_ROWS` budget applies.
 *
 * Replaces the prior per-popup boilerplate AND fixes the
 * inprogress + recent drill regression where a stale module-scope
 * `const VIEWPORT = 20` was clipping notes below the popup's full
 * pane height (bug_tui_inprogress_recent_drill_viewport_clipped).
 */
export function usePopupViewport(chromeOverride?: number): number {
  const { stdout } = useStdout();
  return popupViewport(stdout?.rows ?? 24, chromeOverride);
}
