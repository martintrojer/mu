import { describe, expect, it } from "vitest";
import {
  type CardId,
  allocateRowBudgets,
  balanceColumns,
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

  it("balanceColumns: stable when all 10 cards are visible", () => {
    // Default 4-col layout. Touching this shape with all cards visible
    // would change the dashboard's baseline glanceability for every
    // user; the balancer must be a no-op when nothing has been
    // toggled off.
    const packed = layoutColumns(260, ALL);
    const balanced = balanceColumns(packed, () => 5);
    expect(balanced.map((c) => c.cards)).toEqual(packed.map((c) => c.cards));
  });

  it("balanceColumns: redistributes a card from the tall column to the short column post-toggle", () => {
    // 3-col layout with the small-pair column reduced to one card
    // (slot 1). Ready (slot 3) anchors the middle column with a tall
    // task list (high dataCount). The balancer must move at least one
    // task-list card to the short column or to the stream column.
    const visible: CardId[] = [1, 3, 6, 7, 4];
    const packed = layoutColumns(200, visible);
    expect(packed.map((c) => c.cards)).toEqual([[1], [3, 6, 7], [4]]);
    const balanced = balanceColumns(packed, (id) => (id === 3 || id === 6 || id === 7 ? 12 : 1));
    const heights = balanced.map((col) => col.cards.length);
    const spread = Math.max(...heights) - Math.min(...heights);
    expect(spread).toBeLessThan(2);
    // Slot 3 (Ready) is anchored — must stay where layoutColumns put it.
    const readyColumn = balanced.findIndex((col) => col.cards.includes(3));
    expect(readyColumn).toBe(1);
  });

  it("balanceColumns: anchored cards (slot 0 Commits, slot 3 Ready) never move", () => {
    // Wide-spread setup: tall left column has both anchors; short
    // right column has nothing. Balancer should still leave both
    // anchors in the left column even though moving them would
    // perfectly balance heights.
    const assignments = [{ cards: [3, 0, 7] as CardId[] }, { cards: [1] as CardId[] }];
    const balanced = balanceColumns(assignments, () => 5);
    expect(balanced[0]?.cards).toContain(0);
    expect(balanced[0]?.cards).toContain(3);
  });

  it("balanceColumns: never strips a column to empty", () => {
    // Both columns have one card; the taller would be the natural
    // donor, but doing so would leave it empty. The balancer must
    // refuse — empty-column filtering belongs upstream in
    // layoutColumns, not here.
    const assignments = [{ cards: [1] as CardId[] }, { cards: [7] as CardId[] }];
    const balanced = balanceColumns(assignments, (id) => (id === 7 ? 30 : 1));
    expect(balanced[0]?.cards).toEqual([1]);
    expect(balanced[1]?.cards).toEqual([7]);
  });

  it("balanceColumns: no-op on a single column", () => {
    const assignments = [{ cards: [1, 3, 6] as CardId[] }];
    const balanced = balanceColumns(assignments, () => 5);
    expect(balanced.map((c) => c.cards)).toEqual([[1, 3, 6]]);
  });

  it("balanceColumns: preserves slot ordering on the receiver column", () => {
    // After moving slot 2 from donor to receiver, receiver's cards
    // must be sorted by compareSlot (slot 0 trailing).
    const assignments = [{ cards: [1, 2, 7] as CardId[] }, { cards: [4, 0] as CardId[] }];
    const balanced = balanceColumns(assignments, () => 5);
    // Slot 0 trails in the receiver column wherever 2 lands.
    const receiver = balanced[1]?.cards ?? [];
    if (receiver.includes(0)) {
      expect(receiver[receiver.length - 1]).toBe(0);
    }
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

  it("keeps every card at 30 rows once chrome shrank to its true 2-row cost", () => {
    // pack_dashboard_cards_tighter lowered CARD_CHROME_ROWS from 4 to
    // 2 (the actual TitledBox top+bottom border cost). At 30 rows the
    // tallest min-stack column is now 25 rows so nothing needs culling.
    expect(cullCardsForRows(ALL, 30)).toEqual({ cards: ALL, hidden: [] });
  });

  it("culls aggressively at 10 rows and keeps only the highest-priority cards", () => {
    // Same chrome=2 retune: cull stops once 4 cards' min-stack fits in
    // 10 rows (one column = (2+2)+(3+2) = 9 ≤ 10) instead of needing
    // to drop down to a 2-card stack like the chrome=4 era.
    expect(cullCardsForRows(ALL, 10)).toEqual({
      cards: [0, 1, 3, 4],
      hidden: [9, 8, 5, 2, 7, 6],
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
    const budgets = allocateRowBudgets(23, [
      { id: 3, dataCount: 9 },
      { id: 6, dataCount: 5 },
      { id: 7, dataCount: 5 },
    ]);
    // bodyAvailable = 23 - chrome(6) = 17. Min total = 9. The 8-row
    // weighted remainder is 3.78 / 2.10 / 2.10, so Ready wins the
    // largest-remainder row after floors of (3, 2, 2). chrome=2 here
    // mirrors what chrome=4 + availableRows=29 used to exercise.
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
