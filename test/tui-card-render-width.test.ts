// Per bug_tui_log_card_columns_misaligned (workstream `tui-impl`):
// the activity-log card and friends were observed wrapping rows to
// a second terminal line / overflowing the rounded right border, even
// after bug_tui_long_lines_overflow was nominally fixed (every
// layoutColumns call site started passing contentWidth). Root cause
// was a combination of (a) the gutter-accounting in the render path
// and (b) ink's default <Text> wrap behaviour: when a single <Text>
// overflows its parent <Box>, ink wraps to the next line instead of
// truncating.
//
// Defensive belt: every card and popup that renders rows via
// renderRow() must put the row's chunks inside an outermost <Text>
// with `wrap="truncate"`. That way, even if the column allocator
// under-estimates by 1-2 cells (e.g. a future row format change adds
// an extra glue space), ink truncates the row at the parent's width
// instead of wrapping it.
//
// And: every inter-cell gutter in those row JSX blocks must be
// exactly `{"  "}` — two literal spaces — matching COL_GUTTER=2 in
// src/cli/tui/columns.ts. A consumer that uses 1 space or 3 spaces
// silently breaks the protect/clip allocator's width math.
//
// Both invariants are static-source assertions: cheap, regression-
// tight, no ink renderer needed.

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

describe('every card/popup row uses wrap="truncate" on the outer <Text>', () => {
  const files = loadRowSources();

  it("discovers at least the known callers", () => {
    // 9 cards (agents, blocked, doctor, inprogress, log, ready,
    // recent, tracks, workspaces) + 8 popups (agents, blocked,
    // doctor, inprogress, log, ready, tracks, workspaces) = 17.
    // Loosen to ≥14 to be future-proof against renames.
    expect(files.length).toBeGreaterThanOrEqual(14);
  });

  for (const { name, src } of files) {
    it(`${name}: every renderRow consumer has wrap="truncate" on the outer Text`, () => {
      // Find every JSX block that destructures renderRow output;
      // the immediate <Box>...<Text...> that follows must include
      // wrap="truncate" on the outer <Text>. Crude but effective: we
      // look for the canonical pattern
      //   const padded = renderRow(...)
      //   ...
      //   <Box ...>
      //     <Text ...>
      // and verify the <Text ...> includes wrap="truncate".
      const blocks = [...src.matchAll(/renderRow\([^)]*\)[\s\S]*?<Box[^>]*>\s*<Text([^>]*)>/g)];
      expect(blocks.length, `${name}: no renderRow→Box→Text block`).toBeGreaterThan(0);
      for (const m of blocks) {
        const textAttrs = m[1] ?? "";
        expect(textAttrs, `${name}: outer <Text${textAttrs}>`).toMatch(/wrap=["']truncate["']/);
      }
    });
  }
});

describe('every card/popup row uses the canonical {"  "} (2-space) gutter', () => {
  const files = loadRowSources();

  for (const { name, src } of files) {
    it(`${name}: no row uses single-space or other-width gutter literals`, () => {
      // Inside any renderRow→…→</Text> block, the only string-literal
      // glue between <Text> chunks must be {"  "} (two spaces). One-
      // space {" "} or three-space {"   "} would break COL_GUTTER=2.
      const blocks = [...src.matchAll(/renderRow\([^)]*\)[\s\S]*?<\/Text>/g)];
      for (const m of blocks) {
        const block = m[0] ?? "";
        // Strip out the canonical 2-space gutter so we can detect any
        // OTHER bracketed-string-literal glue that remains.
        const stripped = block.replace(/\{" {2}"\}/g, "");
        // Look for any remaining bracketed pure-whitespace string
        // literal between cells.
        const stragglers = [...stripped.matchAll(/\{"\s+"\}/g)];
        expect(
          stragglers.length,
          `${name}: non-canonical whitespace literal(s): ${stragglers.map((s) => JSON.stringify(s[0])).join(", ")}`,
        ).toBe(0);
      }
    });
  }
});
