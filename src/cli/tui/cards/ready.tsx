// Ready card — top-N OPEN tasks with no unsatisfied blockers, sorted
// by ROI desc.
//
// Per design_card_ready (workstream `tui`).
//
// Aesthetic: rounded border, dim border, section header inset; ROI
// bucket colours via roiBucket() — high=green, mid=yellow, low=dim.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: task name, ROI number,
// owner are PROTECTED (yank affordance / numeric); the title is
// CLIPPABLE.

import { Text } from "ink";
import { type WorkstreamSnapshot, roiBucket } from "../../../state.js";
import { inkColorForStatus } from "../../format.js";
import { agentByName, formatAgentRefDisplayName } from "../agent-display.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { colorForBucket, formatRoi } from "../format-helpers.js";
import { CARD_CONFIGS, cardRenderHeight } from "../layout.js";
import { ListRow } from "../list-row.js";
import { TitledBox } from "../titled-box.js";
import { CardPlaceholder } from "./_placeholder.js";

export interface ReadyCardProps {
  snapshot: WorkstreamSnapshot | null;
  rowBudget?: number;
  cols?: number;
}

export const cardConfig = CARD_CONFIGS[3];

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // task name
  { kind: "protect" }, // status
  { kind: "protect", align: "right" }, // ROI label (e.g. "ROI 50")
  { kind: "clip", min: 1 }, // title
  { kind: "protect" }, // owner (or "—")
];

export function ReadyCard({ snapshot, rowBudget, cols }: ReadyCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(cols ?? termColsForLayout());
  if (snapshot === null) {
    return CardPlaceholder({
      title: "Ready",
      cardId: 3,
      config: cardConfig,
      rowBudget,
      cols,
      text: "loading…",
    });
  }

  const { ready } = snapshot;

  if (ready.length === 0) {
    return CardPlaceholder({
      title: "Ready",
      cardId: 3,
      config: cardConfig,
      rowBudget,
      cols,
      children: (
        <Text dimColor>
          (no ready tasks) every blocker is OPEN/IN_PROGRESS or every task is closed
        </Text>
      ),
    });
  }

  const shown = ready.slice(0, rowBudget ?? cardConfig.maxRows);
  const more = ready.length - shown.length;
  const bottomLabel = more > 0 ? `+${more} more · Shift+3` : undefined;
  const meta = shown.map((t) => {
    const bucket = roiBucket(t.impact, t.effortDays);
    const roiText = formatRoi(t.impact, t.effortDays);
    return { bucket, roiText };
  });
  const agentLookup = agentByName(snapshot);
  const rows = shown.map((t, i) => [
    t.name,
    t.status,
    `ROI ${meta[i]?.roiText ?? ""}`,
    t.title,
    formatAgentRefDisplayName(t.ownerName, agentLookup),
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox
      height={cardRenderHeight(cardConfig, rowBudget)}
      width={cols}
      title="Ready"
      subtitle={String(ready.length)}
      cardId={3}
      bottomLabel={bottomLabel}
    >
      {shown.map((t, i) => {
        const row = rows[i];
        const m = meta[i];
        if (row === undefined || m === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const colors = [
          { bold: true }, // name
          { color: inkColorForStatus(t.status) }, // status
          { color: colorForBucket(m.bucket) }, // roi
          { dimColor: true }, // title
          { dimColor: true }, // owner
        ];
        return <ListRow key={t.name} cells={padded} contentWidth={contentWidth} colors={colors} />;
      })}
    </TitledBox>
  );
}
