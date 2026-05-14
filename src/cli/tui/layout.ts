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
  /** Stable card name (e.g. "commits", "agents", "inProgress"). The
   *  single source of truth for the per-card identifier; replaces
   *  the old hand-rolled cardKeyFromId switch in app.tsx. Used as
   *  the card-toggle visibility key (alongside the numeric CardId)
   *  and as a stable string handle anywhere a name is needed. */
  name: string;
  /** Human label shown in the popup status bar (e.g. "Commits",
   *  "In-progress", "Tasks"). Replaces the old popupNameForId
   *  switch in app.tsx. Distinct from `name` because some labels
   *  diverge from a naive capitalise (slot 3's name is "ready"
   *  but its popup is the all-Tasks view; slot 6 is "In-progress",
   *  not "InProgress"). */
  label: string;
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

// Two rows of TitledBox chrome: 1 top-border line + 1 bottom-border
// line. The body is rendered by the inner Box (paddingY=0) and the
// PaddedRows helper fills it to exactly `rowBudget` text rows, so the
// declared outer height is `chrome + rowBudget` with no slack.
// Historically this was 4 (over-reservation) which left 2 blank rows
// at the bottom of every card and made the dashboard feel loose; the
// pack_dashboard_cards_tighter polish lowered it to the true chrome
// cost so cards stack flush against each other.
const CARD_CHROME_ROWS = 2;

export const CARD_CONFIGS: CardConfigMap = {
  0: {
    name: "commits",
    label: "Commits",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "stream",
  },
  1: {
    name: "agents",
    label: "Agents",
    minRows: 2,
    maxRows: 10,
    chrome: CARD_CHROME_ROWS,
    group: "small-pair",
  },
  2: {
    name: "tracks",
    label: "Tracks",
    minRows: 2,
    maxRows: 8,
    chrome: CARD_CHROME_ROWS,
    group: "small-pair",
  },
  3: {
    name: "ready",
    label: "Tasks",
    minRows: 3,
    maxRows: 15,
    chrome: CARD_CHROME_ROWS,
    group: "task-list",
  },
  4: {
    name: "log",
    label: "Log",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "stream",
  },
  5: {
    name: "workspaces",
    label: "Workspaces",
    minRows: 2,
    maxRows: 8,
    chrome: CARD_CHROME_ROWS,
    group: "small-pair",
  },
  6: {
    name: "inProgress",
    label: "In-progress",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "task-list",
  },
  7: {
    name: "blocked",
    label: "Blocked",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "task-list",
  },
  8: {
    name: "recent",
    label: "Recent",
    minRows: 3,
    maxRows: 12,
    chrome: CARD_CHROME_ROWS,
    group: "task-list",
  },
  9: {
    name: "doctor",
    label: "Doctor",
    minRows: 2,
    maxRows: 8,
    chrome: CARD_CHROME_ROWS,
    group: "small-pair",
  },
};

export interface ColumnAssignment {
  cards: CardId[];
}

