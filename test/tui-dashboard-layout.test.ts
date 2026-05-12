import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layoutColumns } from "../src/cli/tui/layout.js";

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
    expect(APP_SRC).toContain("layoutDashboardColumns(cols, visible)");
    expect(APP_SRC).toContain('<Box flexDirection="row" gap={1}>');
    expect(APP_SRC).toContain(
      '<Box key={assignment.cards.join("-")} flexDirection="column" width={width}>',
    );
  });

  it("dashboard passes per-column width and row budgets to each card", () => {
    expect(APP_SRC).toContain("columnWidths(cols, assignments.length)");
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
