// Geometry tests for TitledBox — the rounded-border container whose
// header sits INSIDE the top border line (lazygit/htop/btop style).
//
// Pinning the dash-fill arithmetic in a pure helper means we don't
// have to render-and-snapshot ink output to catch off-by-one drift.

import { describe, expect, it } from "vitest";
import { TitledBox, computeTopRowDashes } from "../src/cli/tui/titled-box.js";

describe("computeTopRowDashes", () => {
  it("title only — '╭─ T ───...───╮' is exactly cols wide", () => {
    // cols=20, title="Agents" (W=6) → dashes = 20 - 5 - 6 = 9
    //   ╭─ Agents ─────────╮
    //   1 1 1+6+1   9        1   = 20 ✓
    expect(computeTopRowDashes(20, "Agents")).toBe(9);
  });

  it("title + subtitle — accounts for ' · ' separator (3 cols)", () => {
    // cols=40, title="Agents" (6), subtitle="3 free" (6)
    // dashes = 40 - 8 - 6 - 6 = 20
    expect(computeTopRowDashes(40, "Agents", "3 free")).toBe(20);
  });

  it("empty subtitle is treated as no subtitle (5-cost branch, not 8)", () => {
    expect(computeTopRowDashes(20, "Agents", "")).toBe(computeTopRowDashes(20, "Agents"));
  });

  it("floors at 1 dash when the title would overflow the terminal", () => {
    // cols=8, title="VeryLongTitle" (W=13) → would be -10, clamped to 1
    expect(computeTopRowDashes(8, "VeryLongTitle")).toBe(1);
  });

  it("handles wide-glyph titles via string-width (superscript)", () => {
    // The leading '¹ ' (U+00B9 + space, both width 1) should count as
    // 2 columns. cols=20, title='¹ Agents' (W=8) → 20 - 5 - 8 = 7
    expect(computeTopRowDashes(20, "¹ Agents")).toBe(7);
  });
});

describe("TitledBox", () => {
  it("is a function we can call as an FC", () => {
    expect(typeof TitledBox).toBe("function");
  });
});
