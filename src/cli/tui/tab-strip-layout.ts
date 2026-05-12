// Pure tab-strip layout helper. Keeps the React component small and
// makes overflow behaviour testable without booting ink.

import stringWidth from "string-width";

const PREFIX = "workstreams: ";
const WIDE_HINT = " (Tab / Shift-Tab)";
const NARROW_HINT = " (Tab/Shift-Tab)";
const SEP = " · ";
const ELLIPSIS = "…";

export interface VisibleTab {
  name: string;
  isActive: boolean;
}

export interface TabStripLayout {
  leftHidden: number;
  rightHidden: number;
  visible: VisibleTab[];
  showHint: boolean;
}

export function layoutTabStrip(
  workstreams: readonly string[],
  active: number,
  availableCols: number,
): TabStripLayout | null {
  if (workstreams.length <= 1) return null;
  const safeActive = clamp(active, 0, workstreams.length - 1);
  const maxCols = Math.max(0, Math.floor(availableCols));
  const allRange = range(0, workstreams.length - 1);
  if (fits(workstreams, safeActive, allRange, maxCols, true)) {
    return {
      leftHidden: 0,
      rightHidden: 0,
      visible: tabsForRange(workstreams, safeActive, allRange),
      showHint: true,
    };
  }

  let start = safeActive;
  let end = safeActive;
  let growLeft = true;
  while (true) {
    let changed = false;
    if (
      growLeft &&
      start > 0 &&
      fits(workstreams, safeActive, range(start - 1, end), maxCols, true)
    ) {
      start--;
      changed = true;
    }
    if (
      !changed &&
      end < workstreams.length - 1 &&
      fits(workstreams, safeActive, range(start, end + 1), maxCols, true)
    ) {
      end++;
      changed = true;
    }
    if (
      !changed &&
      !growLeft &&
      start > 0 &&
      fits(workstreams, safeActive, range(start - 1, end), maxCols, true)
    ) {
      start--;
      changed = true;
    }
    if (!changed) break;
    growLeft = !growLeft;
  }

  const activeRange = range(safeActive, safeActive);
  if (!fits(workstreams, safeActive, activeRange, maxCols, true)) {
    const noHintCols = Math.max(
      0,
      maxCols - chromeWidth(hiddenLeft(safeActive), hiddenRight(workstreams, safeActive), false),
    );
    const nameCols = Math.max(0, noHintCols - stringWidth("▸ "));
    return {
      leftHidden: hiddenLeft(safeActive),
      rightHidden: hiddenRight(workstreams, safeActive),
      visible: [{ name: truncateToWidth(workstreams[safeActive] ?? "", nameCols), isActive: true }],
      showHint: false,
    };
  }

  return {
    leftHidden: start,
    rightHidden: workstreams.length - end - 1,
    visible: tabsForRange(workstreams, safeActive, range(start, end)),
    showHint: true,
  };
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

function hiddenLeft(active: number): number {
  return active;
}

function hiddenRight(workstreams: readonly string[], active: number): number {
  return Math.max(0, workstreams.length - active - 1);
}

function tabsForRange(
  workstreams: readonly string[],
  active: number,
  indexes: readonly number[],
): VisibleTab[] {
  return indexes.map((i) => ({ name: workstreams[i] ?? "", isActive: i === active }));
}

function fits(
  workstreams: readonly string[],
  active: number,
  indexes: readonly number[],
  availableCols: number,
  showHint: boolean,
): boolean {
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  if (first === undefined || last === undefined) return false;
  const leftHidden = first;
  const rightHidden = workstreams.length - last - 1;
  return rowWidth(workstreams, active, indexes, leftHidden, rightHidden, showHint) <= availableCols;
}

function rowWidth(
  workstreams: readonly string[],
  active: number,
  indexes: readonly number[],
  leftHidden: number,
  rightHidden: number,
  showHint: boolean,
): number {
  return (
    chromeWidth(leftHidden, rightHidden, showHint) +
    indexes.reduce((sum, i, idx) => {
      const prefix = i === active ? "▸ " : "";
      const sep = idx < indexes.length - 1 ? SEP : "";
      return sum + stringWidth(prefix) + stringWidth(workstreams[i] ?? "") + stringWidth(sep);
    }, 0)
  );
}

function chromeWidth(leftHidden: number, rightHidden: number, showHint: boolean): number {
  return (
    stringWidth(PREFIX) +
    counterWidth("‹", leftHidden) +
    counterWidth("›", rightHidden) +
    (showHint ? stringWidth(leftHidden > 0 || rightHidden > 0 ? NARROW_HINT : WIDE_HINT) : 0)
  );
}

function counterWidth(prefix: "‹" | "›", count: number): number {
  return count > 0 ? stringWidth(`${prefix}${count} `) : 0;
}

function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  if (width <= stringWidth(ELLIPSIS)) return ELLIPSIS.slice(0, width);
  let out = "";
  const budget = width - stringWidth(ELLIPSIS);
  for (const ch of text) {
    if (stringWidth(out + ch) > budget) break;
    out += ch;
  }
  return `${out}${ELLIPSIS}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
