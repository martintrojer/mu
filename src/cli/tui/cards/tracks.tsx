// Tracks card — parallel-track summary (the headline of the previous
// `mu state --hud` view). One row per track: leading goal name +
// counts (total tasks, ready) + diamond-merge marker if applicable.
//
// Per design_card_tracks (workstream `tui`).
//
// Aesthetic: rounded border, dim border, section header inset.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: track number, ⋈ glyph,
// task counts are PROTECTED (identity / numeric); the goal-name list
// is CLIPPABLE.

import { Box, Text } from "ink";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type ColumnSpec, layoutColumns, renderRow } from "../columns.js";

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
  if (snapshot === null) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>Tracks — loading…</Text>
      </Box>
    );
  }

  const { tracks } = snapshot;
  const totalReady = tracks.reduce((acc, t) => acc + t.readyCount, 0);

  if (tracks.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          Tracks
        </Text>
        <Text dimColor>
          (no goals) try `mu task add -w {snapshot.workstreamName} --title "..."`
        </Text>
      </Box>
    );
  }

  const shown = tracks.slice(0, ROW_LIMIT);
  const rows = shown.map((t, i) => {
    const goalNames = t.roots
      .slice(0, 2)
      .map((r) => r.name)
      .join(", ");
    const diamond = t.roots.length > 1 ? "⋈" : " ";
    const counts = `(${t.taskIds.size} tasks · ${t.readyCount} ready)`;
    return [`Track ${i + 1}`, diamond, goalNames, counts];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS);

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      <Text bold color="cyan">
        Tracks{" "}
        <Text dimColor>
          · {tracks.length} · {totalReady} ready
        </Text>
      </Text>
      {shown.map((t, i) => {
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const [trackLabel = "", diamond = "", goals = "", counts = ""] = padded;
        const trackKey = `${i}-${t.roots[0]?.name ?? "unknown"}`;
        const ready = t.readyCount;
        return (
          <Box key={trackKey}>
            <Text>
              <Text color="cyan">{trackLabel}</Text>
              {"  "}
              <Text>{diamond}</Text>
              {"  "}
              <Text>{goals}</Text>
              {"  "}
              <Text color={ready > 0 ? "green" : undefined} dimColor={ready === 0}>
                {counts}
              </Text>
            </Text>
          </Box>
        );
      })}
      {tracks.length > ROW_LIMIT && (
        <Text dimColor>… +{tracks.length - ROW_LIMIT} more · open Tracks popup (Shift+2)</Text>
      )}
    </Box>
  );
}
