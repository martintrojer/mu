// feat_card_footer_inset (workstream `tui-impl`): the in-body
// "+M more · …" line was lifted out of every card body and inset
// into TitledBox's bottom border via the `bottomLabel` prop.
//
// This sweep collapses what used to be 7 byte-for-byte copies of
// the same trailing block (in tui-card-{blocked, doctor, inprogress,
// ready, recent, tracks, workspaces}.test.ts). The pattern was:
//
//   describe("<file>.tsx source: no in-body '+M more' line", () => {
//     it("does not render '+{...} more' as a body Text node", …);
//     it("wires bottomLabel into TitledBox", () => {
//       expect(SRC).toMatch(/bottomLabel=\{bottomLabel\}/);
//     });
//   });
//
// The original "wires bottomLabel" assertion was trivially evadable
// by accident: a stale `let bottomLabel = undefined;` followed by
// `<TitledBox bottomLabel={bottomLabel} … />` passes the regex but
// silently disables the inset. This sweep tightens that to also
// require the canonical computation shape — `const bottomLabel =
// more > 0 ? \`+${more} more · Shift+N\` : undefined;` — so a
// regression that drops the conditional or the Shift+N suffix is
// caught at the per-card level.
//
// Sibling pattern: tui-card-render-width.test.ts does the same
// loop-over-cards/* sweep for the ListRow primitive.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CARDS_DIR = join(import.meta.dirname, "..", "src", "cli", "tui", "cards");

interface Source {
  name: string;
  src: string;
}

function loadCardSources(): Source[] {
  const out: Source[] = [];
  for (const f of readdirSync(CARDS_DIR)) {
    if (!f.endsWith(".tsx")) continue;
    const src = readFileSync(join(CARDS_DIR, f), "utf8");
    out.push({ name: `cards/${f}`, src });
  }
  return out;
}

// Cards that participate in the truncation contract — they slice to
// a dynamic rowBudget and surface the overflow count via TitledBox's
// bottomLabel.
const FOOTER_INSET_CARDS = new Set([
  "cards/agents.tsx",
  "cards/blocked.tsx",
  "cards/commits.tsx",
  "cards/doctor.tsx",
  "cards/inprogress.tsx",
  "cards/ready.tsx",
  "cards/recent.tsx",
  "cards/tracks.tsx",
  "cards/workspaces.tsx",
]);

describe("feat_card_footer_inset: in-body '+M more' line lifted to TitledBox.bottomLabel", () => {
  const sources = loadCardSources();

  it("discovers all cards with truncation footers", () => {
    const found = new Set(sources.filter((s) => FOOTER_INSET_CARDS.has(s.name)).map((s) => s.name));
    for (const expected of FOOTER_INSET_CARDS) {
      expect(found, `${expected}: missing from cards/`).toContain(expected);
    }
  });

  for (const { name, src } of sources) {
    if (!FOOTER_INSET_CARDS.has(name)) continue;

    it(`${name}: does NOT render '+{...} more' as a body Text node`, () => {
      // The eliminated pattern was a literal <Text>… +{more} more · …</Text>
      // node living inside the card body. Catch both the leading-ellipsis
      // shape and the `+${more} more` template-literal shape — neither
      // should ever reappear once bottomLabel owns the inset.
      expect(src).not.toMatch(/<Text[^>]*>\s*\u2026\s*\+/);
      expect(src).not.toMatch(/<Text[^>]*>[^<]*\+\$\{[^}]+\}\s*more/);
    });

    it(`${name}: computes bottomLabel as a conditional with the canonical Shift+N suffix`, () => {
      // Tightened over the previous /bottomLabel=\{bottomLabel\}/ regex,
      // which trivially passed for `let bottomLabel = undefined; <TitledBox
      // bottomLabel={bottomLabel} … />` (silently disabling the inset).
      // Pin the computation shape: must read the overflow count from a
      // greater-than-zero check, render the canonical
      // "+{n} more · Shift+<digit>" template, and fall back to undefined
      // when there is no overflow.
      expect(src, `${name}: bottomLabel must be conditional on overflow > 0`).toMatch(
        /const\s+bottomLabel\s*=\s*[A-Za-z_$][\w$]*\s*>\s*0\s*\?\s*`\+\$\{[A-Za-z_$][\w$]*\}\s*more\s*·\s*Shift\+\d+`\s*:\s*undefined/,
      );
    });

    it(`${name}: slices visible rows with the dynamic rowBudget fallback`, () => {
      expect(src).toMatch(/slice\(0,\s*rowBudget\s*\?\?\s*cardConfig\.maxRows\)/);
    });

    it(`${name}: passes bottomLabel through to TitledBox`, () => {
      // Cheap, but kept (in addition to the tighter computation check)
      // because the prop name is the wire between the two halves: rename
      // it on TitledBox without rewiring here and the test catches it.
      expect(src).toMatch(/<TitledBox\b[\s\S]*?\bbottomLabel=\{bottomLabel\}/);
    });
  }
});
