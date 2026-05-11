// Activity-log card — fixed-height tail of the most recent N events
// from agent_logs. Auto-updates on every tick (no scroll-pause needed
// at the card level; the popup handles full scroll-pause behaviour).
//
// Per design_card_log (workstream `tui`).
//
// Aesthetic: rounded border, dim border, section header inset; verb
// prefix coloured cyan via classifyEventVerb.

import { Box, Text } from "ink";
import { classifyEventVerb } from "../../../logs.js";
import type { WorkstreamSnapshot } from "../../../state.js";

export interface LogCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const ROW_LIMIT = 8;

export function LogCard({ snapshot }: LogCardProps): JSX.Element {
  if (snapshot === null) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>Activity log — loading…</Text>
      </Box>
    );
  }

  const { recent } = snapshot;

  if (recent.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          Activity log
        </Text>
        <Text dimColor>(no events yet)</Text>
      </Box>
    );
  }

  // Show the LAST N events (newest at the bottom). listLogs returns
  // them descending-by-seq via afterSeq cursor semantics; we slice
  // the head and reverse for "newest at bottom" reading.
  const tail = recent.slice(0, ROW_LIMIT).reverse();

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      <Text bold color="cyan">
        Activity log <Text dimColor>· last ↑{Math.min(recent.length, ROW_LIMIT)}</Text>
      </Text>
      {tail.map((row) => {
        const cls = classifyEventVerb(row.payload);
        const ts = row.createdAt.slice(11, 19); // HH:MM:SS
        return (
          <Box key={row.seq}>
            <Text>
              <Text dimColor>{ts}</Text> <Text dimColor>{row.source}</Text>{" "}
              {cls ? (
                <>
                  <Text color="cyan">{cls.verb}</Text>
                  <Text>{cls.rest}</Text>
                </>
              ) : (
                <Text>{row.payload}</Text>
              )}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
