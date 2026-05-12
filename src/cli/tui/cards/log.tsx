// Activity-log card — fixed-height tail of the most recent N events
// from agent_logs. Auto-updates on every tick (no scroll-pause needed
// at the card level; the popup handles full scroll-pause behaviour).
//
// Per design_card_log (workstream `tui`).
//
// Aesthetic: rounded border, dim border, section header inset; verb
// prefix coloured cyan via classifyEventVerb.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: timestamp, source, verb
// are PROTECTED (short, identity-bearing); the rest is CLIPPABLE.

import { Text } from "ink";
import { classifyEventVerb, displayEventPayload } from "../../../logs.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { CARD_CONFIGS, cardRenderHeight } from "../layout.js";
import { ListRow } from "../list-row.js";
import { PaddedRows } from "../padded-rows.js";
import { TitledBox } from "../titled-box.js";

export interface LogCardProps {
  snapshot: WorkstreamSnapshot | null;
  rowBudget?: number;
  cols?: number;
}

export const cardConfig = CARD_CONFIGS[4];

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // ts (HH:MM:SS)
  { kind: "protect" }, // source
  { kind: "protect" }, // verb (or '·' fallback)
  { kind: "clip", min: 1 }, // rest / payload
];

export function LogCard({ snapshot, rowBudget, cols }: LogCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(cols ?? termColsForLayout());
  if (snapshot === null) {
    return (
      <TitledBox
        height={cardRenderHeight(cardConfig, rowBudget)}
        width={cols}
        title="Activity log"
        cardId={4}
      >
        <PaddedRows rows={rowBudget ?? cardConfig.minRows}>
          <Text dimColor>loading…</Text>
        </PaddedRows>
      </TitledBox>
    );
  }

  const { recent } = snapshot;

  if (recent.length === 0) {
    return (
      <TitledBox
        height={cardRenderHeight(cardConfig, rowBudget)}
        width={cols}
        title="Activity log"
        cardId={4}
      >
        <PaddedRows rows={rowBudget ?? cardConfig.minRows}>
          <Text dimColor>(no events yet)</Text>
        </PaddedRows>
      </TitledBox>
    );
  }

  // Show the LAST N events (newest at the bottom). listLogs returns
  // them descending-by-seq via afterSeq cursor semantics; we slice
  // the head and reverse for "newest at bottom" reading.
  const tail = recent.slice(0, rowBudget ?? cardConfig.maxRows).reverse();

  const cellRows = tail.map((row) => {
    const payload = displayEventPayload(row.payload);
    const cls = classifyEventVerb(payload);
    const ts = row.createdAt.slice(11, 19);
    const verb = cls?.verb ?? "·";
    const rest = cls?.rest ?? payload;
    return [ts, row.source, verb, rest];
  });
  const widths = layoutColumns(cellRows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox
      height={cardRenderHeight(cardConfig, rowBudget)}
      width={cols}
      title="Activity log"
      subtitle={`last ↑${tail.length}`}
      cardId={4}
    >
      {tail.map((row, i) => {
        const cells = cellRows[i];
        if (cells === undefined) return null;
        const cls = classifyEventVerb(displayEventPayload(row.payload));
        const padded = renderRow(cells, widths, COLUMN_SPECS);
        const colors = [
          { dimColor: true }, // ts
          { dimColor: true }, // source
          cls ? { color: "cyan" } : { dimColor: true }, // verb
          undefined, // rest
        ];
        return <ListRow key={row.seq} cells={padded} contentWidth={contentWidth} colors={colors} />;
      })}
    </TitledBox>
  );
}
