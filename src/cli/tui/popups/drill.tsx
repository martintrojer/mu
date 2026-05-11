// Shared "drill detail" sub-view for popups. Renders a titled
// scrollable block of pre-formatted text inside a popup body. Used
// by:
//   - popups/agents.tsx → agent pane scrollback (mu agent read)
//   - popups/ready.tsx  → task notes (mu task notes)
//   - popups/tracks.tsx → task list belonging to a track (already
//     a list, not a scrollback — uses ScrollList instead)
//
// The drill itself is read-only: it renders text, never executes
// anything. j/k scroll one line; Ctrl-D / Ctrl-U scroll a viewport
// half. Esc / q is the popup's responsibility (we only render).
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { Box, Text } from "ink";
import { useMemo } from "react";

export interface DrillScrollViewProps {
  title: string;
  /** Already-rendered text — split on \n into lines. */
  body: string;
  /** Visible lines. Caller picks based on terminal height. */
  viewport: number;
  /** First visible line index (0-based; clamped by caller). */
  scrollTop: number;
  /** Optional dim hint line above the body (e.g. "loading…"). */
  hint?: string;
  /** Optional fallback rendered when the body is empty. */
  emptyText?: string;
}

/**
 * Pure-render scrollable text view. Caller owns scroll state +
 * keyboard wiring; this component just paints the visible slice and
 * a dim "L/T" position indicator.
 */
export function DrillScrollView({
  title,
  body,
  viewport,
  scrollTop,
  hint,
  emptyText,
}: DrillScrollViewProps): JSX.Element {
  const lines = useMemo(() => (body === "" ? [] : body.split("\n")), [body]);
  const totalLines = lines.length;
  const start = Math.max(0, Math.min(Math.max(0, totalLines - viewport), scrollTop));
  const visible = lines.slice(start, start + viewport);
  const showFallback = totalLines === 0;
  const positionLabel = showFallback
    ? "0/0"
    : `${start + 1}-${Math.min(totalLines, start + viewport)}/${totalLines}`;

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="magenta">
          ▸ {title}
        </Text>
        <Text dimColor> ({positionLabel})</Text>
      </Box>
      {hint !== undefined && hint !== "" ? <Text dimColor>{hint}</Text> : null}
      {showFallback ? (
        <Text dimColor>{emptyText ?? "(empty)"}</Text>
      ) : (
        visible.map((ln, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <Text key={`${start + i}`}>{ln === "" ? " " : ln}</Text>
        ))
      )}
    </Box>
  );
}

/**
 * Shared scroll-state reducer logic. Caller maintains `scrollTop`
 * via useState and dispatches these primitives from its
 * dispatchPopupKey switch. Pure: returns the new scrollTop.
 */
export function clampScrollTop(scrollTop: number, totalLines: number, viewport: number): number {
  const max = Math.max(0, totalLines - viewport);
  if (scrollTop < 0) return 0;
  if (scrollTop > max) return max;
  return scrollTop;
}
