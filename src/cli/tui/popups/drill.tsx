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

import { Box, Text } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cellWidth, contentWidthFromCols, termColsForLayout, truncateCell } from "../columns.js";
import type { PopupAction } from "../keys.js";
import { wrapAndPadAnsiLines } from "../wrap-ansi.js";
import { applyScroll, clampScrollTop, isNavAction } from "./scroll.js";

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
  /** Optional user-driven escape hatch for git-show drills. */
  onTuicr?: () => void | Promise<void>;
  /** Called after keyboard navigation computes and stores a new scroll top. */
  onScrollChange?: (newTop: number) => void;
  /**
   * Identity signal for scroll resets. Callers should pass the focused
   * row / entity identity so auto-refreshes of the SAME drill preserve
   * scroll, while navigating to a DIFFERENT drill resets to the top.
   * Omit to keep the legacy behaviour: reset whenever body changes.
   */
  resetKey?: string | number;
}

export interface WrappedDrillBody {
  wrapped: string;
  lines: readonly string[];
  totalLines: number;
}

export interface DrillKeymap {
  scrollTop: number;
  dispatch: (action: PopupAction) => void;
  wrappedBody: WrappedDrillBody;
  wrappedLines: readonly string[];
  totalLines: number;
}

function drillWrapWidth(): number {
  return Math.max(0, contentWidthFromCols(termColsForLayout()) - 2);
}

export function wrapDrillBody(body: string, wrapWidth: number): WrappedDrillBody {
  const wrapped = wrapAndPadAnsiLines(body, wrapWidth);
  const lines = wrapped === "" ? [] : wrapped.split("\n");
  return { wrapped, lines, totalLines: lines.length };
}

export function useWrappedBody(body: string, wrapWidth: number): WrappedDrillBody {
  return useMemo(() => wrapDrillBody(body, wrapWidth), [body, wrapWidth]);
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
  onTuicr,
  onScrollChange,
  resetKey,
}: DrillKeymapOptions): DrillKeymap {
  const [scrollTop, setScrollTopState] = useState(0);
  const scrollTopRef = useRef(0);
  const onScrollChangeRef = useRef(onScrollChange);
  onScrollChangeRef.current = onScrollChange;
  const updateScrollTop = useCallback(
    (update: number | ((current: number) => number), notify = false): number => {
      const nextTop = typeof update === "function" ? update(scrollTopRef.current) : update;
      scrollTopRef.current = nextTop;
      setScrollTopState(nextTop);
      if (notify) onScrollChangeRef.current?.(nextTop);
      return nextTop;
    },
    [],
  );
  const wrapWidth = drillWrapWidth();
  const wrappedBody = useWrappedBody(body, wrapWidth);
  const { totalLines } = wrappedBody;

  const resetSignal = resetKey ?? body;

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetSignal intentionally preserves legacy body-based resets when resetKey is omitted, and identity-based resets when resetKey is supplied.
  useEffect(() => {
    updateScrollTop(0);
  }, [resetSignal, updateScrollTop]);

  useEffect(() => {
    updateScrollTop((s) => clampScrollTop(s, totalLines, viewport));
  }, [totalLines, updateScrollTop, viewport]);

  const dispatch = useCallback(
    (action: PopupAction) => {
      if (isNavAction(action)) {
        updateScrollTop((s) => applyScroll(s, action, totalLines, viewport), true);
        return;
      }
      switch (action.kind) {
        case "close":
          updateScrollTop(0);
          onClose();
          return;
        case "yank":
          void onYank?.();
          return;
        case "verb":
          if (action.key === "t") void onTuicr?.();
          return;
        default:
          return;
      }
    },
    [onClose, onTuicr, onYank, totalLines, updateScrollTop, viewport],
  );

  return {
    scrollTop,
    dispatch,
    wrappedBody,
    wrappedLines: wrappedBody.lines,
    totalLines,
  };
}

export interface DrillScrollViewProps {
  title: string;
  /** Already-rendered text — split on \n into lines. */
  body: string;
  /** Visible lines. Caller picks based on terminal height. */
  viewport: number;
  /** First visible line index (0-based; clamped by caller). */
  scrollTop: number;
  /** Optional dim hint rendered below the body (drill-specific
   *  recipe, e.g. ``y yanks `mu task notes <id>` `` or
   *  ``loading…``). The j/k/Esc/q nav cluster lives in the global
   *  StatusBar (popup-mode hint), so we keep this label short —
   *  single drill-specific verb hint. */
  hint?: string;
  /** Optional fallback rendered when the body is empty. */
  emptyText?: string;
  /** Already-wrapped body from useDrillKeymap; avoids wrapping twice. */
  wrappedBody?: WrappedDrillBody;
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
  wrappedBody,
}: DrillScrollViewProps): JSX.Element {
  const wrapWidth = drillWrapWidth();
  const renderedBody = useMemo(
    () => wrappedBody ?? wrapDrillBody(body, wrapWidth),
    [body, wrapWidth, wrappedBody],
  );
  const lines = renderedBody.lines;
  const totalLines = renderedBody.totalLines;
  const start = Math.max(0, Math.min(Math.max(0, totalLines - viewport), scrollTop));
  const visible = lines.slice(start, start + viewport);
  const showFallback = totalLines === 0;
  const positionLabel = showFallback
    ? "0/0"
    : `${start + 1}-${Math.min(totalLines, start + viewport)}/${totalLines}`;
  const hasHint = hint !== undefined && hint !== "";
  const headerTitleWidth = Math.max(1, wrapWidth - cellWidth(positionLabel) - 3);
  const headerTitle = truncateCell(title, headerTitleWidth);
  const hintText = hasHint ? truncateCell(hint, wrapWidth) : undefined;

  // Drill body renders inline inside the popup's existing chrome
  // (cyan rounded border + paddingX). NO nested TitledBox here:
  // a second rounded box at width=stdout.columns overflows the
  // popup's inner content area by 4 cols (popup chrome) which made
  // long lines wrap / spill past the popup's right border. Single
  // border, single width budget.
  // (bug_tui_drill_text_no_width_pin — central fix replacing the
  // earlier per-line width pin.)
  //
  // Body lines have already been ANSI-aware pre-wrapped by visual
  // width and padded to exactly the drill width (`wrapAndPadAnsiLines`
  // via useDrillKeymap / wrapDrillBody). Keep every pre-wrapped logical
  // line on exactly one terminal row: Ink's truncate path can undercount
  // ANSI-coloured text and eat the popup's trailing space + right border
  // when it has to fit an over-budget line. Because drill body rows are
  // pre-sized to the exact budget, `wrap="truncate"` is a no-op safety
  // belt rather than the fitting mechanism.
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color="magenta" wrap="truncate">
          {headerTitle}
        </Text>
        <Text dimColor wrap="truncate">
          {` · ${positionLabel}`}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {showFallback ? (
          <Text dimColor wrap="truncate">
            {emptyText ?? "(empty)"}
          </Text>
        ) : (
          visible.map((ln, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <Text key={`${start + i}`} wrap="truncate">
              {ln === "" ? " " : ln}
            </Text>
          ))
        )}
      </Box>
      {hasHint ? (
        <Box>
          <Text dimColor wrap="truncate">
            {hintText}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
