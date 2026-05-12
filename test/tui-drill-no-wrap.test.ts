// Regression guard for bug_tui_drill_text_no_width_pin.
//
// Ink only applies <Text wrap="truncate"> against a finite parent
// width. DrillScrollView already set wrap="truncate" on each body line,
// but the visible.map lived directly under TitledBox's inner column, so
// long logical lines still wrapped in every drill consumer (task notes,
// git show, log payloads, agent scrollback, doctor remediation). The
// drill body must live inside ONE width-pinned column Box.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DRILL_SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "cli", "tui", "popups", "drill.tsx"),
  "utf8",
);

describe("DrillScrollView body has a definite width parent", () => {
  it("derives contentWidth from the same terminal-column helpers as cards/popups", () => {
    expect(DRILL_SRC).toMatch(/contentWidthFromCols\(termColsForLayout\(\)\)/);
  });

  it("wraps fallback + visible body lines in one column Box with width={contentWidth}", () => {
    const match = DRILL_SRC.match(
      /<Box\s+flexDirection=["']column["']\s+width=\{contentWidth\}>[\s\S]*?visible\.map\([\s\S]*?<Text\b[^>]*wrap=["']truncate["'][^>]*>[\s\S]*?ln\s*===\s*["']{2}\s*\?\s*["']\s["']\s*:\s*ln[\s\S]*?<\/Box>/,
    );
    expect(
      match,
      "DrillScrollView body lines must be inside <Box width={contentWidth}>",
    ).not.toBeNull();
  });
});
