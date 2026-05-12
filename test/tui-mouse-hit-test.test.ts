import { describe, expect, it } from "vitest";
import {
  type CardId,
  type RowBudgetMap,
  dashboardCardHitRegions,
  hitTestDashboardCard,
  layoutColumns,
} from "../src/cli/tui/layout.js";

const EMPTY_BUDGETS: RowBudgetMap = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };

function budgetFor(cards: readonly CardId[], rows: number): RowBudgetMap {
  const out: Record<CardId, number> = { ...EMPTY_BUDGETS };
  for (const id of cards) out[id] = rows;
  return out;
}

describe("dashboard mouse hit-test", () => {
  it("maps a point inside a card to that card id", () => {
    const assignments = layoutColumns(80, [1, 3]);
    const budgets = assignments.map((a) => budgetFor(a.cards, 3));
    const regions = dashboardCardHitRegions(assignments, [{ width: 80 }], budgets);
    expect(hitTestDashboardCard(regions, { x: 10, y: 5 })).toBe(1);
    expect(hitTestDashboardCard(regions, { x: 10, y: 10 })).toBe(3);
  });

  it("returns null outside every card", () => {
    const assignments = layoutColumns(140, [1, 3]);
    const budgets = assignments.map((a) => budgetFor(a.cards, 2));
    const regions = dashboardCardHitRegions(assignments, [{ width: 70 }, { width: 69 }], budgets);
    expect(hitTestDashboardCard(regions, { x: 200, y: 5 })).toBeNull();
    expect(hitTestDashboardCard(regions, { x: 71, y: 5 })).toBeNull();
  });
});
