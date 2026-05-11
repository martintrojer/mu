// Tracks card — parallel-track summary (the headline of the previous
// `mu state --hud` view). One row per track: leading goal name +
// counts (total tasks, ready) + diamond-merge marker if applicable.
//
// Per design_card_tracks (workstream `tui`).
//
// Aesthetic: rounded border, dim border, section header inset.

import { Box, Text } from "ink";
import type { WorkstreamSnapshot } from "../../../state.js";

export interface TracksCardProps {
  snapshot: WorkstreamSnapshot | null;
}

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

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      <Text bold color="cyan">
        Tracks{" "}
        <Text dimColor>
          · {tracks.length} · {totalReady} ready
        </Text>
      </Text>
      {tracks.slice(0, 8).map((t, i) => {
        const goalNames = t.roots
          .slice(0, 2)
          .map((r) => r.name)
          .join(", ");
        const diamond = t.roots.length > 1 ? "⋈ " : "";
        const ready = t.readyCount;
        // Stable key derived from the goal names + index to handle
        // the (rare) case of two tracks with identical leading goals.
        const trackKey = `${i}-${t.roots[0]?.name ?? "unknown"}`;
        return (
          <Box key={trackKey}>
            <Text>
              <Text color="cyan">Track {i + 1}</Text>{" "}
              <Text>
                {diamond}
                {goalNames}
              </Text>{" "}
              <Text dimColor>({t.taskIds.size} tasks · </Text>
              <Text color={ready > 0 ? "green" : undefined} dimColor={ready === 0}>
                {ready} ready
              </Text>
              <Text dimColor>)</Text>
            </Text>
          </Box>
        );
      })}
      {tracks.length > 8 && (
        <Text dimColor>… +{tracks.length - 8} more · open Tracks popup (Shift+2)</Text>
      )}
    </Box>
  );
}
