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
// CHROME INSETS INTO THE BORDERS
// (nit_tui_drill_inset_title_and_hints, Layer 2)
//
// Pre-Layer-2 the drill rendered its own title row ("▸ {title}
// (1-72/311)") and an optional hint line as ORDINARY BODY ROWS
// nested inside the popup Shell's rounded box — two rows of chrome
// rendered as content. The drill now wraps the visible slice in a
// `<TitledBox>` with magenta borders so:
//   - title + position indicator inset into the top border line
//     (`╭─ mu task notes <id> · 1-72/311 ───╮`)
//   - bottomLabel (drill-specific yank hint) insets into the bottom
//     border line (`╰─ y yanks `mu task notes <id>` ───────╯`)
//
// Magenta keeps the existing visual: cyan outer (popup Shell) +
// magenta inner (drill chrome). Two nested coloured borders
// distinguish nesting depth without doubled lines (TitledBox
// renders single-row borders only).
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { Text } from "ink";
import { useMemo } from "react";
import { TitledBox } from "../titled-box.js";

export interface DrillScrollViewProps {
  title: string;
  /** Already-rendered text — split on \n into lines. */
  body: string;
  /** Visible lines. Caller picks based on terminal height. */
  viewport: number;
  /** First visible line index (0-based; clamped by caller). */
  scrollTop: number;
  /** Optional dim hint rendered as the TitledBox's bottomLabel
   *  (drill-specific recipe, e.g. ``y yanks `mu task notes <id>` ``
   *  or ``loading…``). The j/k/Esc/q nav cluster lives in the
   *  global StatusBar (popup-mode hint), so we keep this label
   *  short — single drill-specific verb hint. */
  hint?: string;
  /** Optional fallback rendered when the body is empty. */
  emptyText?: string;
}

/**
 * Pure-render scrollable text view. Caller owns scroll state +
 * keyboard wiring; this component just paints the visible slice and
 * a dim "L/T" position indicator inset into the magenta top border.
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
  const bottomLabel = hint !== undefined && hint !== "" ? hint : undefined;

  return (
    <TitledBox
      title={title}
      subtitle={positionLabel}
      borderColor="magenta"
      titleColor="magenta"
      bottomLabel={bottomLabel}
      flexGrow={1}
    >
      {showFallback ? (
        <Text dimColor>{emptyText ?? "(empty)"}</Text>
      ) : (
        visible.map((ln, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <Text key={`${start + i}`}>{ln === "" ? " " : ln}</Text>
        ))
      )}
    </TitledBox>
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
