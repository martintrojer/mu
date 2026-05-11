// Agents card — glanceable summary of every agent in the workstream.
//
// Per design_card_agents (workstream `tui`): name | status | task |
// idle. Header includes agentStatusHistogram. Reuses STATUS_EMOJI from
// src/agents.ts so the glyph language matches `mu agent list`.
//
// Aesthetic: rounded border, dim border colour, section header inset
// into the top.

import { Box, Text } from "ink";
import { STATUS_EMOJI } from "../../../agents.js";
import {
  type WorkstreamSnapshot,
  agentStatusHistogram,
  summarizeOwnedTasks,
} from "../../../state.js";

export interface AgentsCardProps {
  snapshot: WorkstreamSnapshot | null;
}

export function AgentsCard({ snapshot }: AgentsCardProps): JSX.Element {
  if (snapshot === null) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>Agents — loading…</Text>
      </Box>
    );
  }

  const agents = snapshot.view.agents;
  const histogram = agentStatusHistogram(agents);
  const histLabel = formatHistogram(histogram);

  if (agents.length === 0) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          Agents
        </Text>
        <Text dimColor>(no agents) try `mu agent spawn worker-1 -w {snapshot.workstreamName}`</Text>
      </Box>
    );
  }

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
      <Text bold color="cyan">
        Agents <Text dimColor>· {histLabel}</Text>
      </Text>
      {agents.map((a) => {
        // Per-agent owned tasks: filter snapshot.inProgress by the
        // `owner` field. Cheap on the typical <10-agent wave.
        const owned = snapshot.inProgress.filter((t) => t.ownerName === a.name);
        const taskBit = summarizeOwnedTasks(owned).bit;
        const idle = a.idle ? "⚠ idle" : "—";
        return (
          <Box key={a.name}>
            <Text>
              {STATUS_EMOJI[a.status] ?? "?"} <Text bold>{a.name}</Text>{" "}
              <Text dimColor>{taskBit}</Text>{" "}
              <Text color={a.idle ? "yellow" : undefined} dimColor={!a.idle}>
                {idle}
              </Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function formatHistogram(h: ReadonlyMap<string, number>): string {
  const parts: string[] = [];
  for (const [status, n] of h.entries()) {
    parts.push(`${n} ${status}`);
  }
  return parts.length === 0 ? "(none)" : parts.join(" · ");
}
