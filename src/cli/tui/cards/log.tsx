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

import { Box, Text } from "ink";
import { classifyEventVerb } from "../../../logs.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type ColumnSpec, layoutColumns, renderRow } from "../columns.js";
import { TitledBox } from "../titled-box.js";

export interface LogCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const ROW_LIMIT = 8;

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // ts (HH:MM:SS)
  { kind: "protect" }, // source
  { kind: "protect" }, // verb (or '·' fallback)
  { kind: "clip", min: 1 }, // rest / payload
];

export function LogCard({ snapshot }: LogCardProps): JSX.Element {
  if (snapshot === null) {
    return (
      <TitledBox title="Activity log">
        <Text dimColor>loading…</Text>
      </TitledBox>
    );
  }

  const { recent } = snapshot;

  if (recent.length === 0) {
    return (
      <TitledBox title="Activity log">
        <Text dimColor>(no events yet)</Text>
      </TitledBox>
    );
  }

  // Show the LAST N events (newest at the bottom). listLogs returns
  // them descending-by-seq via afterSeq cursor semantics; we slice
  // the head and reverse for "newest at bottom" reading.
  const tail = recent.slice(0, ROW_LIMIT).reverse();

  const cellRows = tail.map((row) => {
    const cls = classifyEventVerb(row.payload);
    const ts = row.createdAt.slice(11, 19);
    const verb = cls?.verb ?? "·";
    const rest = cls?.rest ?? row.payload;
    return [ts, row.source, verb, rest];
  });
  const widths = layoutColumns(cellRows, COLUMN_SPECS);

  return (
    <TitledBox title="Activity log" subtitle={`last ↑${Math.min(recent.length, ROW_LIMIT)}`}>
      {tail.map((row, i) => {
        const cells = cellRows[i];
        if (cells === undefined) return null;
        const cls = classifyEventVerb(row.payload);
        const padded = renderRow(cells, widths, COLUMN_SPECS);
        const [ts = "", source = "", verb = "", rest = ""] = padded;
        return (
          <Box key={row.seq}>
            <Text>
              <Text dimColor>{ts}</Text>
              {"  "}
              <Text dimColor>{source}</Text>
              {"  "}
              {cls ? <Text color="cyan">{verb}</Text> : <Text dimColor>{verb}</Text>}
              {"  "}
              <Text>{rest}</Text>
            </Text>
          </Box>
        );
      })}
    </TitledBox>
  );
}
