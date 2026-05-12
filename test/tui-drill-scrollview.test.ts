// Per bug_tui_drill_scrollview_wraps_long_lines (workstream
// `tui-impl`): DrillScrollView body lines were rendered with bare
// <Text>, which inherits ink's default wrap="wrap" behaviour and
// folds long lines onto a second terminal row. That broke (a) the
// position counter (which counts logical lines, not terminal rows)
// and (b) the popup layout (the bottom hint slid out of frame).
//
// Sibling fixes for tabular row data live in
// bug_tui_log_card_columns_misaligned (cards) and
// bug_tui_log_popup_columns_misaligned (popup rows). This test
// closes the same class for the drill body.
//
// Static-source assertion: the body-line <Text> in
// src/cli/tui/popups/drill.tsx must carry wrap="truncate" (or
// wrap="truncate-end" — both clip at parent width). A sibling guard
// in tui-drill-no-wrap.test.ts pins the required parent-width Box.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DRILL_SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "cli", "tui", "popups", "drill.tsx"),
  "utf8",
);

describe("DrillScrollView body lines clip instead of wrapping", () => {
  it('body-line <Text> carries wrap="truncate" (or truncate-end)', () => {
    // The line we care about is the one inside `visible.map(...)` that
    // renders each body line. Match the JSX attributes on a <Text>
    // whose child is the `ln === "" ? " " : ln` ternary.
    const match = DRILL_SRC.match(
      /<Text\b([^>]*)>\s*\{\s*ln\s*===\s*""\s*\?\s*"\s*"\s*:\s*ln\s*\}\s*<\/Text>/,
    );
    expect(match, "could not find body-line <Text> in drill.tsx").not.toBeNull();
    const attrs = match?.[1] ?? "";
    expect(attrs, `body-line <Text${attrs}> missing wrap=truncate`).toMatch(
      /wrap=["'](truncate|truncate-end)["']/,
    );
  });
});
