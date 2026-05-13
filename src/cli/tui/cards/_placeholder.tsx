// CardPlaceholder — shared scaffolding for card loading + empty
// (and other one-line) body branches.
//
// Before this helper, every card under src/cli/tui/cards/*.tsx
// repeated a near-identical 10-line block for its loading branch
// AND for its empty branch:
//
//   <TitledBox
//     height={cardRenderHeight(cardConfig, rowBudget)}
//     width={cols}
//     title="<Title>"
//     cardId={N}
//   >
//     <PaddedRows rows={rowBudget ?? cardConfig.minRows}>
//       <Text dimColor>loading…</Text>      {/* or "(none ...)" */}
//     </PaddedRows>
//   </TitledBox>
//
// That's 20+ blocks across 10 files, all carrying the same chrome
// pattern (height = chrome + rowBudget; PaddedRows = rowBudget ??
// minRows). Adding a new card-level chrome attribute (e.g. a per-
// card border colour, a new bottom-label rule for empty-state)
// required editing every block. Now there's one knob.
//
// USAGE
//   return CardPlaceholder({
//     title: "Agents", cardId: 1,
//     rowBudget, cols,
//     config: cardConfig,
//     subtitle,                 // optional (omit for loading; threaded
//                               //   through for empty/healthy paths
//                               //   that already compute one)
//     text: "loading…",         // dim text body (most common case)
//   });
//
// For richer bodies (e.g. an inline code hint that interpolates a
// workstream name, or the doctor "✓ 12 checks" line with a coloured
// glyph), pass `children` (a ReactNode) instead of `text`. The helper
// only injects the dimColor wrapper when `text` is used; `children`
// is rendered verbatim so the caller controls every Text node.
//
// CALLED AS A FUNCTION, NOT AS JSX
//   Card render functions invoke `CardPlaceholder({...})` directly
//   instead of `<CardPlaceholder .../>`. This matches how test
//   helpers (test/_card-render.ts) treat the cards themselves: they
//   call `AgentsCard({snapshot})` and walk the returned JSX tree.
//   If we used JSX, the test walker would see a `<CardPlaceholder>`
//   element with the helper's prop names (text, config, rowBudget),
//   none of which it knows how to render — the title/height/rows
//   it greps for would be hidden one synthetic-component level
//   deeper. Calling the helper as a function eagerly evaluates it
//   to the underlying `<TitledBox>` tree, keeping the existing
//   walker contract intact.
//
// PURE WRAPPER, ZERO BEHAVIOUR DRIFT
//   The rendered output is byte-identical to the hand-rolled
//   blocks: same TitledBox prop set, same PaddedRows row count,
//   same single-Text body. Tests that grep for title + body text
//   via renderCardToText are unchanged.

import { Text } from "ink";
import type { ReactNode } from "react";
import { type CardRowConfig, cardRenderHeight } from "../layout.js";
import { PaddedRows } from "../padded-rows.js";
import { TitledBox } from "../titled-box.js";

export interface CardPlaceholderProps {
  /** Card title (e.g. "Agents"). Bold/coloured headline. */
  title: string;
  /** 0..9 toggle key — yellow superscript glyph before the title. */
  cardId: number;
  /** Card's static row config (CARD_CONFIGS[id]); used for both the
   *  fixed outer height (chrome + rowBudget) and the PaddedRows
   *  fallback when the dashboard hasn't allocated a row budget yet
   *  (i.e. minRows). */
  config: CardRowConfig;
  /** Dashboard-allocated body row budget. Undefined → use minRows. */
  rowBudget?: number;
  /** Outer width in terminal columns; threaded through to TitledBox. */
  cols?: number;
  /** Optional dim subtitle rendered after " · ". */
  subtitle?: string;
  /** Body text, rendered as a single <Text dimColor>{text}</Text>.
   *  Mutually exclusive with `children`; if both are passed, `children`
   *  wins (the richer-JSX path). */
  text?: string;
  /** Body ReactNode for richer renders (inline code hint, multi-Text
   *  doctor healthy line, …). Rendered verbatim — the caller controls
   *  every wrapping Text node. */
  children?: ReactNode;
}

export function CardPlaceholder({
  title,
  cardId,
  config,
  rowBudget,
  cols,
  subtitle,
  text,
  children,
}: CardPlaceholderProps): JSX.Element {
  return (
    <TitledBox
      height={cardRenderHeight(config, rowBudget)}
      width={cols}
      title={title}
      subtitle={subtitle}
      cardId={cardId}
    >
      <PaddedRows rows={rowBudget ?? config.minRows}>
        {children ?? <Text dimColor>{text}</Text>}
      </PaddedRows>
    </TitledBox>
  );
}
