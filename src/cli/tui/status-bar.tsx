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
//   RIGHT  : tick rate (always visible).
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
}

export function StatusBar({
  mode,
  tickMs,
  footer,
  cols,
  popupName,
  popupMode,
}: StatusBarProps): JSX.Element {
  const tickLabel = `${(tickMs / 1000).toFixed(2)}s ⏱`;
  const left = footer ? formatFooter(footer) : "";
  // Budget for the LEFT zone: total cols - tick rate - hint cluster
  // - 4 chars of inter-zone padding. Hint cluster width is its
  // *plain* (non-coloured) length which we approximate via the
  // string returned from hintsPlain().
  const hintsPlainText = hintsPlain(mode, popupName, popupMode);
  const tickWidth = tickLabel.length;
  const hintsWidth = hintsPlainText.length;
  const padding = 4;
  const leftBudget = Math.max(0, cols - tickWidth - hintsWidth - padding);
  const leftClipped = leftBudget > 0 ? truncateCell(left, leftBudget) : "";

  return (
    <Box justifyContent="space-between" width={cols}>
      <Box>
        <Text dimColor>{leftClipped}</Text>
      </Box>
      <Box>{renderHints(mode, popupName, popupMode)}</Box>
      <Box>
        <Text dimColor>{tickLabel}</Text>
      </Box>
    </Box>
  );
}

// Plain-text version of the hint cluster used purely to size the
// LEFT zone's truncation budget. Keep in lockstep with renderHints().
function hintsPlain(
  mode: StatusMode,
  popupName: string | undefined,
  popupMode: PopupMode | undefined,
): string {
  switch (mode) {
    case "dashboard":
      return "1-4 toggle · !@#$ popup · ?/F1 help · q quit · +/- tick · r refresh";
    case "popup": {
      const label = popupName ? `${popupName} · ` : "";
      if (popupMode === "drill") {
        return `${label}drill · j/k scroll · Esc back · ? help · q back`;
      }
      return `${label}j/k nav · / filter · Enter drill · y yank · Esc close · ? help · q quit`;
    }
    case "popup-filter": {
      const label = popupName ? `${popupName} · filter · ` : "filter · ";
      return `${label}Esc cancel · Enter commit · Bksp edit`;
    }
    case "help":
      return "Esc/?/q close help";
  }
}

function renderHints(
  mode: StatusMode,
  popupName: string | undefined,
  popupMode: PopupMode | undefined,
): JSX.Element {
  switch (mode) {
    case "dashboard":
      return (
        <Text>
          <Key>1-4</Key> <Text dimColor>toggle ·</Text> <Key>!@#$</Key>{" "}
          <Text dimColor>popup ·</Text> <Key>?/F1</Key> <Text dimColor>help ·</Text> <Key>q</Key>{" "}
          <Text dimColor>quit ·</Text> <Key>+/-</Key> <Text dimColor>tick ·</Text> <Key>r</Key>{" "}
          <Text dimColor>refresh</Text>
        </Text>
      );
    case "popup": {
      const label = popupName ? (
        <>
          <Text bold color="cyan">
            {popupName}
          </Text>{" "}
          <Text dimColor>·</Text>{" "}
        </>
      ) : null;
      if (popupMode === "drill") {
        return (
          <Text>
            {label}
            <Text bold color="magenta">
              drill
            </Text>{" "}
            <Text dimColor>·</Text> <Key>j/k</Key> <Text dimColor>scroll ·</Text> <Key>Esc</Key>{" "}
            <Text dimColor>back ·</Text> <Key>?</Key> <Text dimColor>help ·</Text> <Key>q</Key>{" "}
            <Text dimColor>back</Text>
          </Text>
        );
      }
      return (
        <Text>
          {label}
          <Key>j/k</Key> <Text dimColor>nav ·</Text> <Key>/</Key> <Text dimColor>filter ·</Text>{" "}
          <Key>Enter</Key> <Text dimColor>drill ·</Text> <Key>y</Key> <Text dimColor>yank ·</Text>{" "}
          <Key>Esc</Key> <Text dimColor>close ·</Text> <Key>?</Key> <Text dimColor>help ·</Text>{" "}
          <Key>q</Key> <Text dimColor>quit</Text>
        </Text>
      );
    }
    case "popup-filter": {
      const label = popupName ? (
        <>
          <Text bold color="cyan">
            {popupName}
          </Text>{" "}
          <Text dimColor>·</Text>{" "}
        </>
      ) : null;
      return (
        <Text>
          {label}
          <Text bold color="yellow">
            filter
          </Text>{" "}
          <Text dimColor>·</Text> <Key>Esc</Key> <Text dimColor>cancel ·</Text> <Key>Enter</Key>{" "}
          <Text dimColor>commit ·</Text> <Key>Bksp</Key> <Text dimColor>edit</Text>
        </Text>
      );
    }
    case "help":
      return (
        <Text>
          <Key>Esc/?/q</Key> <Text dimColor>close help</Text>
        </Text>
      );
  }
}

function Key({ children }: { children: React.ReactNode }): JSX.Element {
  return <Text color="yellow">{children}</Text>;
}

function formatFooter(f: FooterState): string {
  const tag = f.copied ? "[copied]" : "[no clipboard]";
  return `last: ${f.command}  ${tag}`;
}
