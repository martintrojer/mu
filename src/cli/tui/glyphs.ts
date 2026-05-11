// Single-glyph helpers shared across the TUI cluster.
//
// Today the only entry is `superscriptDigit`: returns the Unicode
// superscript form of digits 0..9 (¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ⁰). Used by:
//   - TitledBox  : prepend the card-toggle key as a header glyph
//                  (`╭─ ¹ Agents · 3 free ─...─╮` — btop convention).
//   - help.tsx   : render the same glyphs in the keymap so the visual
//                  language matches the dashboard.
//
// We keep this in its own module (not titled-box.tsx) because the
// help overlay imports it without needing the TitledBox component.

const SUPERSCRIPT = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"] as const;

/**
 * Map a single decimal digit (0..9) to its Unicode superscript form.
 * Throws on out-of-range inputs so callers can't silently drop a key.
 */
export function superscriptDigit(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9) {
    throw new RangeError(`superscriptDigit: expected integer 0..9, got ${n}`);
  }
  const g = SUPERSCRIPT[n];
  // Defensive narrow for noUncheckedIndexedAccess; bounds checked above.
  if (g === undefined) {
    throw new RangeError(`superscriptDigit: unreachable for n=${n}`);
  }
  return g;
}
