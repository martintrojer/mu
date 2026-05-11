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
import type { FooterState } from "./app.js";
import { truncateCell } from "./columns.js";

export type StatusMode = "dashboard" | "popup" | "help";

export interface StatusBarProps {
  mode: StatusMode;
  tickMs: number;
  footer: FooterState | null;
  /** Total terminal width — drives the LEFT-truncation policy. */
  cols: number;
  /** Optional label for the popup mode (e.g. "Tasks"). */
  popupName?: string;
}

export function StatusBar({ mode, tickMs, footer, cols, popupName }: StatusBarProps): JSX.Element {
  const tickLabel = `${(tickMs / 1000).toFixed(2)}s ⏱`;
  const left = footer ? formatFooter(footer) : "";
  // Budget for the LEFT zone: total cols - tick rate - hint cluster
  // - 4 chars of inter-zone padding. Hint cluster width is its
  // *plain* (non-coloured) length which we approximate via the
  // string returned from hintsPlain().
  const hintsPlainText = hintsPlain(mode, popupName);
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
      <Box>{renderHints(mode, popupName)}</Box>
      <Box>
        <Text dimColor>{tickLabel}</Text>
      </Box>
    </Box>
  );
}

// Plain-text version of the hint cluster used purely to size the
// LEFT zone's truncation budget. Keep in lockstep with renderHints().
function hintsPlain(mode: StatusMode, popupName: string | undefined): string {
  switch (mode) {
    case "dashboard":
      return "1-4 toggle · !@#$ popup · ?/F1 help · q quit · +/- tick · r refresh";
    case "popup": {
      const label = popupName ? `${popupName} · ` : "";
      return `${label}j/k nav · y yank · Esc close · ? help · q quit`;
    }
    case "help":
      return "Esc/?/q close help";
  }
}

function renderHints(mode: StatusMode, popupName: string | undefined): JSX.Element {
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
    case "popup":
      return (
        <Text>
          {popupName ? (
            <>
              <Text bold color="cyan">
                {popupName}
              </Text>{" "}
              <Text dimColor>·</Text>{" "}
            </>
          ) : null}
          <Key>j/k</Key> <Text dimColor>nav ·</Text> <Key>y</Key> <Text dimColor>yank ·</Text>{" "}
          <Key>Esc</Key> <Text dimColor>close ·</Text> <Key>?</Key> <Text dimColor>help ·</Text>{" "}
          <Key>q</Key> <Text dimColor>quit</Text>
        </Text>
      );
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
