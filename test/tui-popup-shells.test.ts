// Static-source assertion that every popup's local Shell/PopupShell
// component fills the popup pane on BOTH axes:
//   - flexGrow={1}    → vertical: occupy room granted by App's
//                       height-pinned popup branch.
//   - width={cols}    → horizontal: edge-to-edge, mirroring
//                       titled-box.tsx's cols-from-useStdout pattern.
//
// Without either, ink's Yoga layout sizes the Shell to its content
// and the popup renders as a narrow strip in the upper-left of the
// pane (the symptom of bug_tui_popups_fill_pane).
//
// We also assert that for popups with a "viewport + bottom hint"
// layout, the body region is itself wrapped in a flexGrow={1} box
// so the hint sticks to the popup's bottom (lazygit/btop "sticky
// bottom hint" convention).
//
// Crude string scan, but cheap and catches the regression. The
// alternative — render the popup against ink-testing-library — is
// not installable in this network-blocked environment.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const POPUPS_DIR = join(import.meta.dirname, "..", "src", "cli", "tui", "popups");

function load(name: string): string {
  return readFileSync(join(POPUPS_DIR, name), "utf8");
}

const AGENTS = load("agents.tsx");
const LOG = load("log.tsx");
const READY = load("ready.tsx");
const TRACKS = load("tracks.tsx");
const WORKSPACES = load("workspaces.tsx");

// Each shell function definition starts with `function Shell(` or
// `function PopupShell(`. We slice from that header to the closing
// `}` of its first containing return (cheap heuristic: the popup
// files have no other top-level Shell/PopupShell, and the function
// body is short). For robustness we slice to EOF — the Shell is
// always defined last in each file.
function shellSource(src: string, fnName: "Shell" | "PopupShell"): string {
  const anchor = `function ${fnName}(`;
  const i = src.indexOf(anchor);
  expect(i, `${fnName} not found`).toBeGreaterThanOrEqual(0);
  return src.slice(i);
}

describe("popup Shell / PopupShell fills the pane (anti-narrow-strip)", () => {
  const cases: ReadonlyArray<{ name: string; src: string; fn: "Shell" | "PopupShell" }> = [
    { name: "agents.tsx", src: AGENTS, fn: "Shell" },
    { name: "log.tsx", src: LOG, fn: "Shell" },
    { name: "ready.tsx", src: READY, fn: "PopupShell" },
    { name: "tracks.tsx", src: TRACKS, fn: "Shell" },
    { name: "workspaces.tsx", src: WORKSPACES, fn: "Shell" },
  ];

  for (const { name, src, fn } of cases) {
    describe(name, () => {
      const shell = shellSource(src, fn);

      it(`${fn}'s outer <Box> sets flexGrow={1} (vertical fill)`, () => {
        expect(shell).toMatch(/flexGrow=\{1\}/);
      });

      it(`${fn}'s outer <Box> sets width={cols} (horizontal fill)`, () => {
        expect(shell).toMatch(/width=\{cols\}/);
      });

      it(`${fn} derives cols from useStdout()`, () => {
        // Mirrors titled-box.tsx's pattern. We accept either
        // `stdout.columns` or `stdout?.columns` to leave room for
        // small idiomatic variation.
        expect(shell).toMatch(/useStdout\(\)/);
        expect(shell).toMatch(/stdout\??\.columns/);
      });

      it(`${name} imports useStdout from "ink"`, () => {
        expect(src).toMatch(/from "ink";/);
        expect(src).toMatch(/\buseStdout\b/);
      });
    });
  }
});

describe("popup body region wraps content in flexGrow={1} (sticky bottom hint)", () => {
  // Each popup that has a list-of-rows + bottom hint should wrap
  // the rows in `<Box flexDirection="column" flexGrow={1}>` so the
  // hint sticks to the bottom of the Shell rather than floating
  // directly beneath the rows.
  const cases: ReadonlyArray<{ name: string; src: string }> = [
    { name: "agents.tsx", src: AGENTS },
    { name: "log.tsx", src: LOG },
    { name: "ready.tsx", src: READY },
    { name: "tracks.tsx", src: TRACKS },
    { name: "workspaces.tsx", src: WORKSPACES },
  ];

  for (const { name, src } of cases) {
    it(`${name} contains a flexGrow={1} body wrapper`, () => {
      // Match either property order.
      expect(src).toMatch(
        /<Box[^>]*\bflexDirection="column"[^>]*\bflexGrow=\{1\}|<Box[^>]*\bflexGrow=\{1\}[^>]*\bflexDirection="column"/,
      );
    });
  }
});
