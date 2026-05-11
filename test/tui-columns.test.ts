// columns.ts — column-alignment + protect/clip behaviour for the TUI.
//
// Per feat_column_aligned_lists (workstream `tui-impl`): rows in the
// cards/popups must visually align like `mu task list` / `mu agent
// list` did before, with cells that carry yank-bearing identity
// (task ids, agent names, status tokens) protected from truncation.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ColumnSpec,
  cellWidth,
  contentWidthFromCols,
  layoutColumns,
  naturalWidths,
  padCell,
  renderRow,
  truncateCell,
} from "../src/cli/tui/columns.js";

describe("cellWidth", () => {
  it("counts plain ASCII at 1 per char", () => {
    expect(cellWidth("hello")).toBe(5);
  });
  it("ignores ANSI escape sequences", () => {
    expect(cellWidth("\u001B[1mhello\u001B[22m")).toBe(5);
  });
  it("handles wide glyphs (CJK)", () => {
    expect(cellWidth("古")).toBe(2);
  });
});

describe("padCell", () => {
  it("pads to the right by default", () => {
    expect(padCell("ab", 5)).toBe("ab   ");
  });
  it("pads to the left when align=right", () => {
    expect(padCell("42", 5, "right")).toBe("   42");
  });
  it("is a no-op when the cell already meets the width", () => {
    expect(padCell("hello", 3)).toBe("hello");
  });
});

