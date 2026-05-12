// Regression guards for the DrillScrollView rendering invariants.
//
// History (read in order to understand what we landed and why):
//
// 1. Original symptom: every long-text drill view (task notes, git
//    show, log payloads, agent scrollback, doctor remediation)
//    wrapped past the popup's right border. The first attempt added
//    `<Text wrap="truncate">` per line — but ink only honours
//    truncate inside a parent <Box> with a definite width, and
//    DrillScrollView at the time wrapped its body in its OWN
//    nested <TitledBox> at width=stdout.columns INSIDE the popup's
//    cyan TitledBox at width=stdout.columns. Both boxes drew rounded
//    borders + paddingX (4 cols of chrome each), so the inner box
//    overflowed the popup's inner content area by 4 cols and the
//    body's contentWidth was double-counted. Lines that fit the
//    inner contentWidth then spilled past the OUTER cyan border;
//    the terminal scrolled / wrapped exactly as the user reported.
//
// 2. Central fix: drop the nested magenta TitledBox entirely. Render
//    title + position + body + hint INLINE inside the popup's
//    existing chrome. One border, one width budget; ink's natural
//    flex-grown column inherits the popup's inner width.
//
// 3. User refinement: long lines should WRAP-WITHIN-BORDERS so you
//    can read the whole line by scrolling, NOT clip with `…` /
//    truncate. So the body lines drop the `wrap` prop entirely and
//    let ink default to wrap-on-overflow.
//
// What this test pins (the live invariants):
//   - DrillScrollView does NOT import TitledBox.
//   - DrillScrollView does NOT render a nested <TitledBox>.
//   - Body lines do NOT carry wrap="truncate" (so long lines wrap
//     within the popup's inner width instead of clipping).
//   - The magenta-coloured title still renders (visual consistency
//     with the prior nested-TitledBox magenta border).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DRILL_SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "cli", "tui", "popups", "drill.tsx"),
  "utf8",
);

/** Strip block + line comments so doc references don't trip
 *  source-pattern assertions. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("DrillScrollView renders inline (no nested TitledBox)", () => {
  it("does not import TitledBox", () => {
    expect(stripComments(DRILL_SRC)).not.toMatch(/from\s+["']\.\.\/titled-box\.js["']/);
  });

  it("does not render a <TitledBox> wrapper", () => {
    expect(stripComments(DRILL_SRC)).not.toMatch(/<TitledBox\b/);
  });

  it("body lines wrap-within-borders (no wrap prop on body Text)", () => {
    // Find the visible.map(...) → <Text>{ln}</Text> render branch
    // and assert the <Text> there does NOT carry `wrap="..."`.
    // ink's default is wrap-on-overflow, which is what we want.
    const stripped = stripComments(DRILL_SRC);
    const match = stripped.match(/visible\.map\([^)]*\)\s*=>\s*\(([\s\S]*?)\)\s*\)/);
    expect(match, "could not find visible.map render branch").not.toBeNull();
    const branch = match?.[1] ?? "";
    expect(
      branch,
      "drill body <Text> must NOT carry wrap=… (lines should wrap within the popup width, not clip)",
    ).not.toMatch(/<Text[^>]*\bwrap=/);
  });

  it("title + position label render as a single inline header row", () => {
    const stripped = stripComments(DRILL_SRC);
    expect(stripped).toMatch(/<Text[^>]*\bcolor=["']magenta["']/);
    expect(stripped).toMatch(/positionLabel/);
  });
});
