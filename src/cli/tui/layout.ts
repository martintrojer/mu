// layout.ts — pure responsive-dashboard layout helpers.
//
// The TUI dashboard is glanceable, not exhaustive: cards should use
// the horizontal and vertical space available without letting one noisy
// list crowd out the rest. This module owns the two pure pieces that
// make that deterministic and easy to test:
//
//   1. layoutColumns(cols, visibleCardIds) — breakpoint + pair-aware
//      card packing into dashboard columns.
//   2. allocateRowBudgets(availableRows, cards) — per-column body-row
//      allocator with min-row guarantees, max caps, and largest-
//      remainder leftover distribution.
//
// No ink/react imports here. Cards import their own config from this
// file and re-export it as `cardConfig`; <App> imports the pure helpers
// and the card modules separately.

import type { WorkstreamSnapshot } from "../../state.js";

export type CardId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type CardGroup = "small-pair" | "task-list" | "stream";

export interface CardRowConfig {
  /** Minimum BODY rows to reserve for the card. Empty data still gets this much budget. */
  minRows: number;
  /** Maximum BODY rows worth rendering on the dashboard. Popups are exhaustive. */
  maxRows: number;
  /** Non-body rows consumed by TitledBox chrome + footer inset when truncated. */
  chrome: number;
  /** Static neighbour preference used by the pair-aware packer. */
  group: CardGroup;
}

export type CardConfigMap = Readonly<Record<CardId, CardRowConfig>>;

const CARD_CHROME_ROWS = 4;

export const CARD_CONFIGS: CardConfigMap = {
  0: { minRows: 3, maxRows: 12, chrome: CARD_CHROME_ROWS, group: "stream" }, // Commits
  1: { minRows: 2, maxRows: 10, chrome: CARD_CHROME_ROWS, group: "small-pair" }, // Agents
  2: { minRows: 2, maxRows: 8, chrome: CARD_CHROME_ROWS, group: "small-pair" }, // Tracks
  3: { minRows: 3, maxRows: 15, chrome: CARD_CHROME_ROWS, group: "task-list" }, // Ready
  4: { minRows: 3, maxRows: 12, chrome: CARD_CHROME_ROWS, group: "stream" }, // Activity log
  5: { minRows: 2, maxRows: 8, chrome: CARD_CHROME_ROWS, group: "small-pair" }, // Workspaces
  6: { minRows: 3, maxRows: 12, chrome: CARD_CHROME_ROWS, group: "task-list" }, // In-progress
  7: { minRows: 3, maxRows: 12, chrome: CARD_CHROME_ROWS, group: "task-list" }, // Blocked
  8: { minRows: 3, maxRows: 12, chrome: CARD_CHROME_ROWS, group: "task-list" }, // Recent
  9: { minRows: 2, maxRows: 8, chrome: CARD_CHROME_ROWS, group: "small-pair" }, // Doctor
};

export interface ColumnAssignment {
  cards: CardId[];
}

export function dashboardColumnCount(cols: number): 1 | 2 | 3 | 4 {
  if (cols >= 240) return 4;
  if (cols >= 180) return 3;
  if (cols >= 120) return 2;
  return 1;
}

/**
 * Breakpoint + pair-aware card packer.
 *
 * - <120 cols: single stack, sorted by slot with slot 0 last.
 * - 120-179: small/task columns with stream cards split as trailers.
 * - 180-239: small cards / task-list / stream.
 * - 240+: split the two natural small pairs, then task-list, then stream.
 *
 * Empty columns are filtered out so toggling a whole group off
 * redistributes the remaining columns instead of leaving a blank lane.
 */
export function layoutColumns(
  cols: number,
  visibleCardIds: ReadonlyArray<CardId>,
): ColumnAssignment[] {
  const visible = normalizeVisible(visibleCardIds);
  const target = dashboardColumnCount(cols);
  if (target === 1) {
    const cards = sortCards(visible);
    return cards.length === 0 ? [] : [{ cards }];
  }

  const small = sortCards(visible.filter((id) => CARD_CONFIGS[id].group === "small-pair"));
  const task = sortCards(visible.filter((id) => CARD_CONFIGS[id].group === "task-list"));
  const stream = sortCards(visible.filter((id) => CARD_CONFIGS[id].group === "stream"));

  const columns = (() => {
    if (target === 2) {
      const leftStream: CardId[] = [];
      const rightStream: CardId[] = [];
      for (const [index, id] of stream.entries()) {
        if (stream.length === 1 && id === 0) {
          rightStream.push(id);
          continue;
        }
        (index % 2 === 0 ? leftStream : rightStream).push(id);
      }
      return [
        [...small, ...sortCards(leftStream)],
        [...task, ...sortCards(rightStream)],
      ];
    }
    if (target === 3) return [small, task, stream];
    const topSmall = small.filter((id) => id === 1 || id === 2);
    const bottomSmall = small.filter((id) => id === 5 || id === 9);
    return [topSmall, bottomSmall, task, stream];
  })();

  return columns.filter((cards) => cards.length > 0).map((cards) => ({ cards }));
}

