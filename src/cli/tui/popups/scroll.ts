// Shared scroll/navigation primitives for every popup + drill view.
//
// Per feat_centralize_scroll_navigation (workstream `tui-impl`):
// before this module landed, every popup had its OWN switch over
// PopupAction.kind with the same six scroll cases (moveUp / moveDown
// / jumpTop / jumpBottom / pageUp / pageDown). Counted ~60
// near-duplicate switch arms across 9 popups + drill consumers.
// Inevitable drift — `Ctrl-D` half-page only landed in some drill
// branches; `g` / `G` only worked in some modes; tracks.tsx had a
// third copy for its task-detail leaf. This file is the single
// source of truth.
//
// PURE: no ink imports, no React, no DB. Just integer math on
// (cursor | scrollTop) given (action, total, viewport). Trivially
// unit-testable; covered by test/tui-scroll.test.ts.
//
// Two consumer flavours:
//
//   CURSOR-BASED (every popup's LIST mode + tracks task-list drill):
//     a focused row index that the user moves with j/k; visible rows
//     pan around the cursor; Enter on the focused row drills.
//     Use `applyCursor`.
//
//   SCROLL-BASED (DrillScrollView and similar): a scrollTop offset
//     the user pages through; no per-row focus; the body is
//     pre-formatted text (lines). Use `applyScroll`.
//
// Both consume the SAME six action kinds (matches PopupAction's nav
// subset from src/cli/tui/keys.ts), so the popup boilerplate is:
//
//     if (isNavAction(action)) {
//       setCursor((c) => applyCursor(c, action, items.length, viewport));
//       return;
//     }
//     switch (action.kind) { case "yank": ... case "drill": ... }
//
// or for a DrillScrollView:
//
//     if (isNavAction(action)) {
//       setScrollTop((s) => applyScroll(s, action, totalLines, viewport));
//       return;
//     }

/**
 * The six PopupAction kinds that move the cursor or scroll the view.
 * Exact subset of PopupAction from keys.ts — kept structurally
 * compatible so `isNavAction(popupAction)` narrows in-place without
 * a remap.
 */
export type NavAction =
  | { kind: "moveUp" }
  | { kind: "moveDown" }
  | { kind: "jumpTop" }
  | { kind: "jumpBottom" }
  | { kind: "pageUp"; half: boolean }
  | { kind: "pageDown"; half: boolean };

const NAV_KINDS = new Set<string>([
  "moveUp",
  "moveDown",
  "jumpTop",
  "jumpBottom",
  "pageUp",
  "pageDown",
]);

/**
 * Type predicate: is this PopupAction one of the six nav cases? When
 * true, the value is structurally a NavAction and can be passed to
 * applyCursor / applyScroll directly.
 */
export function isNavAction(action: { kind: string }): action is NavAction {
  return NAV_KINDS.has(action.kind);
}

/**
 * Half/full page step. Matches the pre-existing per-popup formula
 * `Math.floor(viewport / (half ? 2 : 1))`. Kept literal so behaviour
 * for tiny viewports (where half=true rounds to 0 → no-op page)
 * matches what shipped before centralisation.
 */
function pageStep(viewport: number, half: boolean): number {
  return Math.floor(viewport / (half ? 2 : 1));
}

/**
 * Clamp a scrollTop offset to [0, max(0, totalLines - viewport)] so
 * the visible slice never falls past the end of the body. Pure;
 * relocated from the previous home in popups/drill.tsx so that
 * applyScroll and the DrillScrollView paint helper can share one
 * implementation.
 */
export function clampScrollTop(scrollTop: number, totalLines: number, viewport: number): number {
  const max = Math.max(0, totalLines - viewport);
  if (scrollTop < 0) return 0;
  if (scrollTop > max) return max;
  return scrollTop;
}

/** Clamp a cursor index to [0, max(0, total - 1)]. */
function clampCursor(cursor: number, total: number): number {
  const last = Math.max(0, total - 1);
  if (cursor < 0) return 0;
  if (cursor > last) return last;
  return cursor;
}

/**
 * Apply a navigation action to a cursor-based view. Returns the new
 * cursor index, clamped to [0, total-1] (or 0 when total === 0).
 *
 *   cursor    current cursor index
 *   action    one of the six NavAction kinds
 *   total     length of the underlying collection (rows / items)
 *   viewport  visible row count — used only for page-step semantics
 */
export function applyCursor(
  cursor: number,
  action: NavAction,
  total: number,
  viewport: number,
): number {
  const last = Math.max(0, total - 1);
  switch (action.kind) {
    case "moveUp":
      return Math.max(0, cursor - 1);
    case "moveDown":
      return Math.min(last, cursor + 1);
    case "jumpTop":
      return 0;
    case "jumpBottom":
      return last;
    case "pageDown":
      return clampCursor(cursor + pageStep(viewport, action.half), total);
    case "pageUp":
      return clampCursor(cursor - pageStep(viewport, action.half), total);
  }
}

/**
 * Apply a navigation action to a scrollTop-based view (e.g.
 * DrillScrollView). Returns the new scrollTop, clamped via
 * clampScrollTop so the bottom of the body never scrolls past the
 * viewport.
 *
 *   scrollTop   current top-of-viewport line index
 *   action      one of the six NavAction kinds
 *   totalLines  length of the underlying body in lines
 *   viewport    visible line count
 */
export function applyScroll(
  scrollTop: number,
  action: NavAction,
  totalLines: number,
  viewport: number,
): number {
  switch (action.kind) {
    case "moveUp":
      return clampScrollTop(scrollTop - 1, totalLines, viewport);
    case "moveDown":
      return clampScrollTop(scrollTop + 1, totalLines, viewport);
    case "jumpTop":
      return 0;
    case "jumpBottom":
      return clampScrollTop(totalLines, totalLines, viewport);
    case "pageDown":
      return clampScrollTop(scrollTop + pageStep(viewport, action.half), totalLines, viewport);
    case "pageUp":
      return clampScrollTop(scrollTop - pageStep(viewport, action.half), totalLines, viewport);
  }
}
