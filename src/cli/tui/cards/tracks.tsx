// Tracks card — parallel-track summary (the headline of the previous
// `mu state --hud` view). One row per track: leading goal name +
// counts (total tasks, ready) + diamond-merge marker if applicable.
//
// Per design_card_tracks (workstream `tui`).
//
// Aesthetic: section header inset into the top border (TitledBox).
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: track number, ⋈ glyph,
// task counts are PROTECTED (identity / numeric); the goal-name list
// is CLIPPABLE.

import { Text } from "ink";
import type { WorkstreamSnapshot } from "../../../state.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { ListRow } from "../list-row.js";
import { TitledBox } from "../titled-box.js";

export interface TracksCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const ROW_LIMIT = 8;

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // "Track N"
  { kind: "protect" }, // diamond glyph (or empty)
  { kind: "clip", min: 1 }, // goal names
  { kind: "protect" }, // counts "(N tasks · M ready)"
];

export function TracksCard({ snapshot }: TracksCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  if (snapshot === null) {
    return (
      <TitledBox title="Tracks" cardId={2}>
        <Text dimColor>loading…</Text>
      </TitledBox>
    );
  }

  const { tracks } = snapshot;
  const totalReady = tracks.reduce((acc, t) => acc + t.readyCount, 0);

  if (tracks.length === 0) {
    return (
      <TitledBox title="Tracks" cardId={2}>
        <Text dimColor>
          (no goals) try `mu task add -w {snapshot.workstreamName} --title "..."`
        </Text>
      </TitledBox>
    );
  }

  const shown = tracks.slice(0, ROW_LIMIT);
  const more = tracks.length - ROW_LIMIT;
  const bottomLabel = more > 0 ? `+${more} more · Shift+2` : undefined;
  const rows = shown.map((t, i) => {
    const goalNames = t.roots
      .slice(0, 2)
      .map((r) => r.name)
      .join(", ");
    const diamond = t.roots.length > 1 ? "⋈" : " ";
    const taskNoun = t.taskIds.size === 1 ? "task" : "tasks";
    const counts = `(${t.taskIds.size} ${taskNoun} · ${t.readyCount} ready)`;
    return [`Track ${i + 1}`, diamond, goalNames, counts];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox
      title="Tracks"
      subtitle={`${tracks.length} · ${totalReady} ready`}
      cardId={2}
      bottomLabel={bottomLabel}
    >
      {shown.map((t, i) => {
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const trackKey = `${i}-${t.roots[0]?.name ?? "unknown"}`;
        const ready = t.readyCount;
        const colors = [
          { color: "cyan" }, // trackLabel
          undefined, // diamond
          undefined, // goals
          ready > 0 ? { color: "green" } : { dimColor: true }, // counts
        ];
        return (
          <ListRow key={trackKey} cells={padded} contentWidth={contentWidth} colors={colors} />
        );
      })}
    </TitledBox>
  );
}
