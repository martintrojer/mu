// TabStrip — workstream switcher rendered above the dashboard when
// the TUI is launched with multiple workstreams.
//
// Per feat_tui_multi_workstream (workstream `tui-impl`): the TUI
// shows ONE workstream at a time; Tab / Shift-Tab cycles through the
// resolved set; the active tab is highlighted (bold + cyan + leading
// `▸ ` marker so colour-blind users still get an unambiguous active
// indicator). The strip is intentionally cheap: a single `<Box>` row
// with one `<Text>` per tab, separated by ` · ` dim dividers. No
// border, no padding — it's a navigation affordance, not a card.
//
// Degenerate case: when `workstreams.length <= 1` the strip renders
// nothing (returns null). Callers (the <App> root) gate on this so
// the single-ws layout exactly matches the pre-multi-ws frame and
// no test scrollback differs.
//
// Width policy: the strip never truncates. With many workstreams on
// a narrow terminal the row will wrap onto a second line — acceptable
// because tab labels are short workstream names and the operator can
// always render one fewer ws via `mu state --tui -w fewer,here`.
//
// Pure presentational component: the active index lives in <App>;
// click/key handlers live in <App>'s useInput dispatcher (Tab /
// Shift-Tab → nextTab / prevTab actions from src/cli/tui/keys.ts).

import { Box, Text } from "ink";

export interface TabStripProps {
  /** Resolved workstream set, in order. Length must be ≥ 1; the
   *  caller skips rendering when length ≤ 1 (see <App>). */
  workstreams: readonly string[];
  /** Index of the active tab. Caller guarantees 0 ≤ active < workstreams.length. */
  active: number;
}

export function TabStrip({ workstreams, active }: TabStripProps): JSX.Element | null {
  if (workstreams.length <= 1) return null;
  const tabs: JSX.Element[] = [];
  for (let i = 0; i < workstreams.length; i++) {
    const name = workstreams[i] ?? "";
    const isActive = i === active;
    if (isActive) {
      // Leading ▸ is the colour-blind-safe active marker. The bold
      // + cyan combo is the same emphasis pattern <TitledBox> uses
      // for section headers.
      tabs.push(
        <Text key={`t-${i}`} bold color="cyan">
          {`▸ ${name}`}
        </Text>,
      );
    } else {
      tabs.push(
        <Text key={`t-${i}`} dimColor>
          {name}
        </Text>,
      );
    }
    if (i < workstreams.length - 1) {
      tabs.push(
        <Text key={`s-${i}`} dimColor>
          {" · "}
        </Text>,
      );
    }
  }
  return (
    <Box flexDirection="row">
      <Text dimColor>workstreams: </Text>
      {tabs}
      <Text dimColor> (Tab / Shift-Tab)</Text>
    </Box>
  );
}
