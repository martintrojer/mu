// Regression guard for bug_tui_drill_text_no_width_pin.
//
// Original symptom (ink-side): every long-text drill view (task notes,
// git show, log payloads, agent scrollback, doctor remediation) wrapped
// long lines past the popup's right border. The earlier per-line
// width pin tried `<Box width={contentWidth}>` around the visible.map,
// but `contentWidth = stdout.columns - 4` was DOUBLE-COUNTED: the
// nested DrillScrollView TitledBox itself sat at width=cols and added
// ANOTHER 4 cols of magenta border + paddingX, so the body was given
// `cols - 4` cols of width but only `cols - 8` cols were actually
// visible inside the cyan popup. Lines that fit `cols - 4` then spilled
// past the cyan border; the terminal scrolled / wrapped.
//
// Central fix: drop the nested magenta TitledBox entirely. Render
// title + position + body + hint inline inside the popup's existing
// chrome. One border, one width budget, lines clip cleanly via
// flex-grown column inheriting the popup's inner area width.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DRILL_SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "cli", "tui", "popups", "drill.tsx"),
  "utf8",
);

describe("DrillScrollView renders inline (no nested TitledBox)", () => {
  it("does not import TitledBox", () => {
    expect(DRILL_SRC).not.toMatch(/from\s+["']\.\.\/titled-box\.js["']/);
  });

  it("does not render a <TitledBox> wrapper", () => {
    // Strip block + line comments so doc references to TitledBox
    // (in the file's header / inline justification of the central
    // fix) don't trip the assertion.
    const stripped = DRILL_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/<TitledBox\b/);
  });

  it('body lines carry wrap="truncate" so they clip at the inherited parent width', () => {
    expect(DRILL_SRC).toMatch(/<Text[^>]*\bwrap=["']truncate["']/);
  });

  it("title + position label render as a single inline header row", () => {
    expect(DRILL_SRC).toMatch(/<Text[^>]*\bcolor=["']magenta["']/);
    expect(DRILL_SRC).toMatch(/positionLabel/);
  });
});
