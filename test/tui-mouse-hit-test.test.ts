import { describe, expect, it } from "vitest";
import {
  CARD_CONFIGS,
  type CardId,
  type RowBudgetMap,
  columnWidths,
  dashboardCardHitRegions,
  hitTestDashboardCard,
  layoutColumns,
} from "../src/cli/tui/layout.js";

const EMPTY_BUDGETS: RowBudgetMap = {
  0: 0,
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
  6: 0,
  7: 0,
  8: 0,
  9: 0,
};
const ALL_CARDS: CardId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function budgetFor(cards: readonly CardId[], rows: number): RowBudgetMap {
  const out: Record<CardId, number> = { ...EMPTY_BUDGETS };
  for (const id of cards) out[id] = rows;
  return out;
}

function budgetForMap(assignments: ReturnType<typeof layoutColumns>): RowBudgetMap[] {
  return assignments.map((assignment) => {
    const out: Record<CardId, number> = { ...EMPTY_BUDGETS };
    for (const id of assignment.cards) out[id] = CARD_CONFIGS[id].minRows + id;
    return out;
  });
}

function centre(region: { left: number; right: number; top: number; bottom: number }) {
  return {
    x: Math.floor((region.left + region.right) / 2),
    y: Math.floor((region.top + region.bottom) / 2),
  };
}

describe("dashboard mouse hit-test", () => {
  it("maps a point inside a card to that card id", () => {
    const assignments = layoutColumns(80, [1, 3]);
    const budgets = assignments.map((a) => budgetFor(a.cards, 3));
    const regions = dashboardCardHitRegions(assignments, [{ width: 80 }], budgets);
    expect(hitTestDashboardCard(regions, { x: 10, y: 5 })).toBe(1);
    expect(hitTestDashboardCard(regions, { x: 10, y: 10 })).toBe(3);
  });

  it("2-column layout maps every card's geometric centre to that card", () => {
    const assignments = layoutColumns(140, ALL_CARDS);
    const regions = dashboardCardHitRegions(
      assignments,
      columnWidths(140, assignments.length),
      budgetForMap(assignments),
    );
    expect(regions.map((r) => r.id).sort((a, b) => a - b)).toEqual(ALL_CARDS);

    for (const region of regions) {
      expect(hitTestDashboardCard(regions, centre(region)), `card ${region.id}`).toBe(region.id);
    }
  });

  it("uses the budgeted render height for empty-state cards too", () => {
    const assignments = layoutColumns(140, [3, 7, 8]);
    const budgets = assignments.map((assignment) => {
      const out: Record<CardId, number> = { ...EMPTY_BUDGETS };
      for (const id of assignment.cards) out[id] = id === 7 ? 10 : 3;
      return out;
    });
    const regions = dashboardCardHitRegions(
      assignments,
      columnWidths(140, assignments.length),
      budgets,
    );
    const blocked = regions.find((r) => r.id === 7);
    expect(blocked).toBeDefined();
    if (blocked === undefined) return;

    expect(blocked.bottom - blocked.top + 1).toBe(CARD_CONFIGS[7].chrome + 10);
    expect(hitTestDashboardCard(regions, centre(blocked))).toBe(7);
  });

  it("includes border rows and excludes the one-row gap between columns", () => {
    const assignments = layoutColumns(140, [1, 3]);
    const budgets = assignments.map((a) => budgetFor(a.cards, 2));
    const regions = dashboardCardHitRegions(assignments, [{ width: 70 }, { width: 69 }], budgets);
    const agents = regions.find((r) => r.id === 1);
    const ready = regions.find((r) => r.id === 3);
    expect(agents).toBeDefined();
    expect(ready).toBeDefined();
    if (agents === undefined || ready === undefined) return;

    expect(hitTestDashboardCard(regions, { x: agents.left, y: agents.top })).toBe(1);
    expect(hitTestDashboardCard(regions, { x: agents.right, y: agents.bottom })).toBe(1);
    expect(hitTestDashboardCard(regions, { x: ready.left, y: ready.top })).toBe(3);
    expect(hitTestDashboardCard(regions, { x: agents.right + 1, y: agents.top })).toBeNull();
  });

  it("honours tab-strip and snapshot-error dashboardTop offsets", () => {
    const assignments = layoutColumns(80, [1]);
    const budgets = assignments.map((a) => budgetFor(a.cards, 2));
    const regions = dashboardCardHitRegions(assignments, [{ width: 80 }], budgets, { top: 5 });
    expect(hitTestDashboardCard(regions, { x: 10, y: 4 })).toBeNull();
    expect(hitTestDashboardCard(regions, { x: 10, y: 5 })).toBe(1);
  });

  it("returns null outside every card", () => {
    const assignments = layoutColumns(140, [1, 3]);
    const budgets = assignments.map((a) => budgetFor(a.cards, 2));
    const regions = dashboardCardHitRegions(assignments, [{ width: 70 }, { width: 69 }], budgets);
    expect(hitTestDashboardCard(regions, { x: 200, y: 5 })).toBeNull();
    expect(hitTestDashboardCard(regions, { x: 71, y: 5 })).toBeNull();
  });
});
