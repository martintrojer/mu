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
// FOLLOW-UPS (deliberate seam, NOT shipped here):
//   - feat_card_footer_inset : add an optional `bottomLabel` that
//     renders inside the bottom border line. We do NOT add the prop
//     speculatively (anti-feature pledge: no abstractions for
//     hypothetical future flexibility) — the future task adds it.

import { Box, Text, useStdout } from "ink";
import type { ReactNode } from "react";
import stringWidth from "string-width";
import { superscriptDigit } from "./glyphs.js";

const ROUND = {
  topLeft: "╭",
  topRight: "╮",
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
  children?: ReactNode;
}

/**
 * Compute how many `─` fill characters the top border row needs so
 * the line is exactly `cols` wide. Pure function so a unit test can
 * pin the geometry without spinning up ink.
 *
 * Anatomy of the top row (with all optional pieces present):
 *   ╭ ─ ' ' [digit ' '] title [' · ' subtitle] ' ' [dashes] ╮
 *
 * Per-piece column cost:
 *   ╭             1
 *   ─             1
 *   ' '           1
 *   digit         1 (when cardId set; superscript glyphs are 1 col)
 *   ' ' (sep)     1 (when cardId set)
 *   title         T
 *   ' · '         3 (when subtitle set)
 *   subtitle      S
 *   ' ' (pad)     1
 *   dashes        D
 *   ╮             1
 *
 * Floors at 1 — if the terminal is too narrow, we let the line
 * overflow rather than producing an empty/negative-width fill.
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
  // ╭ + ─ + ' ' + digitCost + T + subCost + ' ' + ╮ = 5 + …
  return Math.max(1, cols - 5 - titleW - subCost - digitCost);
}

export function TitledBox({
  title,
  subtitle,
  cardId,
  borderColor = "gray",
  titleColor = "cyan",
  children,
}: TitledBoxProps): JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const dashes = computeTopRowDashes(cols, title, subtitle, cardId);
  const fill = ROUND.horizontal.repeat(dashes);
  const hasSubtitle = subtitle !== undefined && subtitle.length > 0;
  const digitGlyph = cardId === undefined ? null : superscriptDigit(cardId);

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
        paddingX={1}
        flexDirection="column"
      >
        {children}
      </Box>
    </Box>
  );
}
