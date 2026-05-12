// Static-source assertion that every root <Box> in src/cli/tui/app.tsx
// is pinned to height={rows}. Without this, ink's diff-based
// renderer leaves "ghost" lines below a shrinking frame on
// card-toggle / branch-swap (see bug_tui_render_ghosting_v2).
//
// We also assert the bottom-stick spacer (<Box flexGrow={1}/>) is
// present in the dashboard and help branches but ABSENT from the
// popup branch (popups own their bottom-fill — see sibling task
// bug_tui_popups_fill_pane). A regression on the spacer placement
// either ghosts (missing height) or steals popup space (extra
// spacer).
//
// Crude string scan, but cheap and catches the regression. The
// alternative — render <App> against a piped stdout and inspect the
// frame — is not robust here because ink-testing-library is not
// installable in this environment (network-blocked) and the local
// in-process harness does not exercise stdout.rows.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(import.meta.dirname, "..", "src", "cli", "tui", "app.tsx"), "utf8");
const TITLED_BOX_SRC = readFileSync(
  join(import.meta.dirname, "..", "src", "cli", "tui", "titled-box.tsx"),
  "utf8",
);

// Slice the file into the three return branches by literal anchor
// comments / `if` headers we control. Each slice ends at the next
// branch's anchor (or EOF for the dashboard). We anchor on
// branch-introducer comments ("// Help overlay", "// Popup mounted",
// "// Dashboard.") rather than the bare `if (...)` line because
// `if (popup !== null) {` also appears inside the useInput callback.
function slice(start: string, end: string | null): string {
  const i = SRC.indexOf(start);
  expect(i, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
  if (end === null) return SRC.slice(i);
  const j = SRC.indexOf(end, i + start.length);
  expect(j, `end-anchor not found: ${end}`).toBeGreaterThan(i);
  return SRC.slice(i, j);
}

const helpBranch = slice("// Help overlay covers everything else", "// Popup mounted:");
const popupBranch = slice("// Popup mounted:", "// Dashboard.");
const dashboardBranch = slice("// Dashboard.", null);

describe("app.tsx root <Box> frame-height pin (anti-ghosting)", () => {
  it("dashboard root <Box> is pinned to height={rows}", () => {
    expect(dashboardBranch).toMatch(/<Box\b[^>]*\bheight=\{rows\}/);
  });

  it("help root <Box> is pinned to height={rows}", () => {
    expect(helpBranch).toMatch(/<Box\b[^>]*\bheight=\{rows\}/);
  });

  it("popup root <Box> is pinned to height={rows}", () => {
    expect(popupBranch).toMatch(/<Box\b[^>]*\bheight=\{rows\}/);
  });

  it("dashboard branch has a flexGrow={1} spacer (bottom-sticks status bar)", () => {
    expect(dashboardBranch).toMatch(/<Box\s+flexGrow=\{1\}\s*\/>/);
  });

  it("help branch has a flexGrow={1} spacer (bottom-sticks status bar)", () => {
    expect(helpBranch).toMatch(/<Box\s+flexGrow=\{1\}\s*\/>/);
  });

  it("popup branch does NOT add a sibling flexGrow spacer (popup owns bottom-fill)", () => {
    // The popup body itself owns expansion; an outer sibling spacer
    // would steal the space the popup wants. See caveat in the task
    // notes for bug_tui_render_ghosting_v2 + sibling task
    // bug_tui_popups_fill_pane.
    expect(popupBranch).not.toMatch(/<Box\s+flexGrow=\{1\}\s*\/>/);
  });

  it("dashboard root <Box> still pins overflow=hidden (Layer 2 fix)", () => {
    // Layer 2 of bug_tui_tab_switch_stale_render: the height-pinned
    // root MUST clip children that would otherwise scroll the
    // topmost row off-screen. Regression risk: someone "simplifying"
    // the dashboard branch could drop overflow="hidden" thinking
    // the new flexShrink in TitledBox is enough — it isn't on its
    // own; both belt AND braces are required.
    expect(dashboardBranch).toMatch(/<Box\b[^>]*\boverflow="hidden"/);
  });
});

// bug_tui_dashboard_top_card_scrolls_off — single-ws regression
// guard. Even WITH the dashboard root's height={rows} +
// overflow="hidden" pin, ink (via Yoga) gives every card its
// natural height first because Yoga's default flexShrink is 0
// (unlike CSS's 1). When the nine cards' summed natural height
// exceeds rows, the topmost card's chrome scrolls off the top of
// the terminal. The fix is to give every card permission to shrink:
// flexShrink=1 on the TitledBox outer Box (one place — every card
// is a TitledBox). This test pins that invariant so a future refactor
// of TitledBox doesn't silently regress.
describe("TitledBox card-shrink (anti-topmost-scroll)", () => {
  it("TitledBox outer Box pins flexShrink so cards yield space when overflowing", () => {
    // Match the outer <Box ...> that opens the JSX returned by
    // TitledBox. Looking for both the explicit flexShrink prop
    // (preferred form) AND the documented constant so a renaming
    // refactor surfaces here.
    expect(TITLED_BOX_SRC).toMatch(/flexShrink=\{TITLED_BOX_FLEX_SHRINK\}/);
    expect(TITLED_BOX_SRC).toMatch(/const TITLED_BOX_FLEX_SHRINK = 1;/);
  });

  it("TitledBox outer Box pins overflow=hidden so the inner border-body clips when shrunk", () => {
    // Without this the inner bordered Box overruns the now-shrunken
    // outer slot and the visible artifact (topmost border lost) comes
    // back even though Yoga did the math correctly.
    expect(TITLED_BOX_SRC).toMatch(/<Box\b[\s\S]{0,200}overflow="hidden"/);
  });
});

// Layer-2 regression for bug_tui_tab_switch_stale_render: the
// multi-ws TabStrip adds a row of vertical content. Without
// overflow="hidden" on the height={rows}-pinned root Box, ink
// emits any overflowing rows past the terminal bottom, the
// terminal scrolls, and the topmost card's top border vanishes
// off the top edge. Clipping at the root keeps the frame bounded
// inside the viewport, so nothing escapes above row 1.
describe("app.tsx root <Box> overflow clip (anti-scroll-off-top)", () => {
  it('dashboard root <Box> sets overflow="hidden"', () => {
    expect(dashboardBranch).toMatch(/<Box\b[^>]*\boverflow="hidden"/);
  });

  it('help root <Box> sets overflow="hidden"', () => {
    expect(helpBranch).toMatch(/<Box\b[^>]*\boverflow="hidden"/);
  });

  it('popup root <Box> sets overflow="hidden"', () => {
    expect(popupBranch).toMatch(/<Box\b[^>]*\boverflow="hidden"/);
  });

  it("TabStrip is INSIDE the dashboard's height-pinned + clipping root", () => {
    // Anchored on the dashboard branch ONLY (the TabStrip MUST not
    // be promoted above <Box height={rows} overflow="hidden">; if it
    // were, flexbox wouldn't account for its row when sizing the
    // cards below it, and the multi-ws frame would still scroll the
    // top border off the viewport).
    const root = dashboardBranch.indexOf(
      '<Box flexDirection="column" height={rows} overflow="hidden">',
    );
    const strip = dashboardBranch.indexOf("<TabStrip");
    expect(root, "dashboard root box not found").toBeGreaterThanOrEqual(0);
    expect(strip, "TabStrip not found in dashboard branch").toBeGreaterThanOrEqual(0);
    expect(strip).toBeGreaterThan(root);
  });
});
