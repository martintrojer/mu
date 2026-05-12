// Commits card — lazygit-style recent project commit log.
//
// Slot choice: Card 8 is now Commits. The previous Recent card stays
// available as popup-only via Shift+8 (`*`), because recent task
// events are already visible through the Activity-log card/popup while
// project commits were not visible anywhere on the dashboard.
//
// Data comes from snapshot.recentCommits, populated by
// loadWorkstreamSnapshot(..., { withRecentCommits }) against
// process.cwd() (the project root where the TUI was launched), NOT any
// per-agent worker workspace.

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

export interface CommitsCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const ROW_LIMIT = 8;

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // sha short
  { kind: "protect", align: "right" }, // relative time
  { kind: "clip", min: 1 }, // subject
];

export function CommitsCard({ snapshot }: CommitsCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  if (snapshot === null) {
    return (
      <TitledBox title="Commits" cardId={8}>
        <Text dimColor>loading…</Text>
      </TitledBox>
    );
  }

  const { recentCommits } = snapshot;
  if (recentCommits.length === 0) {
    return (
      <TitledBox title="Commits" cardId={8}>
        <Text dimColor>no commits</Text>
      </TitledBox>
    );
  }

  const shown = recentCommits.slice(0, ROW_LIMIT);
  const more = recentCommits.length - ROW_LIMIT;
  const bottomLabel = more > 0 ? `+${more} more · Shift+8` : undefined;
  const subtitle = formatSubtitle(recentCommits.length, recentCommits[0]?.relTime);
  const rows = shown.map((c) => [shortSha(c.sha), c.relTime, c.subject]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox title="Commits" subtitle={subtitle} cardId={8} bottomLabel={bottomLabel}>
      {shown.map((c, i) => {
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const colors = [
          { color: "yellow" }, // sha
          { dimColor: true }, // relTime
          undefined, // subject
        ];
        return <ListRow key={c.sha} cells={padded} contentWidth={contentWidth} colors={colors} />;
      })}
    </TitledBox>
  );
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function formatSubtitle(total: number, newestRelTime: string | undefined): string {
  return newestRelTime === undefined || newestRelTime.length === 0
    ? String(total)
    : `${total} · ${newestRelTime}`;
}
