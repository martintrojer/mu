// Status bar — single dedicated row at the very bottom of the
// dashboard, btop / lazygit / k9s convention. Replaces the prior
// "footer line + tick indicator" pair.
//
// Per feat_status_bar (workstream `tui-impl`):
//   LEFT   : last yank line (was the ad-hoc "footer:" text +
//            [copied] / [no clipboard] suffix).
//   CENTER : context-sensitive key-hint cluster
//            - dashboard mode → global keys
//            - popup mode     → popup-local keys
//            - help mode      → "Esc/?/q close help"
//   RIGHT  : active workstream label (multi-ws only) + tick rate.
//
// Per feat_tui_multi_workstream (workstream `tui-impl`): when the
// TUI is launched with multiple workstreams, the right zone gains
// a `[ws]` prefix so the operator sees which tab is active without
// having to look at the top tab strip. Single-ws TUI is unchanged.
//
// Single line, no border, dim by default; bright colour for the
// single-key glyphs so the eye picks them out at a glance.
//
// Truncation policy: when the terminal is too narrow to fit all
// three zones, drop the LEFT zone first (keys are critical;
// last-yank is recoverable from the clipboard). The RIGHT zone is
// short and never dropped.

import { Box, Text } from "ink";
import type { FooterState, PopupMode } from "./app.js";
import { truncateCell } from "./columns.js";

export type StatusMode = "dashboard" | "popup" | "popup-filter" | "help";

export interface StatusBarProps {
  mode: StatusMode;
  tickMs: number;
  footer: FooterState | null;
  /** Total terminal width — drives the LEFT-truncation policy. */
  cols: number;
  /** Optional label for the popup mode (e.g. "Tasks"). */
  popupName?: string;
  /** Sub-mode inside a popup: "list" (default) or "drill". Drives
   *  the per-popup hint cluster (Enter drills vs Esc backs out). */
  popupMode?: PopupMode;
  /** Active workstream label (multi-ws TUI only). When set, the
   *  RIGHT zone renders `[<name>]  <tick>` so the operator never
   *  loses sight of which tab they are looking at. Undefined for
   *  the single-ws TUI keeps the right zone byte-identical to the
   *  pre-multi-ws layout. */
  activeWorkstream?: string;
}

export function StatusBar({
  mode,
  tickMs,
  footer,
  cols,
  popupName,
  popupMode,
  activeWorkstream,
}: StatusBarProps): JSX.Element {
  const tickLabel = `${(tickMs / 1000).toFixed(2)}s ⏱`;
  const wsLabel = activeWorkstream !== undefined ? `[${activeWorkstream}]` : "";
  const rightPlain = wsLabel === "" ? tickLabel : `${wsLabel}  ${tickLabel}`;
  const left = footer ? formatFooter(footer) : "";
  // Budget for the LEFT zone: total cols - right zone - hint cluster
  // - 4 chars of inter-zone padding. Hint cluster width is its
  // *plain* (non-coloured) length, derived from the same token list
  // that renders the JSX so the two cannot drift.
  const hintTokens = buildHints(mode, popupName, popupMode);
  const hintsWidth = hintsPlain(hintTokens).length;
  const rightWidth = rightPlain.length;
  const padding = 4;
  const leftBudget = Math.max(0, cols - rightWidth - hintsWidth - padding);
  const leftClipped = leftBudget > 0 ? truncateCell(left, leftBudget) : "";

  return (
    <Box justifyContent="space-between" width={cols}>
      <Box>
        <Text dimColor>{leftClipped}</Text>
      </Box>
      <Box>{renderHints(hintTokens)}</Box>
      <Box>
        {wsLabel !== "" && (
          <Text bold color="cyan">
            {`${wsLabel}  `}
          </Text>
        )}
        <Text dimColor>{tickLabel}</Text>
      </Box>
    </Box>
  );
}

// Hint cluster as a single declarative token stream. Both the plain
// text (used for sizing the LEFT zone's truncation budget) and the
// JSX (used for rendering) are derived from this — there is no
// second source of truth to keep in lockstep.
//
// Render order: tokens are space-separated. The plain text is
// `tokens.map(t => t.text).join(" ")`; the JSX wraps each token in
// the styling implied by its `kind`, separated by literal " "
// strings so width matches byte-for-byte.
type HintToken =
  | { kind: "key"; text: string }
  | { kind: "dim"; text: string }
  | { kind: "label"; text: string; color: "cyan" | "magenta" | "yellow" };

