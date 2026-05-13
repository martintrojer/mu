// Help overlay (?). Renders the TUI keymap superset from the shared
// keymap spec. Status-bar hint clusters are intentionally smaller:
// they show only the keys that should be always visible in the current
// mode. The help overlay is the exhaustive reference.

import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { HELP_PANES } from "./keymap-spec.js";
import { type PopupAction, dispatchPopupKeyFromInk } from "./keys.js";
import { applyScroll, clampScrollTop, isNavAction } from "./popups/scroll.js";
import { TitledBox } from "./titled-box.js";

export type HelpRenderRow =
  | { kind: "header"; text: string }
  | { kind: "row"; keys: string; effect: string }
  | { kind: "separator" };

export const HELP_CHROME_ROWS = 3;

export function flattenHelpRows(): HelpRenderRow[] {
  return HELP_PANES.flatMap((pane, paneIdx) => {
    const rows: HelpRenderRow[] = [
      ...(paneIdx > 0 ? ([{ kind: "separator" }] as HelpRenderRow[]) : []),
      { kind: "header", text: pane.title },
      ...pane.rows.map(
        (row): HelpRenderRow => ({
          kind: "row",
          keys: row.keys,
          effect: row.effect,
        }),
      ),
    ];
    return rows;
  });
}

export function helpViewport(rows: number): number {
  return Math.max(1, rows - HELP_CHROME_ROWS);
}

export function helpPositionLabel(
  scrollTop: number,
  viewport: number,
  totalRows: number,
): string | undefined {
  if (totalRows <= viewport) return undefined;
  const start = Math.min(totalRows, scrollTop + 1);
  const end = Math.min(totalRows, scrollTop + viewport);
  return `${start}-${end}/${totalRows}`;
}

export function applyHelpScroll(
  scrollTop: number,
  action: PopupAction,
  rows: number,
  totalRows: number,
): number {
  if (!isNavAction(action)) return scrollTop;
  return applyScroll(scrollTop, action, totalRows, helpViewport(rows));
}

export interface HelpProps {
  rows: number;
}

export function Help({ rows }: HelpProps): JSX.Element {
  const flatRows = useMemo(() => flattenHelpRows(), []);
  const [scrollTop, setScrollTop] = useState(0);
  const totalRows = flatRows.length;

  useInput((input, key) => {
    const action = dispatchPopupKeyFromInk(input, key);
    setScrollTop((s) => applyHelpScroll(s, action, rows, totalRows));
  });

  return <HelpView rows={rows} scrollTop={scrollTop} flatRows={flatRows} />;
}

export interface HelpViewProps {
  rows: number;
  scrollTop?: number;
  flatRows?: readonly HelpRenderRow[];
}

export function HelpView({
  rows,
  scrollTop = 0,
  flatRows = flattenHelpRows(),
}: HelpViewProps): JSX.Element {
  const cols = process.stdout.columns ?? 80;
  const contentWidth = Math.max(1, cols - 4); // border + paddingX on both sides
  const viewport = helpViewport(rows);
  const totalRows = flatRows.length;
  const clampedScrollTop = clampScrollTop(scrollTop, totalRows, viewport);
  const visibleRows = flatRows.slice(clampedScrollTop, clampedScrollTop + viewport);
  const positionLabel = helpPositionLabel(clampedScrollTop, viewport, totalRows);
  const title = positionLabel === undefined ? "keys" : `keys · ${positionLabel}`;

  return (
    <TitledBox title={title} borderColor="cyan" titleColor="cyan" width={cols}>
      <Box flexDirection="column" width={contentWidth}>
        {visibleRows.map((row, idx) => renderHelpLine(row, contentWidth, clampedScrollTop + idx))}
      </Box>
    </TitledBox>
  );
}

function renderHelpLine(row: HelpRenderRow, contentWidth: number, index: number): JSX.Element {
  switch (row.kind) {
    case "separator":
      return <Text key={index}> </Text>;
    case "header":
      return (
        <Box key={index} width={contentWidth}>
          <Text bold color="cyan">
            {row.text}
          </Text>
        </Box>
      );
    case "row":
      return (
        <HelpRow key={index} keys={row.keys} effect={row.effect} contentWidth={contentWidth} />
      );
  }
}

function HelpRow({
  keys,
  effect,
  contentWidth,
}: {
  keys: string;
  effect: string;
  contentWidth: number;
}): JSX.Element {
  return (
    <Box width={contentWidth}>
      <Box width={18}>
        <Text color="yellow" wrap="truncate">
          {keys}
        </Text>
      </Box>
      <Box width={Math.max(1, contentWidth - 18)}>
        <Text dimColor wrap="truncate">
          {effect}
        </Text>
      </Box>
    </Box>
  );
}
