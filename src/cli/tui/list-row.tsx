// ListRow — the non-selected sibling of CursorRow. Centralises the
// per-row JSX shape every popup and card was hand-rolling.
//
// Per feat_centralize_list_row_render (workstream `tui-impl`): the
// user observed that "the unaligned columns is another example of
// copy-paste smell. we should do all this centrally." Two recent
// bugs (bug_tui_log_card_columns_misaligned and
// bug_tui_log_popup_columns_misaligned) recurred in 18 near-identical
// row JSX blocks because every popup and card was repeating the same
// width pin / gutter / wrap="truncate" / per-cell colour mapping by
// hand. One forgotten attribute → one popup wrapping rows to a
// second line / drifting columns.
//
// ListRow owns four invariants for every list-style row in the TUI:
//   1. width pin on the outer <Box>             — bug_tui_log_popup_columns_misaligned
//   2. canonical {"  "} gutter (COL_GUTTER=2)    — bug class for column drift
//   3. wrap="truncate" on the outer <Text>       — bug_tui_log_card_columns_misaligned
//   4. selected → CursorRow delegation           — single source for cursor highlight
//
// CursorRow stays the highlight primitive; ListRow defers to it
// when `selected` is true. The non-selected branch is now declarative:
// callers pass in already-padded `cells` (output of renderRow) and an
// optional `colors` array of per-cell styling specs. Per-cell color
// styling stays POSSIBLE for the non-selected branch (the cards/popups
// rely on `dimColor`, `bold`, `color="cyan"` etc.); the SELECTED branch
// trades all per-cell colour for a solid-inverse line — same trade-off
// CursorRow already locked in (see cursor-row.tsx header).
//
// The component lives at src/cli/tui/list-row.tsx (sibling of
// columns.ts and titled-box.tsx, NOT under popups/) because both
// popups/* and cards/* consume it. Keeping it at the cluster root
// matches the placement of the other shared primitives.

import { Box, Text } from "ink";
import { COL_GUTTER } from "./columns.js";
import { CursorRow } from "./popups/cursor-row.js";

/** Per-cell styling spec. Mirrors the props ink's <Text> takes for
 *  the colour palette every popup/card was hand-coding. `undefined`
 *  cells (or a missing `colors` array) render as plain text. */
export interface CellColor {
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
}

export interface ListRowProps {
  /** Already-padded cells (output of renderRow). */
  cells: ReadonlyArray<string>;
  /** Total available content width (popup/card body width). */
  contentWidth: number;
  /** Per-cell styling. `colors[i]` applies to `cells[i]`; missing or
   *  `undefined` entries render as plain text. */
  colors?: ReadonlyArray<CellColor | undefined>;
  /** When true, defer to CursorRow (solid-inverse highlight; no
   *  per-cell colour). Routing the selected branch through ListRow
   *  means popup authors never write a `selected ? <CursorRow> :
   *  <Box>...` if-branch by hand. */
  selected?: boolean;
}

export function ListRow({ cells, contentWidth, colors, selected }: ListRowProps): JSX.Element {
  if (selected) return <CursorRow cells={cells} contentWidth={contentWidth} />;
  const gutter = " ".repeat(COL_GUTTER);
  // Build the children list inline so React only sees one array of
  // <Text> nodes interleaved with literal gutter <Text>s. Same shape
  // ink renders today; the difference is that ListRow owns the
  // construction so a future row author can't drift the gutter or
  // forget wrap="truncate".
  const children: React.ReactNode[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i] ?? "";
    if (i > 0) children.push(<Text key={`g${i}`}>{gutter}</Text>);
    const c = colors?.[i];
    if (c === undefined) {
      children.push(<Text key={`c${i}`}>{cell}</Text>);
    } else {
      children.push(
        <Text key={`c${i}`} color={c.color} bold={c.bold} dimColor={c.dimColor}>
          {cell}
        </Text>,
      );
    }
  }
  return (
    <Box width={contentWidth}>
      <Text wrap="truncate">{children}</Text>
    </Box>
  );
}
