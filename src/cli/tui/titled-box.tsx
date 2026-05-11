// TitledBox — a rounded-border container whose section header sits
// INSIDE the top border line (lazygit / htop / btop convention)
// instead of consuming a row of body content.
//
//   ╭─ ¹ Agents · 3 free ───────────────────────╮
//   │  ✓ worker-1   free   build_x   —          │
//   │  ⚙ worker-2   busy   review_x  —          │
//   ╰───────────────────────────────────────────╯
//
// IMPLEMENTATION
//
// ink v5 has no `borderTitle` prop, so we render the top border row
// ourselves as a single <Text> (corner + dash + ' ' + [digit + ' '] +
// title [+ ' · ' + subtitle] + ' ' + dash-fill + corner) and stack a
// second <Box> below with `borderTop={false}` so ink's normal border
// machinery draws the side+bottom edges and corners.
//
// To keep the manual top row aligned column-for-column with the body
// Box's bottom border, both pieces share an explicit `width` derived
// from `useStdout().columns`. v0 only stacks cards vertically (full
// pane width); a future responsive-layout task can either (a) pass
// an explicit `width` prop down or (b) wrap each cell in a width-
// pinned Box. The pure helper `computeTopRowDashes` is exported so
// either layout strategy can re-use the geometry.
//
// CARD-DIGIT PREFIX (feat_card_header_digit_prefix)
//
// Cards pass `cardId` so a Unicode superscript form of the toggle key
// (¹ ² ³ ⁴ … ⁰) is rendered in yellow before the title. This mirrors
// btop / htop, where the leading digit IS the toggle key. The help
// overlay uses the same glyphs so the visual language matches.
//
// BOTTOM-BORDER INSET (feat_card_footer_inset)
//
// Cards optionally pass `bottomLabel` to render the truncation hint
// ("+11 more · Shift+3") INSIDE the bottom border line, mirroring the
// top-border title:
//
//   ╭─ ³ Ready · 14 ─────────────────────────╮
//   │  build_x         ROI 100               │
//   │  review_x        ROI  60               │
//   │  ship_x          ROI  50               │
//   ╰─ +11 more · Shift+3 ───────────────────╯
//
// Per the design correction in the task notes: NO superscript /
// digit prefix on the bottom row — the label already says "Shift+N"
// in plain text, and the superscript is a top-edge convention
// (toggle-key affordance). When set, the inner Box's bottom border
// is suppressed (`borderBottom={false}`) and a hand-rendered Text
// row is stacked below it, exactly mirroring the top-row code path.
// Geometry is shared via the pure helper `computeBorderRowDashes`.

import { Box, Text, useStdout } from "ink";
import type { ReactNode } from "react";
import stringWidth from "string-width";
import { superscriptDigit } from "./glyphs.js";

const ROUND = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
} as const;

export interface TitledBoxProps {
  /** Bold/coloured headline text (e.g. "Agents"). */
  title: string;
  /** Optional dim subtitle rendered after " · " (e.g. "3 free"). */
  subtitle?: string;
  /** Optional 0..9 toggle key. When set, the matching superscript
   *  glyph is rendered in yellow before the title (btop convention). */
  cardId?: number;
  /** Border colour. Cards default to "gray"; popups/help to "cyan". */
  borderColor?: string;
  /** Title colour (the bold part). Defaults to "cyan". */
  titleColor?: string;
  /** Optional inset label rendered inside the BOTTOM border line
   *  (feat_card_footer_inset). Cards pass it only when the body is
   *  truncated; otherwise omit and the bottom border renders as
   *  plain dashes. NO superscript prefix here per the design
   *  correction — the bottom-edge convention is a literal keystroke
   *  hint ("Shift+3"), not a toggle affordance. */
  bottomLabel?: string;
  children?: ReactNode;
}

/**
 * Generic geometry helper for ANY border row that insets a single
 * label between the corner+dash prefix and the dash-fill+corner
 * suffix. Used by both the top-border (where the "label" is the
 * effective width of title + subtitle + cardId composed) and the
 * bottom-border (where the label is the raw bottomLabel string).
 *
 * Anatomy: `╭─ <label> <dashes>╮`  (top)
 *          `╰─ <label> <dashes>╯`  (bottom)
 *
 * Per-piece column cost (5 fixed + label + dashes):
 *   corner        1
 *   ─             1
 *   ' '           1
 *   label         L
 *   ' '           1
 *   dashes        D
 *   corner        1
 *
 * Floors at 1 — if the terminal is too narrow, we let the line
 * overflow rather than producing an empty/negative-width fill.
 */
export function computeBorderRowDashes(cols: number, label: string): number {
  return Math.max(1, cols - 5 - stringWidth(label));
}

/**
 * Top-border specialization: composes title + ' · ' + subtitle and
 * an optional leading digit prefix into the effective label width,
 * then delegates to `computeBorderRowDashes`. Pure function so a
 * unit test can pin the geometry without spinning up ink.
 *
 * Per-piece column cost (relative to the generic 5-fixed base):
 *   digit         1 (when cardId set; superscript glyphs are 1 col)
 *   ' ' (sep)     1 (when cardId set)
 *   title         T
 *   ' · '         3 (when subtitle set)
 *   subtitle      S
 */
export function computeTopRowDashes(
  cols: number,
  title: string,
  subtitle?: string,
  cardId?: number,
): number {
  const titleW = stringWidth(title);
  const subW = subtitle === undefined || subtitle.length === 0 ? 0 : stringWidth(subtitle);
  const subCost = subW === 0 ? 0 : 3 + subW; // ' · ' + S
  const digitCost = cardId === undefined ? 0 : 2; // digit + ' '
  return Math.max(1, cols - 5 - titleW - subCost - digitCost);
}

export function TitledBox({
  title,
  subtitle,
  cardId,
  borderColor = "gray",
  titleColor = "cyan",
  bottomLabel,
  children,
}: TitledBoxProps): JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const dashes = computeTopRowDashes(cols, title, subtitle, cardId);
  const fill = ROUND.horizontal.repeat(dashes);
  const hasSubtitle = subtitle !== undefined && subtitle.length > 0;
  const digitGlyph = cardId === undefined ? null : superscriptDigit(cardId);
  const hasBottomLabel = bottomLabel !== undefined && bottomLabel.length > 0;
  const bottomDashes = hasBottomLabel ? computeBorderRowDashes(cols, bottomLabel) : 0;
  const bottomFill = ROUND.horizontal.repeat(bottomDashes);

  return (
    <Box flexDirection="column" width={cols}>
      <Text color={borderColor}>
        {ROUND.topLeft}
        {ROUND.horizontal}{" "}
        {digitGlyph !== null ? (
          <>
            <Text bold color="yellow">
              {digitGlyph}
            </Text>{" "}
          </>
        ) : null}
        <Text bold color={titleColor}>
          {title}
        </Text>
        {hasSubtitle ? (
          <>
            <Text color={borderColor}> · </Text>
            <Text dimColor>{subtitle}</Text>
          </>
        ) : null}{" "}
        {fill}
        {ROUND.topRight}
      </Text>
      <Box
        borderStyle="round"
        borderColor={borderColor}
        borderTop={false}
        borderBottom={!hasBottomLabel}
        paddingX={1}
        flexDirection="column"
      >
        {children}
      </Box>
      {hasBottomLabel ? (
        <Text color={borderColor}>
          {ROUND.bottomLeft}
          {ROUND.horizontal} <Text dimColor>{bottomLabel}</Text> {bottomFill}
          {ROUND.bottomRight}
        </Text>
      ) : null}
    </Box>
  );
}
