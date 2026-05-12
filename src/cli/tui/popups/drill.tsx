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
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PopupAction } from "../keys.js";
import { TitledBox } from "../titled-box.js";
import { applyScroll, isNavAction } from "./scroll.js";

// Re-export so existing `import { clampScrollTop } from "./drill.js"`
// callers stay valid until they migrate to the centralised
// applyCursor / applyScroll helpers in popups/scroll.ts.
export { clampScrollTop } from "./scroll.js";

export interface DrillKeymapOptions {
  /** Already-rendered text — split on \n for scroll clamping. */
  body: string;
  /** Visible lines. Matches the DrillScrollView viewport. */
  viewport: number;
  /** Called for Esc/q. The hook resets scrollTop before invoking it. */
  onClose: () => void;
  /** Optional y action for this drill view. */
  onYank?: () => void | Promise<void>;
}

export interface DrillKeymap {
  scrollTop: number;
  dispatch: (action: PopupAction) => void;
}

/**
 * Shared keymap for read-only DrillScrollView leaves. Centralises the
 * common drill skeleton: clamp scroll from the rendered body, Esc/q
 * backs out one level, y delegates to the caller's read-only yank.
 */
export function useDrillKeymap({
  body,
  viewport,
  onClose,
  onYank,
}: DrillKeymapOptions): DrillKeymap {
  const [scrollTop, setScrollTop] = useState(0);
  const totalLines = useMemo(() => (body === "" ? 0 : body.split("\n").length), [body]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll resets when the rendered drill body changes, even if the new body has the same line count.
  useEffect(() => {
    setScrollTop(0);
  }, [body]);

  const dispatch = useCallback(
    (action: PopupAction) => {
      if (isNavAction(action)) {
        setScrollTop((s) => applyScroll(s, action, totalLines, viewport));
        return;
      }
      switch (action.kind) {
        case "close":
          setScrollTop(0);
          onClose();
          return;
        case "yank":
          void onYank?.();
          return;
        default:
          return;
      }
    },
    [onClose, onYank, totalLines, viewport],
  );

  return { scrollTop, dispatch };
}

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
          <Text key={`${start + i}`} wrap="truncate">
            {ln === "" ? " " : ln}
          </Text>
        ))
      )}
    </TitledBox>
  );
}
