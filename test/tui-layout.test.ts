import { describe, expect, it } from "vitest";
import {
  type CardId,
  allocateRowBudgets,
  columnWidths,
  cullCardsForRows,
  dashboardColumnCount,
  layoutColumns,
} from "../src/cli/tui/layout.js";

const ALL: CardId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function ids(cols: number, visible: CardId[] = ALL): CardId[][] {
  return layoutColumns(cols, visible).map((c) => c.cards);
}

describe("dashboard responsive layout", () => {
  it("Cols=70: 1 column, all cards sorted slot ASC with slot 0 trailing", () => {
    expect(dashboardColumnCount(70)).toBe(1);
    expect(ids(70)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 0]]);
  });

  it("Cols=140: 2 columns, streams split as column trailers for 5/5 balance", () => {
    expect(dashboardColumnCount(140)).toBe(2);
    expect(ids(140)).toEqual([
      [1, 2, 5, 9, 4],
      [3, 6, 7, 8, 0],
    ]);
  });

  it("Cols=140: slot 0 off keeps Activity log as the left-column trailer", () => {
    expect(ids(140, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9, 4],
      [3, 6, 7, 8],
    ]);
  });

  it("Cols=140: slot 4 off keeps Commits as the right-column trailer", () => {
    expect(ids(140, [0, 1, 2, 3, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8, 0],
    ]);
  });

  it("Cols=140: both stream cards off leaves small-pair left and task-list right", () => {
    expect(ids(140, [1, 2, 3, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8],
    ]);
  });

  it("Cols=140: only slot 3 visible returns a single non-empty column", () => {
    expect(ids(140, [3])).toEqual([[3]]);
  });

  it("Cols=200: 3 columns keep groups, sorted with slot 0 last", () => {
    expect(dashboardColumnCount(200)).toBe(3);
    expect(ids(200)).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8],
      [4, 0],
    ]);
  });

  it("Cols=260: 4 columns split small pairs, task-list, and stream sorted with slot 0 last", () => {
    expect(dashboardColumnCount(260)).toBe(4);
    expect(ids(260)).toEqual([
      [1, 2],
      [5, 9],
      [3, 6, 7, 8],
      [4, 0],
    ]);
  });

  it("Cols=140: slot 0 alone in the stream group goes to the right column", () => {
    expect(ids(140, [0, 1, 2, 3, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9],
      [3, 6, 7, 8, 0],
    ]);
  });

  it("Cols=140: slot 4 alone in the stream group goes to the left column", () => {
    expect(ids(140, [1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([
      [1, 2, 5, 9, 4],
      [3, 6, 7, 8],
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

describe("dashboard low-row card culler", () => {
  it("keeps all cards when their minimum stacks fit", () => {
    expect(cullCardsForRows(ALL, 80)).toEqual({ cards: ALL, hidden: [] });
  });

  it("culls Doctor, Recent, and Workspaces first at 30 rows", () => {
    expect(cullCardsForRows(ALL, 30)).toEqual({
      cards: [0, 1, 2, 3, 4, 6, 7],
      hidden: [9, 8, 5],
    });
  });

  it("culls aggressively at 10 rows and keeps only the highest-priority cards", () => {
    expect(cullCardsForRows(ALL, 10)).toEqual({
      cards: [1, 3],
      hidden: [9, 8, 5, 2, 7, 6, 4, 0],
    });
  });

  it("keeps the highest-priority visible card even below its minimum stack", () => {
    expect(cullCardsForRows(ALL, 4)).toEqual({
      cards: [3],
      hidden: [9, 8, 5, 2, 7, 6, 4, 0, 1],
    });
  });

  it("returns empty arrays when every card is toggled off", () => {
    expect(cullCardsForRows([], 10)).toEqual({ cards: [], hidden: [] });
  });

  it("does not resurrect cards that were explicitly toggled off", () => {
    expect(cullCardsForRows([1, 3], 80)).toEqual({ cards: [1, 3], hidden: [] });
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
