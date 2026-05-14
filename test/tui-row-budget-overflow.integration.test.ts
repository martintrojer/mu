import { Box, Text, render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CardId,
  allocateRowBudgets,
  columnWidths,
  cullCardsForRows,
  layoutColumns,
} from "../src/cli/tui/layout.js";
import { TitledBox } from "../src/cli/tui/titled-box.js";
import { renderCardToText } from "./_card-render.js";
import { CaptureStream, collectRenderedLines, createInkCaptureStream } from "./_ink-render.js";

const ALL: CardId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const ROWS = [5, 10, 20, 40] as const;

afterEach(() => {
  CaptureStream.cleanup();
});

describe("dashboard low-row overflow regression", () => {
  it.each(ROWS)("keeps rendered dashboard height within a %i-row pane", async (rows) => {
    const lines = await renderDashboardFrame(rows);
    expect(lines.length).toBeLessThanOrEqual(rows);
  });

  it.each(ROWS)(
    "does not render one card's bottom border on the same line as another card's content at %i rows",
    async (rows) => {
      const lines = await renderDashboardFrame(rows);
      for (const line of lines) {
        const bottomBeforeContent =
          line.indexOf("╰") >= 0 && line.indexOf("content") > line.indexOf("╰");
        if (!bottomBeforeContent) continue;
        expect(line.slice(line.indexOf("╰"), line.indexOf("content"))).toContain("╯ │");
      }
    },
  );

  it("walk-introspection sees only surviving cards plus the hidden-cards hint on a small pane", () => {
    // pack_dashboard_cards_tighter (chrome 4 → 2): the cull keeps the
    // four highest-priority slots at 10 rows now (mirrors the unit
    // expectation in test/tui-dashboard-layout.test.ts).
    const node = dashboardTreeForRows(10);
    const text = renderCardToText(node);
    expect(text).toContain("Agents");
    expect(text).toContain("Ready");
    expect(text).toContain("Commits");
    expect(text).toContain("Activity log");
    for (const hiddenTitle of [
      "Doctor",
      "Recent",
      "Workspaces",
      "Tracks",
      "Blocked",
      "In-progress",
    ]) {
      expect(text).not.toContain(hiddenTitle);
    }
    expect(text).toContain("+6 cards hidden · resize taller");
  });
});

function dashboardTreeForRows(rows: number): JSX.Element {
  const culled = cullCardsForRows(ALL, rows);
  const cardsRows = culled.hidden.length > 0 ? Math.max(1, rows - 1) : rows;
  const assignments = layoutColumns(140, culled.cards);
  const widths = columnWidths(140, assignments.length);

  return createElement(
    Box,
    { flexDirection: "column", height: rows, overflow: "hidden" },
    createElement(
      Box,
      { flexDirection: "row", gap: 1, height: cardsRows, overflow: "hidden" },
      assignments.map((assignment, i) => {
        const width = widths[i]?.width ?? 140;
        const budgets = allocateRowBudgets(
          cardsRows,
          assignment.cards.map((id) => ({ id, dataCount: 20 })),
        );
        return createElement(
          Box,
          { key: assignment.cards.join("-"), flexDirection: "column", width },
          assignment.cards.map((id) =>
            createElement(
              TitledBox,
              { key: id, width, title: titleForCard(id), cardId: id },
              Array.from({ length: budgets[id] }, (_, row) =>
                createElement(Text, { key: row }, `card ${id} content row ${row}`),
              ),
            ),
          ),
        );
      }),
    ),
    culled.hidden.length > 0
      ? createElement(
          Text,
          { dimColor: true },
          `+${culled.hidden.length} cards hidden · resize taller`,
        )
      : null,
  );
}

async function renderDashboardFrame(rows: number): Promise<string[]> {
  const stdout = createInkCaptureStream({ columns: 140, rows });
  const instance = render(dashboardTreeForRows(rows), {
    stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    debug: true,
    patchConsole: false,
  });
  const lines = await collectRenderedLines(stdout);
  instance.unmount();
  return lines;
}

function titleForCard(id: CardId): string {
  switch (id) {
    case 0:
      return "Commits";
    case 1:
      return "Agents";
    case 2:
      return "Tracks";
    case 3:
      return "Ready";
    case 4:
      return "Activity log";
    case 5:
      return "Workspaces";
    case 6:
      return "In-progress";
    case 7:
      return "Blocked";
    case 8:
      return "Recent";
    case 9:
      return "Doctor";
  }
}
