// Geometry tests for TitledBox — the rounded-border container whose
// header sits INSIDE the top border line (lazygit/htop/btop style).
//
// Pinning the dash-fill arithmetic in a pure helper means we don't
// have to render-and-snapshot ink output to catch off-by-one drift.

import { describe, expect, it } from "vitest";
import {
  TitledBox,
  computeBorderRowDashes,
  computeTopRowDashes,
} from "../src/cli/tui/titled-box.js";

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

describe("computeTopRowDashes — cardId prefix", () => {
  it("reserves 2 cols for the digit + separator", () => {
    // cols=20, title="Agents" (6), cardId=1 (¹)
    // base = 20 - 5 - 6 = 9; prefix steals 2 → 7
    expect(computeTopRowDashes(20, "Agents", undefined, 1)).toBe(7);
  });

  it("composes with subtitle (digit + ' ' + title + ' · ' + subtitle)", () => {
    // cols=40, title="Agents" (6), subtitle="3 free" (6), cardId=1
    // 40 - 8 - 6 - 6 - 2 = 18
    expect(computeTopRowDashes(40, "Agents", "3 free", 1)).toBe(18);
  });

  it("undefined cardId == 0 prefix cost", () => {
    expect(computeTopRowDashes(40, "Agents", "3 free")).toBe(
      computeTopRowDashes(40, "Agents", "3 free", undefined),
    );
  });
});

describe("computeBorderRowDashes", () => {
  it("label-only — '╰─ L ───...╯' is exactly cols wide", () => {
    // cols=20, label="+11 more · Shift+3" (W=18) → 20 - 5 - 18 = -3
    // floors at 1
    expect(computeBorderRowDashes(20, "+11 more · Shift+3")).toBe(1);
  });

  it("shorter label leaves room for dash-fill", () => {
    // cols=40, label="+2 more · Shift+3" (W=17) → 40 - 5 - 17 = 18
    expect(computeBorderRowDashes(40, "+2 more · Shift+3")).toBe(18);
  });

  it("empty-string label still floors at the 5-fixed budget", () => {
    // cols=10, label="" (W=0) → 10 - 5 - 0 = 5
    expect(computeBorderRowDashes(10, "")).toBe(5);
  });

  it("floors at 1 when the label would overflow the terminal", () => {
    expect(computeBorderRowDashes(8, "VeryLongBottomLabel")).toBe(1);
  });

  it("matches computeTopRowDashes when the label has no subtitle/digit", () => {
    // computeTopRowDashes(40, 'Agents') == computeBorderRowDashes(40, 'Agents')
    // — the title-only top row is exactly the generic shape.
    expect(computeBorderRowDashes(40, "Agents")).toBe(computeTopRowDashes(40, "Agents"));
  });
});

describe("TitledBox", () => {
  it("is a function we can call as an FC", () => {
    // Direct invocation goes deeper than this (hits useStdout, which
    // needs an ink render context); the existence check is enough
    // to catch import-graph drift. The bottom-row geometry is
    // pinned by computeBorderRowDashes above; the bottomLabel
    // wire-up is verified by the per-card source regex tests.
    expect(typeof TitledBox).toBe("function");
  });
});
