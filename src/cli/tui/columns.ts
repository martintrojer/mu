// columns.ts — column-alignment helpers for the TUI cards/popups.
//
// Per feat_column_aligned_lists (workstream `tui-impl`) and the
// design_card_*/popup_* notes (workstream `tui`): rows in every card
// and popup were rendered as free-flowing `<Text>` chunks separated by
// single spaces. With variable-width fields (agent names, task ids,
// status tokens, ROI numbers) they drifted visually and were hard to
// scan. Match the static `mu task list` / `mu agent list` convention:
// each column gets a fixed width based on the widest cell across the
// visible rows, then we pad with spaces.
//
// Why no ascii grid borders inside the rounded card: the outer
// rounded border is the only structural element; rows are just padded
// text. Anything more (vertical bars, header rules) would compete
// with the rounded frame.
//
// Width counting: `string-width` (transitive via cli-table3) handles
// emoji / CJK / ANSI escapes correctly; bare `String.length` is wrong
// for status glyphs (✓ ⚠ ⊕ ⋈) and for any future i18n.
//
// Clipping policy: cells fall into two buckets per the task notes —
// PROTECTED (task ids, agent names, status tokens, glyphs, ROI nums,
// timestamps, event verbs) which must never be clipped because the
// user yanks them verbatim; and CLIPPABLE (titles, payloads, role
// descriptions, goal lists, notes previews) which degrade gracefully
// under truncation. layoutColumns() respects the bucket: protected
// cells take their natural width unconditionally, clippable cells
// share whatever budget is left.

import stringWidth from "string-width";
import { truncate } from "../format.js";

export type ColumnKind = "protect" | "clip";

export interface ColumnSpec {
  /** "protect" — never clip; "clip" — truncate to share remaining budget. */
  kind: ColumnKind;
  /** Default "left". "right" pads on the left (numeric columns). */
  align?: "left" | "right";
  /** Optional minimum width (default 0). */
  min?: number;
  /** Optional maximum natural width to consider when sizing protected
   *  columns — useful when a single rogue row would balloon the
   *  column. Default: no cap. */
  max?: number;
}

/** Display width of `s`, ignoring ANSI escapes and counting wide chars. */
export function cellWidth(s: string): number {
  return stringWidth(s);
}

/** Pad `s` to width `n` with spaces. align="right" pads on the left.
 *  No-op if the cell is already wider than `n` (no clipping here;
 *  callers that need clipping should run truncateCell first). */
export function padCell(s: string, n: number, align: "left" | "right" = "left"): string {
  const w = cellWidth(s);
  if (w >= n) return s;
  const pad = " ".repeat(n - w);
  return align === "right" ? pad + s : s + pad;
}

/** Truncate `s` to display width ≤ `n`, appending `…` if clipped.
 *  Wraps src/cli/format.ts truncate() but uses string-width for the
 *  threshold check so emoji / wide chars don't false-pass. */
export function truncateCell(s: string, n: number): string {
  if (n <= 0) return "";
  if (cellWidth(s) <= n) return s;
  // format.truncate works on `.length`; for ASCII titles (the
  // dominant case) this matches display width. For wide-char cells
  // we round down: chip 1 more codepoint at a time until we fit.
  let candidate = truncate(s, n);
  while (cellWidth(candidate) > n && candidate.length > 1) {
    candidate = truncate(candidate, candidate.length - 1);
  }
  return candidate;
}

/** Compute the natural (max-cell) width of every column across rows. */
export function naturalWidths(rows: ReadonlyArray<ReadonlyArray<string>>): number[] {
  if (rows.length === 0) return [];
  const ncols = Math.max(...rows.map((r) => r.length));
  const widths = new Array<number>(ncols).fill(0);
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) {
      const cell = r[i] ?? "";
      const w = cellWidth(cell);
      if (w > (widths[i] ?? 0)) widths[i] = w;
    }
  }
  return widths;
}

/** Per-column padding between cells, in the rendered output. Two
 *  spaces is the convention used by `mu task list` / `mu agent list`
 *  (cli-table3 uses one + a vertical bar; we drop the bar). */
export const COL_GUTTER = 2;

