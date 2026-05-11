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
});
