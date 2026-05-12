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
import { CARD_CONFIGS } from "../layout.js";
import { ListRow } from "../list-row.js";
import { PaddedRows } from "../padded-rows.js";
import { TitledBox } from "../titled-box.js";

export interface AgentsCardProps {
  snapshot: WorkstreamSnapshot | null;
  rowBudget?: number;
  cols?: number;
}

export const cardConfig = CARD_CONFIGS[1];

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // status glyph
  { kind: "protect" }, // agent name
  { kind: "clip", min: 1 }, // owned-task summary
  { kind: "protect" }, // idle marker
];

export function AgentsCard({ snapshot, rowBudget, cols }: AgentsCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(cols ?? termColsForLayout());
  if (snapshot === null) {
    return (
      <TitledBox width={cols} title="Agents" cardId={1}>
        <PaddedRows minRows={rowBudget ?? cardConfig.minRows}>
          <Text dimColor>loading…</Text>
        </PaddedRows>
      </TitledBox>
    );
  }

  const agents = snapshot.view.agents;
  const histogram = agentStatusHistogram(agents);
  const histLabel = formatHistogram(histogram);

  if (agents.length === 0) {
    return (
      <TitledBox width={cols} title="Agents" cardId={1}>
        <PaddedRows minRows={rowBudget ?? cardConfig.minRows}>
          <Text dimColor>
            (no agents) try `mu agent spawn worker-1 -w {snapshot.workstreamName}`
          </Text>
        </PaddedRows>
      </TitledBox>
    );
  }

  const shown = agents.slice(0, rowBudget ?? cardConfig.maxRows);
  const more = agents.length - shown.length;
  const bottomLabel = more > 0 ? `+${more} more · Shift+1` : undefined;

  // Build the cell matrix once so column widths consider every visible row.
  const rows = shown.map((a) => {
    const owned = snapshot.inProgress.filter((t) => t.ownerName === a.name);
    const taskBit = summarizeOwnedTasks(owned).bit;
    const idle = a.idle ? "⚠ idle" : "";
    return [STATUS_EMOJI[a.status] ?? "?", a.name, taskBit, idle];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox
      width={cols}
      title="Agents"
      subtitle={histLabel}
      cardId={1}
      bottomLabel={bottomLabel}
    >
      {shown.map((a, i) => {
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
