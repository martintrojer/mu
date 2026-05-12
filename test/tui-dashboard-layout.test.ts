import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Box, Text } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { type CardId, cullCardsForRows, layoutColumns } from "../src/cli/tui/layout.js";
import { TitledBox } from "../src/cli/tui/titled-box.js";
import { renderCardToText } from "./_card-render.js";

const APP_SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "cli", "tui", "app.tsx"),
  "utf8",
);
const LAYOUT_SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "cli", "tui", "layout.ts"),
  "utf8",
);

describe("dashboard responsive-layout wiring", () => {
  it("dashboard renders a row of column boxes instead of a flat card stack", () => {
    expect(APP_SRC).toContain("function DashboardColumns");
    expect(APP_SRC).toContain("layoutDashboardColumns(cols, culled.cards)");
    expect(APP_SRC).toContain(
      '<Box flexDirection="row" gap={1} height={cardsRows} overflow="hidden">',
    );
    expect(APP_SRC).toContain(
      '<Box key={assignment.cards.join("-")} flexDirection="column" width={width}>',
    );
  });

  it("dashboard passes per-column width and row budgets to each card", () => {
    expect(APP_SRC).toContain("columnWidths(cols, assignments.length)");
    expect(APP_SRC).toContain("cullCardsForRows(visible, rows)");
    expect(APP_SRC).toContain("+{culled.hidden.length} cards hidden · resize taller");
    expect(APP_SRC).toContain("allocateRowBudgets(");
    for (const component of [
      "AgentsCard",
      "TracksCard",
      "ReadyCard",
      "LogCard",
      "WorkspacesCard",
      "InProgressCard",
      "BlockedCard",
      "CommitsCard",
      "RecentCard",
      "DoctorCard",
    ]) {
      expect(APP_SRC).toMatch(
        new RegExp(`<${component}[\\s\\S]*?rowBudget=\\{rowBudget\\}[\\s\\S]*?cols=\\{width\\}`),
      );
    }
  });

  it("dashboard card order matches the expected responsive breakpoints", () => {
    expect(layoutColumns(80, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).map((c) => c.cards)).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 0],
    ]);
    expect(layoutColumns(140, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).map((c) => c.cards)).toEqual([
      [1, 2, 5, 9, 4],
      [3, 6, 7, 8, 0],
    ]);
    expect(layoutColumns(200, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).map((c) => c.cards)).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8],
      [4, 0],
    ]);
    expect(layoutColumns(260, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).map((c) => c.cards)).toEqual([
      [1, 2],
      [5, 9],
      [3, 6, 7, 8],
      [4, 0],
    ]);
  });

  it("small-pane dashboard walk renders surviving cards plus the hidden-card hint", () => {
    const text = renderCardToText(smallDashboardTree(10));
    expect(text).toContain("Agents");
    expect(text).toContain("Ready");
    expect(text).toContain("+8 cards hidden · resize taller");
    for (const hiddenTitle of [
      "Doctor",
      "Recent",
      "Workspaces",
      "Tracks",
      "Blocked",
      "In-progress",
      "Activity log",
      "Commits",
    ]) {
      expect(text).not.toContain(hiddenTitle);
    }
  });

  it("pair-aware groups match the 0-9 card design", () => {
    expect(LAYOUT_SRC).toMatch(/0: \{[^}]*group: "stream"/);
    expect(LAYOUT_SRC).toMatch(/1: \{[^}]*group: "small-pair"/);
    expect(LAYOUT_SRC).toMatch(/2: \{[^}]*group: "small-pair"/);
    expect(LAYOUT_SRC).toMatch(/5: \{[^}]*group: "small-pair"/);
    expect(LAYOUT_SRC).toMatch(/9: \{[^}]*group: "small-pair"/);
    expect(LAYOUT_SRC).toMatch(/3: \{[^}]*group: "task-list"/);
    expect(LAYOUT_SRC).toMatch(/6: \{[^}]*group: "task-list"/);
    expect(LAYOUT_SRC).toMatch(/7: \{[^}]*group: "task-list"/);
    expect(LAYOUT_SRC).toMatch(/4: \{[^}]*group: "stream"/);
    expect(LAYOUT_SRC).toMatch(/8: \{[^}]*group: "task-list"/);
    expect(APP_SRC).toMatch(/case 0:\s*\n\s*return <CommitsCard/);
    expect(APP_SRC).toMatch(/case 8:\s*\n\s*return <RecentCard/);
    expect(LAYOUT_SRC).toContain("Recent");
  });
});

function smallDashboardTree(rows: number): JSX.Element {
  const culled = cullCardsForRows([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], rows);
  return createElement(
    Box,
    { flexDirection: "column", height: rows, overflow: "hidden" },
    culled.cards.map((id) =>
      createElement(
        TitledBox,
        { key: id, title: titleForCard(id), cardId: id },
        createElement(Text, null, `${titleForCard(id)} row`),
      ),
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