describe("truncateCell", () => {
  it("returns the input untouched when it fits", () => {
    expect(truncateCell("foo", 10)).toBe("foo");
  });
  it("truncates with an ellipsis suffix", () => {
    const out = truncateCell("hello world", 5);
    expect(cellWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns empty for a 0-width budget", () => {
    expect(truncateCell("hello", 0)).toBe("");
  });
});

describe("naturalWidths", () => {
  it("returns the widest cell per column", () => {
    const rows = [
      ["a", "bb"],
      ["ccc", "d"],
    ];
    expect(naturalWidths(rows)).toEqual([3, 2]);
  });
  it("returns an empty array for no rows", () => {
    expect(naturalWidths([])).toEqual([]);
  });
});

describe("layoutColumns", () => {
  it("uses natural widths when no totalWidth is given", () => {
    const rows = [
      ["a", "bb"],
      ["ccc", "d"],
    ];
    const specs: ColumnSpec[] = [{ kind: "protect" }, { kind: "clip" }];
    expect(layoutColumns(rows, specs)).toEqual([3, 2]);
  });

  it("respects per-column min/max", () => {
    const rows = [["a", "bb"]];
    const specs: ColumnSpec[] = [
      { kind: "protect", min: 5 },
      { kind: "clip", max: 1 },
    ];
    expect(layoutColumns(rows, specs)).toEqual([5, 1]);
  });

  it("preserves protected widths and shares remainder across clip cols", () => {
    // protected: 3 (col 0) and 2 (col 3); clip: cols 1, 2.
    // total = 30; gutters = 3 * 2 = 6; protected sum = 5; remaining = 19; per clip ~9.
    const rows = [["abc", "AAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBB", "xy"]];
    const specs: ColumnSpec[] = [
      { kind: "protect" },
      { kind: "clip" },
      { kind: "clip" },
      { kind: "protect" },
    ];
    const widths = layoutColumns(rows, specs, 30);
    expect(widths[0]).toBe(3);
    expect(widths[3]).toBe(2);
    // Two clip columns share 19; equal share = 9, leftover = 1 → last
    // clip column anchors with the extra.
    expect(widths[1]).toBe(9);
    expect(widths[2]).toBe(10);
  });

  it("collapses clip columns when protected cells already overflow", () => {
    const rows = [["very-long-protected-id", "title"]];
    const specs: ColumnSpec[] = [{ kind: "protect" }, { kind: "clip" }];
    const widths = layoutColumns(rows, specs, 10);
    expect(widths[0]).toBe(22); // unchanged — protected cells don't shrink
    expect(widths[1]).toBe(0); // clip collapses
  });

  it("leaves clip widths alone when their natural sum already fits", () => {
    const rows = [["abc", "xy"]];
    const specs: ColumnSpec[] = [{ kind: "protect" }, { kind: "clip" }];
    const widths = layoutColumns(rows, specs, 100);
    expect(widths).toEqual([3, 2]);
  });
});

describe("contentWidthFromCols", () => {
  // Per bug_tui_long_lines_overflow: TitledBox + popup Shells stack
  // 1 col rounded border + 1 col paddingX on each side = 4 cols of
  // chrome total. The helper subtracts that from the outer width so
  // every card/popup can pass the right budget into layoutColumns.
  it("subtracts 4 cols of chrome (1 border + 1 padX per side)", () => {
    expect(contentWidthFromCols(80)).toBe(76);
    expect(contentWidthFromCols(120)).toBe(116);
  });
  it("floors at 0 for very narrow terminals", () => {
    expect(contentWidthFromCols(4)).toBe(0);
    expect(contentWidthFromCols(3)).toBe(0);
    expect(contentWidthFromCols(0)).toBe(0);
  });
  it("feeds layoutColumns: clip cols actually clip when contentWidth is passed", () => {
    const rows = [["task_id", "a very long title that would overflow"]];
    const specs: ColumnSpec[] = [{ kind: "protect" }, { kind: "clip", min: 1 }];
    // Without contentWidth: natural widths (clip column wins overflow).
    const natural = layoutColumns(rows, specs);
    expect(natural[1]).toBe("a very long title that would overflow".length);
    // With contentWidth: clip column shrinks to the leftover budget.
    const budget = contentWidthFromCols(40); // 36
    const clipped = layoutColumns(rows, specs, budget);
    expect(clipped[1]).toBeLessThan(natural[1] ?? Number.POSITIVE_INFINITY);
  });
});

// Regression guard for bug_tui_long_lines_overflow. Every card and
// popup that calls layoutColumns must pass a third argument so the
// clip-column budget actually applies — without it, layoutColumns
// short-circuits to natural widths and long titles wrap to a second
// terminal line. Crude string-scan, but cheap and catches the exact
// regression.
describe("every card/popup passes contentWidth to layoutColumns", () => {
  const TUI_DIR = join(import.meta.dirname, "..", "src", "cli", "tui");
  const dirs = ["cards", "popups"];
  const files: { path: string; name: string; src: string }[] = [];
  for (const dir of dirs) {
    const full = join(TUI_DIR, dir);
    for (const f of readdirSync(full)) {
      if (!f.endsWith(".tsx")) continue;
      const path = join(full, f);
      const src = readFileSync(path, "utf8");
      if (!/\blayoutColumns\(/.test(src)) continue;
      files.push({ path, name: `${dir}/${f}`, src });
    }
  }

  it("discovers at least the known callers", () => {
    // Sanity: the brief lists 16 callers across 14 files (cards x8 +
    // popups x6, with workspaces / tracks each calling twice).
    expect(files.length).toBeGreaterThanOrEqual(14);
  });

  for (const { name, src } of files) {
    it(`${name} calls layoutColumns(rows, COLUMN_SPECS, <contentWidth>) with 3 args`, () => {
      // Match `layoutColumns(<a>, <b>, <c>)` allowing whitespace +
      // newlines + nested commas. The pattern requires exactly two
      // top-level commas before a closing paren — a 2-arg call has
      // one comma and would not match.
      const calls = [...src.matchAll(/\blayoutColumns\(([^()]*)\)/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const m of calls) {
        const args = (m[1] ?? "").split(",").map((s) => s.trim());
        expect(args.length, `${name}: ${m[0]}`).toBeGreaterThanOrEqual(3);
        expect(args[2]?.length ?? 0, `${name}: ${m[0]} third arg empty`).toBeGreaterThan(0);
      }
    });
  }
});

describe("renderRow", () => {
  it("pads protected cells but does not clip them", () => {
    const widths = [3, 5];
    const specs: ColumnSpec[] = [{ kind: "protect" }, { kind: "clip" }];
    const out = renderRow(["very-long-id", "ok"], widths, specs);
    // Protected cell stays verbatim (longer than its column).
    expect(out[0]).toBe("very-long-id");
    // Clip cell pads up to width 5.
    expect(out[1]).toBe("ok   ");
  });

  it("clips clippable cells with an ellipsis", () => {
    const widths = [4, 5];
    const specs: ColumnSpec[] = [{ kind: "protect" }, { kind: "clip" }];
    const out = renderRow(["id", "hello world"], widths, specs);
    expect(out[0]).toBe("id  ");
    expect(out[1]).toMatch(/^h.*…$/);
    expect(cellWidth(out[1] ?? "")).toBe(5);
  });

  it("pads numeric cells right when align=right", () => {
    const widths = [5];
    const specs: ColumnSpec[] = [{ kind: "protect", align: "right" }];
    const out = renderRow(["42"], widths, specs);
    expect(out[0]).toBe("   42");
  });
});
