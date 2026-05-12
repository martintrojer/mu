// Reframed by feat_centralize_list_row_render (workstream
// `tui-impl`).
//
// The original predecessors:
//   bug_tui_log_card_columns_misaligned    — wrap="truncate" on every outer Text
//   bug_tui_log_popup_columns_misaligned   — width pin on every outer Box
// asserted that EVERY renderRow consumer pulled its weight by hand:
// outer <Text wrap="truncate">, outer <Box width={contentWidth}>,
// canonical 2-space gutters between cells.
//
// After feat_centralize_list_row_render those four invariants live
// inside ONE component — src/cli/tui/list-row.tsx (and its sibling
// src/cli/tui/popups/cursor-row.tsx for the selected branch). Every
// renderRow consumer now routes its rows through <ListRow .../>;
// the hand-rolled <Box ...><Text wrap="truncate">...</Text></Box>
// pattern is gone.
//
// The static-source assertion changes shape accordingly: every
// renderRow consumer must use <ListRow .../> for non-selected rows.
// `selected` rows route through ListRow's `selected` prop (which
// defers to CursorRow internally); a couple of legacy call sites
// still construct <CursorRow ... /> directly, which we tolerate
// (it's the same primitive). What we DON'T tolerate is a hand-
// rolled <Box ...><Text wrap=...>...</Text></Box> following a
// renderRow() result — that's the copy-paste bug class the
// centralisation eliminated.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TUI_DIR = join(import.meta.dirname, "..", "src", "cli", "tui");
const DIRS = ["cards", "popups"];

interface Source {
  name: string;
  src: string;
}

function loadRowSources(): Source[] {
  const out: Source[] = [];
  for (const dir of DIRS) {
    const full = join(TUI_DIR, dir);
    for (const f of readdirSync(full)) {
      if (!f.endsWith(".tsx")) continue;
      const path = join(full, f);
      const src = readFileSync(path, "utf8");
      // Only consider files that actually call renderRow — those are
      // the ones laying out tabular data. Drilldowns, prompts, footers
      // and shells don't.
      if (!/\brenderRow\(/.test(src)) continue;
      out.push({ name: `${dir}/${f}`, src });
    }
  }
  return out;
}

describe("every renderRow consumer routes its rows through <ListRow> (or CursorRow)", () => {
  const files = loadRowSources();

  it("discovers at least the known callers", () => {
    // 9 cards (agents, blocked, doctor, inprogress, log, ready,
    // recent, tracks, workspaces) + 8 popups (agents, blocked,
    // doctor, inprogress, log, ready, tracks, workspaces) = 17.
    // (recent popup is here too post-centralisation but we keep the
    // floor at 14 to be future-proof against renames.)
    expect(files.length).toBeGreaterThanOrEqual(14);
  });

  for (const { name, src } of files) {
    it(`${name}: imports ListRow from the cluster root`, () => {
      // Cards reach up one level (../list-row.js); popups reach up
      // one level too (../list-row.js). Both sit a single dir below
      // src/cli/tui/.
      expect(src).toMatch(/import\s*\{[^}]*\bListRow\b[^}]*\}\s*from\s*["']\.\.\/list-row\.js["']/);
    });

    it(`${name}: every renderRow consumer renders rows via <ListRow ...>`, () => {
      // Find every JSX block that follows a renderRow(...) call: the
      // very next JSX element in the same .map() iteration must be
      // <ListRow ...> (which internally pins width, gutter, wrap, and
      // delegates to CursorRow when selected). Tolerate <CursorRow ...>
      // too — a couple of call sites still construct it directly for
      // the selected branch (it's the SAME primitive ListRow defers to
      // when selected=true), and the cursor-row.test.ts already gates
      // that usage.
      //
      // Crude but effective: capture the first JSX-element opening
      // tag that appears after renderRow(...), bounded by ).
      const blocks = [...src.matchAll(/renderRow\([^)]*\)[\s\S]*?<([A-Z][A-Za-z0-9]*)/g)];
      expect(blocks.length, `${name}: no renderRow→JSX block`).toBeGreaterThan(0);
      for (const m of blocks) {
        const tag = m[1] ?? "";
        expect(
          tag,
          `${name}: renderRow(...) followed by <${tag}> (must be <ListRow> or <CursorRow>)`,
        ).toMatch(/^(ListRow|CursorRow)$/);
      }
    });

    it(`${name}: no hand-rolled outer <Box ...><Text wrap=...> row remains`, () => {
      // The eliminated copy-paste bug class: every popup/card was
      // re-rendering its own <Box width={contentWidth}><Text
      // wrap="truncate">...</Text></Box> shell around the cells. The
      // centralisation moves that shell into ListRow. After the
      // refactor, no renderRow consumer should still contain that
      // inner <Box>+<Text wrap=...> pair.
      //
      // Note: the Shell / TitledBox at the top of each file is fine
      // (it doesn't carry a wrap="truncate" Text inside) and so is
      // any empty-state body text. We only flag the per-row pattern.
      const blocks = [...src.matchAll(/renderRow\([^)]*\)[\s\S]*?<Box[^>]*>\s*<Text[^>]*wrap=/g)];
      expect(blocks.length, `${name}: still has hand-rolled <Box><Text wrap=...> row(s)`).toBe(0);
    });
  }
});
