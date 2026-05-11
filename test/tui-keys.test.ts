// Tests for src/cli/tui/keys.ts (Wave 4 Task 20 of
// docs/plans/2026-05-11-interactive-tui.md).
//
// Pure-function dispatcher; one test per binding from the
// design_global_keymap summary table.

import { describe, expect, it } from "vitest";
import { dispatchGlobalKey } from "../src/cli/tui/keys.js";

const NO_KEY = {};

describe("dispatchGlobalKey: card toggles 1-4", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    ["3", 3],
    ["4", 4],
  ] as const)("%s toggles card %d", (input, cardId) => {
    expect(dispatchGlobalKey(input, NO_KEY)).toEqual({ kind: "toggleCard", cardId });
  });

  it("digits 5-9 do not toggle (reserved slots)", () => {
    for (const d of ["5", "6", "7", "8", "9"]) {
      expect(dispatchGlobalKey(d, NO_KEY)).toEqual({ kind: "noop" });
    }
  });
});

describe("dispatchGlobalKey: popup openers (Shift+1..Shift+4 → ! @ # $)", () => {
  it.each([
    ["!", 1],
    ["@", 2],
    ["#", 3],
    ["$", 4],
  ] as const)("%s opens popup %d", (input, cardId) => {
    expect(dispatchGlobalKey(input, NO_KEY)).toEqual({ kind: "openPopup", cardId });
  });

  it("the other shifted-digit glyphs (% ^ & * () are noops in v0", () => {
    for (const g of ["%", "^", "&", "*", "(", ")"]) {
      expect(dispatchGlobalKey(g, NO_KEY)).toEqual({ kind: "noop" });
    }
  });
});

describe("dispatchGlobalKey: tick rate adjust", () => {
  it("+ tickFaster", () => {
    expect(dispatchGlobalKey("+", NO_KEY)).toEqual({ kind: "tickFaster" });
  });
  it("= tickFaster (unshifted alias)", () => {
    expect(dispatchGlobalKey("=", NO_KEY)).toEqual({ kind: "tickFaster" });
  });
  it("- tickSlower", () => {
    expect(dispatchGlobalKey("-", NO_KEY)).toEqual({ kind: "tickSlower" });
  });
  it("0 tickReset", () => {
    expect(dispatchGlobalKey("0", NO_KEY)).toEqual({ kind: "tickReset" });
  });
});

describe("dispatchGlobalKey: refresh / quit / help / footer-clear", () => {
  it("r refreshNow", () => {
    expect(dispatchGlobalKey("r", NO_KEY)).toEqual({ kind: "refreshNow" });
  });
  it("F5 refreshNow", () => {
    expect(dispatchGlobalKey("", { f5: true })).toEqual({ kind: "refreshNow" });
  });
  it("q quit", () => {
    expect(dispatchGlobalKey("q", NO_KEY)).toEqual({ kind: "quit" });
  });
  it("Q quit", () => {
    expect(dispatchGlobalKey("Q", NO_KEY)).toEqual({ kind: "quit" });
  });
  it("Ctrl-C quit", () => {
    expect(dispatchGlobalKey("c", { ctrl: true })).toEqual({ kind: "quit" });
  });
  it("? toggleHelp", () => {
    expect(dispatchGlobalKey("?", NO_KEY)).toEqual({ kind: "toggleHelp" });
  });
  it("F1 toggleHelp", () => {
    expect(dispatchGlobalKey("", { f1: true })).toEqual({ kind: "toggleHelp" });
  });
  it("c clearFooter (without ctrl)", () => {
    expect(dispatchGlobalKey("c", NO_KEY)).toEqual({ kind: "clearFooter" });
  });
  it("w workstreamPicker (reserved)", () => {
    expect(dispatchGlobalKey("w", NO_KEY)).toEqual({ kind: "workstreamPicker" });
  });
});

describe("dispatchGlobalKey: unknown input", () => {
  it("returns noop for unrecognised characters", () => {
    for (const c of ["x", "z", "/", ".", " ", "\n"]) {
      expect(dispatchGlobalKey(c, NO_KEY)).toEqual({ kind: "noop" });
    }
  });
  it("returns noop for empty input without flags", () => {
    expect(dispatchGlobalKey("", NO_KEY)).toEqual({ kind: "noop" });
  });
});
