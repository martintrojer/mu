// TabStrip — workstream switcher rendered above the dashboard when
// the TUI is launched with multiple workstreams.
//
// The pure layout algorithm lives in tab-strip-layout.ts. This
// component is a PURE presentational component: it takes the
// terminal column count as a prop (the parent <App> reads useStdout
// once for its own use and threads `cols` down). No hooks here —
// previously a `useStdout()` helper was called from this module,
// which produced a 'Rendered fewer hooks than expected' crash on
// small panes because the early-return guard upstairs caused the
// hook to be called on some renders and skipped on others.

import { Box, Text } from "ink";

import { isScratchWorkstream } from "../../workstream.js";
import { layoutTabStrip } from "./tab-strip-layout.js";

export interface TabStripProps {
  /** Resolved workstream set, in order. Length must be ≥ 1; the
   *  caller skips rendering when length ≤ 1 (see <App>). */
  workstreams: readonly string[];
  /** Index of the active tab. Caller guarantees 0 ≤ active < workstreams.length. */
  active: number;
  /** Terminal columns. Required: the parent <App> reads ink's
   *  useStdout() once and threads this down so the strip can stay
   *  hook-free (and therefore safe to call from outside an ink
   *  render tree, e.g. unit tests). */
  terminalColumns: number;
  /** Set of workstream names presumed parked on another machine
   *  (`parkedStatus(db, ws).parked === true`). Tabs in this set
   *  render with a `~` prefix to nudge the user away from
   *  destroying them; the canonical fix is to re-import from the
   *  other side. Optional so existing callers / tests stay valid. */
  parked?: ReadonlySet<string>;
}

export function TabStrip({
  workstreams,
  active,
  terminalColumns,
  parked,
}: TabStripProps): JSX.Element | null {
  if (workstreams.length <= 1) return null;
  const layout = layoutTabStrip(workstreams, active, terminalColumns);
  if (layout === null) return null;
  const isParked = (name: string): boolean => parked?.has(name) ?? false;
  // Marker precedence: parked (`~`) wins over scratch (`*`) when both
  // somehow apply, since parked is the more actionable nudge. Scratch
  // is the reserved off-the-cuff bucket; the `*` cue signals
  // "ephemeral, not a durable crew" so the operator doesn't mistake it
  // for a real workstream. Mirrors the parked post-layout decorate
  // (1-col imprecision tolerated, same as `~`).
  const decorate = (name: string): string =>
    isParked(name) ? `~${name}` : isScratchWorkstream(name) ? `*${name}` : name;
  const tabs: JSX.Element[] = [];
  for (let i = 0; i < layout.visible.length; i++) {
    const tab = layout.visible[i];
    if (tab === undefined) continue;
    if (tab.isActive) {
      tabs.push(
        <Text key={`t-${i}`} bold color="cyan">
          {`▸ ${decorate(tab.name)}`}
        </Text>,
      );
    } else {
      tabs.push(
        <Text key={`t-${i}`} dimColor>
          {decorate(tab.name)}
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
