// Agents card — glanceable summary of every agent in the workstream.
//
// Per design_card_agents (workstream `tui`): name | status | task |
// idle. Header includes agentStatusHistogram. Reuses STATUS_EMOJI from
// src/agents.ts so the glyph language matches `mu agent list`.
//
// Aesthetic: rounded border, dim border colour, section header inset
// into the top.
//
// Rows are column-aligned via src/cli/tui/columns.ts so name / task /
// idle line up cleanly. Per feat_column_aligned_lists clipping policy:
// glyph + agent name + idle marker are PROTECTED; the owned-task
// summary is CLIPPABLE (it's a free-form string and the popup carries
// the full version).

import { Text } from "ink";
import { STATUS_EMOJI } from "../../../agents.js";
import {
  type WorkstreamSnapshot,
  agentStatusHistogram,
  summarizeOwnedTasks,
} from "../../../state.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { ListRow } from "../list-row.js";
import { TitledBox } from "../titled-box.js";

export interface AgentsCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // status glyph
  { kind: "protect" }, // agent name
  { kind: "clip", min: 1 }, // owned-task summary
  { kind: "protect" }, // idle marker
];

export function AgentsCard({ snapshot }: AgentsCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  if (snapshot === null) {
    return (
      <TitledBox title="Agents" cardId={1}>
        <Text dimColor>loading…</Text>
      </TitledBox>
    );
  }

  const agents = snapshot.view.agents;
  const histogram = agentStatusHistogram(agents);
  const histLabel = formatHistogram(histogram);

  if (agents.length === 0) {
    return (
      <TitledBox title="Agents" cardId={1}>
        <Text dimColor>(no agents) try `mu agent spawn worker-1 -w {snapshot.workstreamName}`</Text>
      </TitledBox>
    );
  }

  // Build the cell matrix once so column widths consider every row.
  const rows = agents.map((a) => {
    const owned = snapshot.inProgress.filter((t) => t.ownerName === a.name);
    const taskBit = summarizeOwnedTasks(owned).bit;
    const idle = a.idle ? "⚠ idle" : "";
    return [STATUS_EMOJI[a.status] ?? "?", a.name, taskBit, idle];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox title="Agents" subtitle={histLabel} cardId={1}>
      {agents.map((a, i) => {
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const colors = [
          undefined, // glyph
          { bold: true }, // name
          { dimColor: true }, // taskBit
          a.idle ? { color: "yellow" } : { dimColor: true }, // idle marker
        ];
        return <ListRow key={a.name} cells={padded} contentWidth={contentWidth} colors={colors} />;
      })}
    </TitledBox>
  );
}

function formatHistogram(h: ReadonlyMap<string, number>): string {
  const parts: string[] = [];
  for (const [status, n] of h.entries()) {
    parts.push(`${n} ${status}`);
  }
  return parts.length === 0 ? "(none)" : parts.join(" · ");
}
