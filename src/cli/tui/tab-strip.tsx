// TabStrip — workstream switcher rendered above the dashboard when
// the TUI is launched with multiple workstreams.
//
// The pure layout algorithm lives in tab-strip-layout.ts. This
// component only reads the terminal width, asks for a layout spec, and
// renders that spec with the existing dim/cyan styling.

import { Box, Text, useStdout } from "ink";

import { layoutTabStrip } from "./tab-strip-layout.js";

export interface TabStripProps {
  /** Resolved workstream set, in order. Length must be ≥ 1; the
   *  caller skips rendering when length ≤ 1 (see <App>). */
  workstreams: readonly string[];
  /** Index of the active tab. Caller guarantees 0 ≤ active < workstreams.length. */
  active: number;
  /** Test seam; runtime reads ink's stdout columns. */
  terminalColumns?: number;
}

export function TabStrip({
  workstreams,
  active,
  terminalColumns,
}: TabStripProps): JSX.Element | null {
  if (workstreams.length <= 1) return null;
  const layout = layoutTabStrip(workstreams, active, terminalColumns ?? stdoutColumns());
  if (layout === null) return null;
  const tabs: JSX.Element[] = [];
  for (let i = 0; i < layout.visible.length; i++) {
    const tab = layout.visible[i];
    if (tab === undefined) continue;
    if (tab.isActive) {
      tabs.push(
        <Text key={`t-${i}`} bold color="cyan">
          {`▸ ${tab.name}`}
        </Text>,
      );
    } else {
      tabs.push(
        <Text key={`t-${i}`} dimColor>
          {tab.name}
        </Text>,
      );
    }
    if (i < layout.visible.length - 1) {
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
      {layout.leftHidden > 0 && <Text dimColor>{`‹${layout.leftHidden} `}</Text>}
      {tabs}
      {layout.rightHidden > 0 && <Text dimColor>{` ›${layout.rightHidden}`}</Text>}
      {layout.showHint && (
        <Text dimColor>
          {layout.leftHidden > 0 || layout.rightHidden > 0
            ? " (Tab/Shift-Tab)"
            : " (Tab / Shift-Tab)"}
        </Text>
      )}
    </Box>
  );
}

function stdoutColumns(): number {
  const { stdout } = useStdout();
  return stdout.columns ?? 80;
}