function buildHints(
  mode: StatusMode,
  popupName: string | undefined,
  popupMode: PopupMode | undefined,
): HintToken[] {
  const popupLabel: HintToken[] = popupName
    ? [
        { kind: "label", text: popupName, color: "cyan" },
        { kind: "dim", text: "·" },
      ]
    : [];
  switch (mode) {
    case "dashboard":
      return [
        { kind: "key", text: "g" },
        { kind: "dim", text: "DAG ·" },
        { kind: "key", text: "t" },
        { kind: "dim", text: "all-tasks ·" },
        { kind: "key", text: "0-9" },
        { kind: "dim", text: "toggle ·" },
        { kind: "key", text: "Shift 0-9" },
        { kind: "dim", text: "popup ·" },
        { kind: "key", text: "?" },
        { kind: "dim", text: "help ·" },
        { kind: "key", text: "q" },
        { kind: "dim", text: "quit ·" },
        { kind: "key", text: "+/-" },
        { kind: "dim", text: "tick ·" },
        { kind: "key", text: "r" },
        { kind: "dim", text: "refresh" },
      ];
    case "popup":
      if (popupMode === "drill") {
        return [
          ...popupLabel,
          { kind: "label", text: "drill", color: "magenta" },
          { kind: "dim", text: "·" },
          { kind: "key", text: "j/k" },
          { kind: "dim", text: "scroll ·" },
          { kind: "key", text: "Esc" },
          { kind: "dim", text: "back ·" },
          { kind: "key", text: "?" },
          { kind: "dim", text: "help ·" },
          { kind: "key", text: "q" },
          { kind: "dim", text: "back" },
        ];
      }
      if (popupName === "DAG") {
        return [
          ...popupLabel,
          { kind: "key", text: "o/i/c/r/d" },
          { kind: "dim", text: "toggle status ·" },
          { kind: "key", text: "j/k" },
          { kind: "dim", text: "scroll ·" },
          { kind: "key", text: "y" },
          { kind: "dim", text: "yank ·" },
          { kind: "key", text: "Esc" },
          { kind: "dim", text: "close ·" },
          { kind: "key", text: "?" },
          { kind: "dim", text: "help ·" },
          { kind: "key", text: "q" },
          { kind: "dim", text: "quit" },
        ];
      }
      if (popupName === "All tasks") {
        return [
          ...popupLabel,
          { kind: "key", text: "s" },
          { kind: "dim", text: "sort ·" },
          { kind: "key", text: "o/i/c/r/d" },
          { kind: "dim", text: "filter ·" },
          { kind: "key", text: "j/k" },
          { kind: "dim", text: "nav ·" },
          { kind: "key", text: "/" },
          { kind: "dim", text: "search ·" },
          { kind: "key", text: "Enter" },
          { kind: "dim", text: "drill ·" },
          { kind: "key", text: "y" },
          { kind: "dim", text: "yank ·" },
          { kind: "key", text: "Esc" },
          { kind: "dim", text: "close" },
        ];
      }
      return [
        ...popupLabel,
        { kind: "key", text: "j/k" },
        { kind: "dim", text: "nav ·" },
        { kind: "key", text: "Shift 0-9" },
        { kind: "dim", text: "switch popup ·" },
        { kind: "key", text: "/" },
        { kind: "dim", text: "filter ·" },
        { kind: "key", text: "Enter" },
        { kind: "dim", text: "drill ·" },
        { kind: "key", text: "y" },
        { kind: "dim", text: "yank ·" },
        { kind: "key", text: "Esc" },
        { kind: "dim", text: "close ·" },
        { kind: "key", text: "?" },
        { kind: "dim", text: "help ·" },
        { kind: "key", text: "q" },
        { kind: "dim", text: "quit" },
      ];
    case "popup-filter":
      return [
        ...popupLabel,
        { kind: "label", text: "filter", color: "yellow" },
        { kind: "dim", text: "·" },
        { kind: "key", text: "Esc" },
        { kind: "dim", text: "cancel ·" },
        { kind: "key", text: "Enter" },
        { kind: "dim", text: "commit ·" },
        { kind: "key", text: "Bksp" },
        { kind: "dim", text: "edit" },
      ];
    case "help":
      return [
        { kind: "key", text: "Esc/?/q" },
        { kind: "dim", text: "close help" },
      ];
  }
}

function hintsPlain(tokens: HintToken[]): string {
  return tokens.map((t) => t.text).join(" ");
}

function renderHints(tokens: HintToken[]): JSX.Element {
  // Interleave tokens with literal " " separators so the rendered
  // width matches `hintsPlain(tokens)` byte-for-byte. ink flattens
  // children into a single inline run, so no per-child keys are
  // required (and react treats string children as keyed by index).
  const children: React.ReactNode[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0) children.push(" ");
    children.push(renderToken(tokens[i] as HintToken, i));
  }
  return <Text>{children}</Text>;
}

function renderToken(t: HintToken, key: number): JSX.Element {
  switch (t.kind) {
    case "key":
      return (
        <Text key={key} color="yellow">
          {t.text}
        </Text>
      );
    case "dim":
      return (
        <Text key={key} dimColor>
          {t.text}
        </Text>
      );
    case "label":
      return (
        <Text key={key} bold color={t.color}>
          {t.text}
        </Text>
      );
  }
}

function formatFooter(f: FooterState): string {
  const tag = f.copied ? "[copied]" : "[no clipboard]";
  return `last: ${f.command}  ${tag}`;
}