export interface ColumnWidth {
  width: number;
}

export function columnWidths(totalCols: number, columnCount: number): ColumnWidth[] {
  if (columnCount <= 0) return [];
  const gaps = columnCount - 1;
  const usable = Math.max(columnCount, totalCols - gaps);
  const base = Math.floor(usable / columnCount);
  const extra = usable - base * columnCount;
  return Array.from({ length: columnCount }, (_, i) => ({ width: base + (i < extra ? 1 : 0) }));
}

export interface RowBudgetInput {
  id: CardId;
  dataCount: number;
  config?: CardRowConfig;
}

export type RowBudgetMap = Readonly<Record<CardId, number>>;

/**
 * Allocate BODY rows among the cards in one dashboard column.
 *
 * `availableRows` is the total vertical budget for the column,
 * including card chrome. The returned map contains body rows (the
 * value each card should pass to slice(0, N)). Chrome is still
 * accounted for so columns with many cards don't over-allocate.
 */
export function allocateRowBudgets(
  availableRows: number,
  cards: ReadonlyArray<RowBudgetInput>,
): RowBudgetMap {
  const entries = cards.map((card) => {
    const config = card.config ?? CARD_CONFIGS[card.id];
    const dataCount = Math.max(0, Math.floor(card.dataCount));
    const minRows = Math.max(0, config.minRows);
    const maxRows = Math.max(minRows, config.maxRows);
    const naturalRows = clamp(dataCount, minRows, maxRows);
    return { id: card.id, dataCount, config, minRows, maxRows, naturalRows };
  });

  const out = emptyBudgetMap();
  if (entries.length === 0) return out;

  const naturalTotal = entries.reduce((sum, e) => sum + e.naturalRows + e.config.chrome, 0);
  if (naturalTotal <= availableRows) {
    for (const e of entries) out[e.id] = e.naturalRows;
    return out;
  }

  const chromeTotal = entries.reduce((sum, e) => sum + e.config.chrome, 0);
  const bodyAvailable = Math.max(0, availableRows - chromeTotal);
  const minTotal = entries.reduce((sum, e) => sum + e.minRows, 0);

  // Min-row guarantee. If the terminal is too short to fit the
  // guarantees plus chrome, return the guarantees anyway and let the
  // App root's overflow clip be the final guard.
  if (bodyAvailable <= minTotal) {
    for (const e of entries) out[e.id] = e.minRows;
    return out;
  }

  for (const e of entries) out[e.id] = e.minRows;

  let remaining = bodyAvailable - minTotal;
  const totalWeight = entries.reduce((sum, e) => sum + clamp(e.dataCount, e.minRows, e.maxRows), 0);
  const weighted = entries.map((e, index) => {
    const weight = totalWeight === 0 ? 1 : clamp(e.dataCount, e.minRows, e.maxRows);
    const raw = totalWeight === 0 ? remaining / entries.length : (remaining * weight) / totalWeight;
    const add = Math.min(e.maxRows - e.minRows, Math.floor(raw));
    return { id: e.id, index, raw, add, capacity: e.maxRows - e.minRows };
  });

  for (const w of weighted) {
    out[w.id] += w.add;
    remaining -= w.add;
  }

  const remainders = weighted
    .map((w) => ({ ...w, remainder: w.raw - Math.floor(w.raw) }))
    .sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : b.remainder - a.remainder));

  while (remaining > 0) {
    let changed = false;
    for (const r of remainders) {
      if (remaining <= 0) break;
      const entry = entries[r.index];
      if (entry === undefined) continue;
      if (out[r.id] >= entry.maxRows) continue;
      out[r.id] += 1;
      remaining -= 1;
      changed = true;
    }
    if (!changed) break;
  }

  return out;
}

export function dataCountForCard(id: CardId, snapshot: WorkstreamSnapshot | null): number {
  if (snapshot === null) return 0;
  switch (id) {
    case 0:
      return snapshot.recentCommits.length;
    case 1:
      return snapshot.view.agents.length;
    case 2:
      return snapshot.tracks.length;
    case 3:
      return snapshot.ready.length;
    case 4:
      return snapshot.recent.length;
    case 5:
      return snapshot.workspaces.length;
    case 6:
      return snapshot.inProgress.length;
    case 7:
      return snapshot.blocked.length;
    case 8:
      return snapshot.recentClosed.length;
    case 9:
      return snapshot.doctor?.problemCount ?? 0;
  }
}

function compareSlot(a: CardId, b: CardId): number {
  const ka = a === 0 ? 10 : a;
  const kb = b === 0 ? 10 : b;
  return ka - kb;
}

function sortCards(ids: ReadonlyArray<CardId>): CardId[] {
  return [...ids].sort(compareSlot);
}

function normalizeVisible(ids: ReadonlyArray<CardId>): CardId[] {
  const seen = new Set<CardId>();
  const out: CardId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.sort((a, b) => a - b);
}

function emptyBudgetMap(): Record<CardId, number> {
  return { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
