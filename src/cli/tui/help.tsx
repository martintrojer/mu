// Help overlay (?). Renders the TUI keymap superset from the shared
// keymap spec. Status-bar hint clusters are intentionally smaller:
// they show only the keys that should be always visible in the current
// mode. The help overlay is the exhaustive reference.

import { Box, Text } from "ink";
import { HELP_PANES } from "./keymap-spec.js";

export function Help(): JSX.Element {
  return (
    <Box flexDirection="row" gap={2}>
      {HELP_PANES.map((pane) => (
        <Box
          key={pane.title}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="cyan">
            {pane.title}
          </Text>
          {pane.rows.map((row) => (
            <HelpRow key={`${pane.title}:${row.keys}`} keys={row.keys} effect={row.effect} />
          ))}
        </Box>
      ))}
    </Box>
  );
}

function HelpRow({ keys, effect }: { keys: string; effect: string }): JSX.Element {
  return (
    <Box>
      <Box width={18}>
        <Text color="yellow">{keys}</Text>
      </Box>
      <Text dimColor>{effect}</Text>
    </Box>
  );
}