/** Convert a terminal-column count (`process.stdout.columns`) into the
 *  content-area width inside a TitledBox / popup Shell.
 *
 *  Both containers stack the same chrome on each side:
 *    - 1 col rounded border
 *    - 1 col paddingX
 *  → 2 cols per side, 4 cols total — subtract from the outer width.
 *
 *  Floored at 0 so very narrow terminals (cols < 4) don't drive a
 *  negative budget into layoutColumns; the App.tsx terminal-too-small
 *  guard (cols < 40) is the visible last resort.
 *
 *  Per bug_tui_long_lines_overflow: every card/popup needs to pass
 *  the resulting contentWidth to layoutColumns so clip columns
 *  actually clip instead of overflowing the row to a second line.
 *
 *  Why `process.stdout.columns` and not the `useStdout()` hook:
 *  card/popup FCs are also called as plain functions in unit tests
 *  (no ink renderer mounted, so React hook context is null), and
 *  ink already re-renders the entire tree on SIGWINCH so the bare
 *  property read is current at render time. */
export function termColsForLayout(): number {
  return process.stdout.columns ?? 80;
}

export function contentWidthFromCols(cols: number): number {
  return Math.max(0, cols - 4);
}

/**
 * Compute the final width allocated to each column, given:
 *   - rows         the cell matrix (post-string conversion)
 *   - specs        per-column kind/align/min/max
 *   - totalWidth   total renderable width of the row (the inside of
 *                  the rounded border, i.e. terminal cols minus
 *                  border + paddingX). When undefined we just use
 *                  the natural widths (no clipping).
 *
 * Algorithm:
 *   1. Natural width per column.
 *   2. Apply per-column min/max caps.
 *   3. If totalWidth is undefined, return as-is.
 *   4. Otherwise, sum the protected widths + gutters.
 *   5. Distribute the remainder across clippable columns:
 *      - Equal share by default.
 *      - The LAST clippable column absorbs any rounding leftover.
 *   6. If even the protected cells overflow the budget, return the
 *      natural widths anyway — App.tsx's terminal-too-small guard is
 *      the last resort, and the dashboard layout will visually clip
 *      regardless.
 */
export function layoutColumns(
  rows: ReadonlyArray<ReadonlyArray<string>>,
  specs: ReadonlyArray<ColumnSpec>,
  totalWidth?: number,
): number[] {
  const natural = naturalWidths(rows);
  const widths = specs.map((spec, i) => {
    const nat = natural[i] ?? 0;
    let w = nat;
    if (spec.min !== undefined && w < spec.min) w = spec.min;
    if (spec.max !== undefined && w > spec.max) w = spec.max;
    return w;
  });

  if (totalWidth === undefined) return widths;

  const ncols = specs.length;
  const gutters = ncols > 1 ? (ncols - 1) * COL_GUTTER : 0;
  const protectedSum = specs.reduce(
    (acc, s, i) => (s.kind === "protect" ? acc + (widths[i] ?? 0) : acc),
    0,
  );
  const remaining = totalWidth - protectedSum - gutters;
  const clipIdx = specs.map((s, i) => (s.kind === "clip" ? i : -1)).filter((i) => i >= 0);

  if (clipIdx.length === 0) return widths;
  if (remaining <= 0) {
    // Protected cells alone overflow; give clippable cols 0 each
    // so they collapse rather than push the row arbitrarily wide.
    for (const i of clipIdx) widths[i] = 0;
    return widths;
  }

  // Sum of clippable natural widths; if they fit, leave them as-is.
  const clipNaturalSum = clipIdx.reduce((acc, i) => acc + (widths[i] ?? 0), 0);
  if (clipNaturalSum <= remaining) return widths;

  // Equal share per clippable column.
  const each = Math.floor(remaining / clipIdx.length);
  const leftover = remaining - each * clipIdx.length;
  for (let k = 0; k < clipIdx.length; k++) {
    const i = clipIdx[k];
    if (i === undefined) continue;
    widths[i] = each;
  }
  // Anchor the row visually: hand any leftover to the LAST clippable
  // column (typically the title / payload).
  const lastIdx = clipIdx[clipIdx.length - 1];
  if (lastIdx !== undefined && leftover > 0) widths[lastIdx] = (widths[lastIdx] ?? 0) + leftover;
  return widths;
}

/**
 * Render one row of cells to display strings: clip clippable cells
 * to their allocated width, then pad every cell to its column width.
 * Returns one string per column — callers map into individual <Text>
 * chunks so per-cell colour still works.
 */
export function renderRow(
  cells: ReadonlyArray<string>,
  widths: ReadonlyArray<number>,
  specs: ReadonlyArray<ColumnSpec>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const w = widths[i] ?? 0;
    const raw = cells[i] ?? "";
    if (spec === undefined) {
      out.push(raw);
      continue;
    }
    const clipped = spec.kind === "clip" ? truncateCell(raw, w) : raw;
    out.push(padCell(clipped, w, spec.align ?? "left"));
  }
  return out;
}
