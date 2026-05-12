// Help overlay (?). Renders the TUI keymap superset from the shared
// keymap spec. Status-bar hint clusters are intentionally smaller:
// they show only the keys that should be always visible in the current
// mode. The help overlay is the exhaustive reference.

import { Box, Text } from "ink";
import { HELP_PANES } from "./keymap-spec.js";

export function Help(): JSX.Element {
  const cols = process.stdout.columns ?? 80;
  const contentWidth = Math.max(1, cols - 4); // border + paddingX on both sides

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width={cols}>
      {HELP_PANES.map((pane, paneIdx) => (
        <Box key={pane.title} flexDirection="column" width={contentWidth}>
          {paneIdx > 0 && <Text> </Text>}
          <Box width={contentWidth}>
            <Text bold color="cyan">
              {pane.title}
            </Text>
          </Box>
          {pane.rows.map((row) => (
            <HelpRow
              key={`${pane.title}:${row.keys}`}
              keys={row.keys}
              effect={row.effect}
              contentWidth={contentWidth}
            />
          ))}
        </Box>
      ))}
    </Box>
  );
}

function HelpRow({
  keys,
  effect,
  contentWidth,
}: {
  keys: string;
  effect: string;
  contentWidth: number;
}): JSX.Element {
  return (
    <Box width={contentWidth}>
      <Box width={18}>
        <Text color="yellow">{keys}</Text>
      </Box>
      <Box width={Math.max(1, contentWidth - 18)}>
        <Text dimColor>{effect}</Text>
      </Box>
    </Box>
  );
}
