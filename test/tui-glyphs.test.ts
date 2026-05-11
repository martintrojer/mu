// superscriptDigit covers the card-header digit prefix
// (feat_card_header_digit_prefix) and the help overlay's matching
// keymap row.

import { describe, expect, it } from "vitest";
import { superscriptDigit } from "../src/cli/tui/glyphs.js";

describe("superscriptDigit", () => {
  it("returns the canonical Unicode glyph for 0..9", () => {
    expect(superscriptDigit(0)).toBe("⁰");
    expect(superscriptDigit(1)).toBe("¹");
    expect(superscriptDigit(2)).toBe("²");
    expect(superscriptDigit(3)).toBe("³");
    expect(superscriptDigit(4)).toBe("⁴");
    expect(superscriptDigit(5)).toBe("⁵");
    expect(superscriptDigit(6)).toBe("⁶");
    expect(superscriptDigit(7)).toBe("⁷");
    expect(superscriptDigit(8)).toBe("⁸");
    expect(superscriptDigit(9)).toBe("⁹");
  });

  it("throws on out-of-range inputs (so callers can't silently drop a key)", () => {
    expect(() => superscriptDigit(-1)).toThrow(RangeError);
    expect(() => superscriptDigit(10)).toThrow(RangeError);
    expect(() => superscriptDigit(1.5)).toThrow(RangeError);
    expect(() => superscriptDigit(Number.NaN)).toThrow(RangeError);
  });
});
