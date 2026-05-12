// CursorRow — the highlight line shared by every list popup.
//
// Per bug_tui_popup_cursor_highlight_color_leak (workstream
// `tui-impl`): the previous popup pattern wrapped per-cell <Text>
// chunks (color=cyan / bold / dimColor) inside a single
// <Text inverse={sel}>. ink emits an independent ANSI sequence per
// nested <Text>, and inner SGR sequences (color/bold/dim) RESET the
// outer `inverse` state — so the cursor row showed inverse video
// only on bare-text/whitespace cells while every coloured cell broke
// it. Plus the row <Box> was content-sized, so the highlight ended
// at the last character of content rather than spanning the popup
// width.
//
// Fix: when a row is selected, render it as PLAIN TEXT (no per-cell
// palette), join the already-padded cells with the canonical 2-space
// gutter (COL_GUTTER), padEnd to contentWidth, and wrap in a single
// <Text inverse>. The cursor row trades its colour palette for a
// solid full-width highlight — the lazygit / k9s / btop convention.
//
// `wrap="truncate"` matches the cards/popups defensive-belt
// invariant asserted by test/tui-card-render-width.test.ts: every
// outer row-rendering <Text> truncates at the parent's width rather
// than wrapping to a new line.

import { Box, Text } from "ink";
import { COL_GUTTER } from "../columns.js";

export interface CursorRowProps {
  /** Already-padded cells (output of renderRow). */
  cells: ReadonlyArray<string>;
  /** Total available content width (popup body width). */
  contentWidth: number;
}

export function CursorRow({ cells, contentWidth }: CursorRowProps): JSX.Element {
  const gutter = " ".repeat(COL_GUTTER);
  const line = cells.join(gutter).padEnd(Math.max(contentWidth, 0));
  return (
    <Box width={contentWidth}>
      <Text inverse wrap="truncate">
        {line}
      </Text>
    </Box>
  );
}
