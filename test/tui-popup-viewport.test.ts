// Pure-function tests for popups/viewport.ts plus a static-source
// regression assertion that no popup file still hardcodes
// `const VIEWPORT = 20` at module scope (the bug fixed by
// bug_tui_popup_data_doesnt_fill).
//
// The boundary tests live alongside the regression scan because
// both protect the same invariant: every popup must size its body
// from the live terminal height, not a stale module-scope constant.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  POPUP_CHROME_ROWS,
  POPUP_VIEWPORT_FLOOR,
  popupViewport,
} from "../src/cli/tui/popups/viewport.js";

const POPUPS_DIR = join(import.meta.dirname, "..", "src", "cli", "tui", "popups");

const POPUP_FILES = [
  "agents.tsx",
  "blocked.tsx",
  "log.tsx",
  "ready.tsx",
  "tracks.tsx",
  "workspaces.tsx",
] as const;

describe("popupViewport", () => {
  it("subtracts the default chrome budget from terminal rows", () => {
    expect(popupViewport(60)).toBe(60 - POPUP_CHROME_ROWS);
    expect(popupViewport(40)).toBe(40 - POPUP_CHROME_ROWS);
  });

  it("subtracts an explicit chromeOverride when provided", () => {
    // Workspaces drill subtracts 7 (default + 1 for the drill's
    // in-body title indicator).
    expect(popupViewport(60, 7)).toBe(53);
    expect(popupViewport(40, 7)).toBe(33);
  });

  it("floors at POPUP_VIEWPORT_FLOOR for very small terminals", () => {
    // 12 rows - 6 chrome = 6 → would be too cramped; floor lifts to 8.
    expect(popupViewport(12)).toBe(POPUP_VIEWPORT_FLOOR);
    // Even when chromeOverride would push us negative.
    expect(popupViewport(5, 10)).toBe(POPUP_VIEWPORT_FLOOR);
    expect(popupViewport(0)).toBe(POPUP_VIEWPORT_FLOOR);
  });

  it("returns at least the floor exactly at the boundary", () => {
    // floor + chrome = 8 + 6 = 14 → at 14 rows we should compute
    // exactly the floor, not below it.
    expect(popupViewport(POPUP_CHROME_ROWS + POPUP_VIEWPORT_FLOOR)).toBe(POPUP_VIEWPORT_FLOOR);
  });

  it("scales linearly above the floor (ink resize honored)", () => {
    // The whole point: a 60-row pane gets a 54-row viewport, a
    // 100-row pane gets 94. (Compared to the old hardcoded 20.)
    expect(popupViewport(60)).toBeGreaterThan(20);
    expect(popupViewport(100)).toBeGreaterThan(popupViewport(60));
  });
});

describe("no popup file still hardcodes `const VIEWPORT = 20`", () => {
  // Cheap regex catches the regression. After the fix, every popup
  // computes `viewport` per-render from useStdout().rows via
  // popupViewport(); the literal module-scope constant is forbidden.
  for (const name of POPUP_FILES) {
    it(`${name} contains no module-scope \`const VIEWPORT = 20\``, () => {
      const src = readFileSync(join(POPUPS_DIR, name), "utf8");
      // The constant lived at module scope (not indented) — match
      // ^ to keep the regex tight. Comments mentioning VIEWPORT are
      // fine; they're either in /comments/ or indented.
      expect(src).not.toMatch(/^const VIEWPORT = 20/m);
    });
  }
});

describe("each popup reads useStdout().rows for its viewport", () => {
  // Companion check: every popup must call popupViewport with
  // stdout.rows (or stdout?.rows) so live terminal-resize events
  // actually re-flow the body. The bug was that flexGrow={1} grew
  // the Shell box, but the data slice still used the stale 20.
  for (const name of POPUP_FILES) {
    it(`${name} imports popupViewport and feeds it stdout.rows`, () => {
      const src = readFileSync(join(POPUPS_DIR, name), "utf8");
      expect(src).toMatch(/popupViewport/);
      // Accept stdout.rows or stdout?.rows for idiomatic variation.
      expect(src).toMatch(/popupViewport\(\s*stdout\??\.rows[^)]*\)/);
    });
  }
});
