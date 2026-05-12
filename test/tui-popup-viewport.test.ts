// Pure-function tests for popups/viewport.ts plus a static-source
// regression assertion that every popup uses the centralised
// `usePopupViewport()` hook instead of a module-scope `const
// VIEWPORT = 20` (the bug originally fixed by
// bug_tui_popup_data_doesnt_fill, then re-asserted across all 9
// popups by bug_tui_inprogress_recent_drill_viewport_clipped —
// inprogress + recent had been missed in the first sweep, and the
// hook was introduced so the next regression can't slip through
// the same way).
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
  "doctor.tsx",
  "inprogress.tsx",
  "log.tsx",
  "ready.tsx",
  "recent.tsx",
  "tracks.tsx",
  "workspaces.tsx",
] as const;

describe("popupViewport", () => {
  it("subtracts the default chrome budget from terminal rows", () => {
    expect(popupViewport(60)).toBe(60 - POPUP_CHROME_ROWS);
    expect(popupViewport(40)).toBe(40 - POPUP_CHROME_ROWS);
  });

  it("subtracts an explicit chromeOverride when provided", () => {
    // Workspaces drill subtracts an explicit budget for its in-body
    // title indicator. The exact number is the popup's choice; the
    // helper just honours the override.
    expect(popupViewport(60, 7)).toBe(53);
    expect(popupViewport(40, 7)).toBe(33);
  });

  it("floors at POPUP_VIEWPORT_FLOOR for very small terminals", () => {
    // 10 rows - 3 chrome = 7 → would be too cramped; floor lifts to 8.
    expect(popupViewport(10)).toBe(POPUP_VIEWPORT_FLOOR);
    // Even when chromeOverride would push us negative.
    expect(popupViewport(5, 10)).toBe(POPUP_VIEWPORT_FLOOR);
    expect(popupViewport(0)).toBe(POPUP_VIEWPORT_FLOOR);
  });

  it("returns at least the floor exactly at the boundary", () => {
    // floor + chrome = 8 + 3 = 11 → at 11 rows we should compute
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

describe("each popup uses the centralised usePopupViewport() hook", () => {
  // Companion check: every popup must call usePopupViewport() so
  // live terminal-resize events actually re-flow the body. The
  // original bug was that flexGrow={1} grew the Shell box, but the
  // data slice still used the stale 20. The hook centralises the
  // useStdout()+popupViewport() pair so the next popup can't be
  // born with another hardcoded constant.
  for (const name of POPUP_FILES) {
    it(`${name} imports and calls usePopupViewport()`, () => {
      const src = readFileSync(join(POPUPS_DIR, name), "utf8");
      expect(src).toMatch(
        /import\s*\{[^}]*\busePopupViewport\b[^}]*\}\s*from\s*"\.\/viewport\.js"/,
      );
      expect(src).toMatch(/usePopupViewport\(/);
      // And the raw escape hatch is gone: no popup should still
      // wire `popupViewport(stdout?.rows ?? 24)` by hand.
      expect(src).not.toMatch(/popupViewport\(\s*stdout\??\.rows/);
    });
  }
});