export interface CardHitRegion {
  id: CardId;
  column: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
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

export function dashboardCardHitRegions(
  assignments: ReadonlyArray<ColumnAssignment>,
  widths: ReadonlyArray<ColumnWidth>,
  budgets: ReadonlyArray<RowBudgetMap>,
  opts: { top?: number; left?: number; columnGap?: number } = {},
): CardHitRegion[] {
  const topBase = opts.top ?? 1;
  const leftBase = opts.left ?? 1;
  const gap = opts.columnGap ?? 1;
  const out: CardHitRegion[] = [];
  let left = leftBase;
  for (let column = 0; column < assignments.length; column++) {
    const assignment = assignments[column];
    const width = widths[column]?.width;
    const budget = budgets[column];
    if (assignment === undefined || width === undefined || budget === undefined) continue;
    let top = topBase;
    for (const id of assignment.cards) {
      const height = CARD_CONFIGS[id].chrome + budget[id];
      out.push({ id, column, left, right: left + width - 1, top, bottom: top + height - 1 });
      top += height;
    }
    left += width + gap;
  }
  return out;
}

export function cardRenderHeight(
  config: CardRowConfig,
  rowBudget: number | undefined,
): number | undefined {
  return rowBudget === undefined ? undefined : config.chrome + rowBudget;
}

export function hitTestDashboardCard(
  regions: ReadonlyArray<CardHitRegion>,
  point: { x: number; y: number },
): CardId | null {
  for (const region of regions) {
    if (
      point.x >= region.left &&
      point.x <= region.right &&
      point.y >= region.top &&
      point.y <= region.bottom
    ) {
      return region.id;
    }
  }
  return null;
}

export interface RowBudgetInput {
  id: CardId;
  dataCount: number;
  config?: CardRowConfig;
}

export type RowBudgetMap = Readonly<Record<CardId, number>>;

const CARD_CULL_PRIORITY: readonly CardId[] = [9, 8, 5, 2, 7, 6, 4, 0, 1, 3];
const CARD_CULL_LAYOUT_COLS = 140;

export interface CulledCards {
  /** Surviving cards, preserving the caller's visible-set order after de-dupe. */
  cards: CardId[];
  /** Cards hidden because the pane is too short, in cull-priority order. */
  hidden: CardId[];
}

/**
 * Trim low-priority dashboard cards until the minimum stack fits.
 *
 * The user-controlled visible set is the ceiling: toggled-off cards
 * never reappear here. We only cull further, keeping at least one
 * card (the highest-priority visible card) so a tiny-but-not-panic
 * pane still renders a useful dashboard plus the resize hint.
 */
export function cullCardsForRows(
  visibleCardIds: ReadonlyArray<CardId>,
  availableRows: number,
): CulledCards {
  const cards = normalizeVisible(visibleCardIds);
  const hidden: CardId[] = [];
  if (cards.length === 0) return { cards, hidden };

  const remaining = new Set<CardId>(cards);
  const budget = Math.max(0, Math.floor(availableRows));
  const maxCardsForRows = Math.max(1, Math.floor(budget / CARD_CHROME_ROWS));
  for (const id of CARD_CULL_PRIORITY) {
    const surviving = cards.filter((card) => remaining.has(card));
    if (surviving.length <= maxCardsForRows && tallestMinStackRows(surviving) <= budget) break;
    if (!remaining.has(id)) continue;
    if (remaining.size <= 1) break;
    remaining.delete(id);
    hidden.push(id);
  }

  return { cards: cards.filter((id) => remaining.has(id)), hidden };
}

/**
 * Post-pack column rebalancer. Pure.
 *
 * `layoutColumns` packs cards by static group (small-pair / task-list
 * / stream). When the user toggles cards off, that grouping can leave
 * one column tall and another short — the spatial intuition is
 * preserved, but the screen feels half-empty.
 *
 * `balanceColumns` is a single greedy pass that moves the most-
 * spread-reducing card from the tallest column to the shortest, until
 * no further move strictly reduces (maxHeight − minHeight). The pass
 * runs after `layoutColumns` and before `allocateRowBudgets`, so the
 * downstream pipeline sees a balanced assignment.
 *
 * Invariants:
 *   - Stable-when-all-visible: the default 10-card layout is never
 *     touched. Balance only fires when at least one card has been
 *     toggled off (totalCards < TOTAL_CARD_COUNT). User-driven
 *     toggling is what triggers the reflow.
 *   - Anchored cards never move: slot 0 (Commits, conventionally
 *     last) and slot 3 (Ready, the task-list anchor that motivates
 *     the dashboard's primary column).
 *   - Slot ordering within each receiver column is preserved via
 *     `compareSlot` (slot 0 trailing).
 *   - Column count is preserved: the balancer never strips a donor
 *     column to empty (the empty-column filter is upstream in
 *     `layoutColumns`; the balancer respects whatever it produced).
 */
const TOTAL_CARD_COUNT = 10;

export function balanceColumns(
  assignments: ReadonlyArray<ColumnAssignment>,
  dataCountFn: (id: CardId) => number,
): ColumnAssignment[] {
  if (assignments.length < 2) return assignments.map((a) => ({ cards: [...a.cards] }));
  const totalCards = assignments.reduce((sum, a) => sum + a.cards.length, 0);
  if (totalCards >= TOTAL_CARD_COUNT) return assignments.map((a) => ({ cards: [...a.cards] }));

  const cols = assignments.map((a) => [...a.cards]);
  const heightOf = (id: CardId): number => {
    const config = CARD_CONFIGS[id];
    const data = Math.max(0, Math.floor(dataCountFn(id)));
    return config.chrome + clamp(data, config.minRows, config.maxRows);
  };
  const isAnchored = (id: CardId): boolean => id === 0 || id === 3;
  const heightsOf = (lanes: ReadonlyArray<ReadonlyArray<CardId>>): number[] =>
    lanes.map((lane) => lane.reduce<number>((sum, id) => sum + heightOf(id), 0));

  // Greedy outer loop. Each iteration takes one strictly-improving
  // move; bounded by columnCount * cardCount as a hard safety net
  // since each move shrinks the spread (no cycles possible).
  const safetyMax = cols.length * TOTAL_CARD_COUNT;
  for (let iter = 0; iter < safetyMax; iter++) {
    const heights = heightsOf(cols);
    const startSpread = Math.max(...heights) - Math.min(...heights);
    if (startSpread <= 0) break;

    let best: { donor: number; receiver: number; cardIndex: number; spread: number } | null = null;
    for (let donor = 0; donor < cols.length; donor++) {
      const donorCards = cols[donor];
      const donorH = heights[donor];
      if (donorCards === undefined || donorH === undefined) continue;
      if (donorCards.length <= 1) continue; // never strip a column to empty
      for (let cardIndex = 0; cardIndex < donorCards.length; cardIndex++) {
        const card = donorCards[cardIndex];
        if (card === undefined || isAnchored(card)) continue;
        const cardH = heightOf(card);
        for (let receiver = 0; receiver < cols.length; receiver++) {
          if (receiver === donor) continue;
          const receiverH = heights[receiver];
          if (receiverH === undefined) continue;
          const newHeights = heights.slice();
          newHeights[donor] = donorH - cardH;
          newHeights[receiver] = receiverH + cardH;
          const newSpread = Math.max(...newHeights) - Math.min(...newHeights);
          if (newSpread < startSpread && (best === null || newSpread < best.spread)) {
            best = { donor, receiver, cardIndex, spread: newSpread };
          }
        }
      }
    }
    if (best === null) break;

    const donorCards = cols[best.donor];
    const receiverCards = cols[best.receiver];
    if (donorCards === undefined || receiverCards === undefined) break;
    const moved = donorCards.splice(best.cardIndex, 1)[0];
    if (moved === undefined) break;
    receiverCards.push(moved);
    receiverCards.sort(compareSlot);
  }

  return cols.map((cards) => ({ cards }));
}

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

function tallestMinStackRows(ids: ReadonlyArray<CardId>): number {
  let tallest = 0;
  for (const assignment of layoutColumns(CARD_CULL_LAYOUT_COLS, ids)) {
    let total = 0;
    for (const id of assignment.cards) {
      const config = CARD_CONFIGS[id];
      total += Math.max(0, config.minRows) + Math.max(0, config.chrome);
    }
    tallest = Math.max(tallest, total);
  }
  return tallest;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
