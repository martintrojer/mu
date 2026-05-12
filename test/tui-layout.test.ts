import { describe, expect, it } from "vitest";
import {
  type CardId,
  allocateRowBudgets,
  columnWidths,
  dashboardColumnCount,
  layoutColumns,
} from "../src/cli/tui/layout.js";

const ALL: CardId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function ids(cols: number, visible: CardId[] = ALL): CardId[][] {
  return layoutColumns(cols, visible).map((c) => c.cards);
}

describe("dashboard responsive layout", () => {
  it("Cols=70: 1 column, all cards in it", () => {
    expect(dashboardColumnCount(70)).toBe(1);
    expect(ids(70)).toEqual([ALL]);
  });

  it("Cols=140: 2 columns, small-pair left and task-list+stream right", () => {
    expect(dashboardColumnCount(140)).toBe(2);
    expect(ids(140)).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8, 0, 4],
    ]);
  });

  it("Cols=200: 3 columns", () => {
    expect(dashboardColumnCount(200)).toBe(3);
    expect(ids(200)).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8],
      [0, 4],
    ]);
  });

  it("Cols=260: 4 columns split small pairs, task-list, and stream", () => {
    expect(dashboardColumnCount(260)).toBe(4);
    expect(ids(260)).toEqual([
      [1, 2],
      [5, 9],
      [3, 6, 7, 8],
      [0, 4],
    ]);
  });

  it("toggling cards off repacks without blank columns", () => {
    expect(ids(200, [1, 2, 3, 5, 7])).toEqual([
      [1, 2, 5],
      [3, 7],
    ]);
    expect(ids(140, [1, 2, 3, 5, 7])).toEqual([
      [1, 2, 5],
      [3, 7],
    ]);
  });

  it("computes gap-aware integer column widths", () => {
    expect(columnWidths(140, 2).map((c) => c.width)).toEqual([70, 69]);
    expect(columnWidths(200, 3).map((c) => c.width)).toEqual([66, 66, 66]);
    expect(columnWidths(0, 0)).toEqual([]);
  });
});

describe("dashboard row-budget allocator", () => {
  it("returns natural rows when there is no contention", () => {
    const budgets = allocateRowBudgets(80, [
      { id: 1, dataCount: 1 },
      { id: 3, dataCount: 4 },
      { id: 4, dataCount: 2 },
    ]);
    expect(budgets[1]).toBe(2); // min guarantee beats dataCount=1
    expect(budgets[3]).toBe(4);
    expect(budgets[4]).toBe(3); // min guarantee beats dataCount=2
  });

  it("caps one huge card at maxRows while siblings keep min guarantees", () => {
    const budgets = allocateRowBudgets(80, [
      { id: 3, dataCount: 100 }, // Ready maxRows=15
      { id: 1, dataCount: 1 },
      { id: 2, dataCount: 1 },
      { id: 9, dataCount: 0 },
    ]);
    expect(budgets[3]).toBe(15);
    expect(budgets[1]).toBeGreaterThanOrEqual(2);
    expect(budgets[2]).toBeGreaterThanOrEqual(2);
    expect(budgets[9]).toBeGreaterThanOrEqual(2);
    expect(budgets[1] + budgets[2] + budgets[3] + budgets[9]).toBe(21);
  });

  it("uses largest-remainder leftover distribution after min rows", () => {
    const budgets = allocateRowBudgets(29, [
      { id: 3, dataCount: 9 },
      { id: 6, dataCount: 5 },
      { id: 7, dataCount: 5 },
    ]);
    // bodyAvailable = 29 - chrome(12) = 17. Min total = 9. The
    // weighted 8-row remainder is 3.78 / 2.10 / 2.10, so Ready wins
    // the largest-remainder row after floors.
    expect([budgets[3], budgets[6], budgets[7]]).toEqual([7, 5, 5]);
  });

  it("empty-data cards still get their min row count", () => {
    const budgets = allocateRowBudgets(16, [
      { id: 1, dataCount: 0 },
      { id: 2, dataCount: 0 },
    ]);
    expect(budgets[1]).toBe(2);
    expect(budgets[2]).toBe(2);
  });
});
