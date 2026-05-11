// Tests for src/cli/tui/keys.ts (Wave 4 Task 20 of
// docs/plans/2026-05-11-interactive-tui.md).
//
// Pure-function dispatcher; one test per binding from the
// design_global_keymap summary table.

import { describe, expect, it } from "vitest";
import { dispatchGlobalKey } from "../src/cli/tui/keys.js";

const NO_KEY = {};

describe("dispatchGlobalKey: card toggles 1-9", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    ["3", 3],
    ["4", 4],
    ["5", 5],
    ["6", 6],
    ["7", 7],
    ["8", 8],
    ["9", 9],
  ] as const)("%s toggles card %d", (input, cardId) => {
    expect(dispatchGlobalKey(input, NO_KEY)).toEqual({ kind: "toggleCard", cardId });
  });

  // (digit 0 is bound to tickReset — covered in the tick-rate suite
  // below; not re-asserted here.)
});

describe("dispatchGlobalKey: popup openers (Shift+1..Shift+9 → ! @ # $ % ^ & * ()", () => {
  it.each([
    ["!", 1],
    ["@", 2],
    ["#", 3],
    ["$", 4],
    ["%", 5],
    ["^", 6],
    ["&", 7],
    ["*", 8],
    ["(", 9],
  ] as const)("%s opens popup %d", (input, cardId) => {
    expect(dispatchGlobalKey(input, NO_KEY)).toEqual({ kind: "openPopup", cardId });
  });

  it("the remaining shifted-digit glyph ( ) ) is a noop in v0", () => {
    // ALL nine slots promoted: slot-5 (`%`) by feat_popup_5_workspaces;
    // slot-6 (`^`) by feat_popup_6_inprogress; slot-7 (`&`) by
    // feat_popup_7_blocked; slot-8 (`*`) by feat_popup_8_recent;
    // slot-9 (`(`) by feat_popup_9_doctor. Only `)` (a stray glyph
    // outside the digit set) remains as a regression guard.
    for (const g of [")"]) {
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
  it("F1 is no longer a help alias (dropped per nit_tui_remove_f1_help_toggle)", () => {
    // Function keys are remapped/eaten by tmux/screen and fire OS-level
    // help in many terminals. '?' is the canonical help binding
    // (lazygit/btop/k9s/vim) and works everywhere — single key, single
    // place to document.
    expect(dispatchGlobalKey("", { f1: true } as { f1: true })).toEqual({ kind: "noop" });
  });
  it("c clearFooter (without ctrl)", () => {
    expect(dispatchGlobalKey("c", NO_KEY)).toEqual({ kind: "clearFooter" });
  });
  it("w workstreamPicker (reserved)", () => {
    expect(dispatchGlobalKey("w", NO_KEY)).toEqual({ kind: "workstreamPicker" });
  });
});

describe("dispatchGlobalKey: workstream tab navigation (multi-ws TUI)", () => {
  // Per feat_tui_multi_workstream (workstream `tui-impl`): Tab
  // cycles to the next workstream tab, Shift-Tab to the previous.
  // The dispatcher emits the action unconditionally; the App
  // suppresses the action while a popup is open and degenerates
  // to a noop when only one workstream is loaded.
  it("Tab nextTab", () => {
    expect(dispatchGlobalKey("", { tab: true })).toEqual({ kind: "nextTab" });
  });
  it("Shift-Tab prevTab", () => {
    expect(dispatchGlobalKey("", { tab: true, shift: true })).toEqual({ kind: "prevTab" });
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

import { dispatchPopupKey } from "../src/cli/tui/keys.js";

describe("dispatchPopupKey: in-popup convention", () => {
  it("Esc closes", () => {
    expect(dispatchPopupKey("", { escape: true })).toEqual({ kind: "close" });
  });
  it("q/Q closes", () => {
    expect(dispatchPopupKey("q", NO_KEY)).toEqual({ kind: "close" });
    expect(dispatchPopupKey("Q", NO_KEY)).toEqual({ kind: "close" });
  });
  it("j/down moveDown", () => {
    expect(dispatchPopupKey("j", NO_KEY)).toEqual({ kind: "moveDown" });
    expect(dispatchPopupKey("", { downArrow: true })).toEqual({ kind: "moveDown" });
  });
  it("k/up moveUp", () => {
    expect(dispatchPopupKey("k", NO_KEY)).toEqual({ kind: "moveUp" });
    expect(dispatchPopupKey("", { upArrow: true })).toEqual({ kind: "moveUp" });
  });
  it("g/G top/bottom", () => {
    expect(dispatchPopupKey("g", NO_KEY)).toEqual({ kind: "jumpTop" });
    expect(dispatchPopupKey("G", NO_KEY)).toEqual({ kind: "jumpBottom" });
  });
  it("/ enters filter", () => {
    expect(dispatchPopupKey("/", NO_KEY)).toEqual({ kind: "filter" });
  });
  it("n/N next/prev match", () => {
    expect(dispatchPopupKey("n", NO_KEY)).toEqual({ kind: "nextMatch" });
    expect(dispatchPopupKey("N", NO_KEY)).toEqual({ kind: "prevMatch" });
  });
  it("y yanks", () => {
    expect(dispatchPopupKey("y", NO_KEY)).toEqual({ kind: "yank" });
  });
  it("Enter drills (Return key flag)", () => {
    expect(dispatchPopupKey("", { return: true })).toEqual({ kind: "drill" });
  });
  it("Esc / q from drill mode is just `close` — callers route based on their mode", () => {
    // dispatchPopupKey is pure: it doesn't know whether the popup
    // is in list or drill mode. Both Esc and q always emit `close`,
    // and the popup's switch decides whether that means
    // "back-to-list" or "close-popup". Verifies the contract: the
    // dispatcher must NOT mint a separate `closeDrill` kind — the
    // popup is the source of truth for its sub-mode.
    expect(dispatchPopupKey("", { escape: true })).toEqual({ kind: "close" });
    expect(dispatchPopupKey("q", NO_KEY)).toEqual({ kind: "close" });
  });
  it("Ctrl-D pageDown half, Ctrl-U pageUp half", () => {
    expect(dispatchPopupKey("d", { ctrl: true })).toEqual({ kind: "pageDown", half: true });
    expect(dispatchPopupKey("u", { ctrl: true })).toEqual({ kind: "pageUp", half: true });
  });
  it("PgDn/PgUp full pageDown/pageUp", () => {
    expect(dispatchPopupKey("", { pageDown: true })).toEqual({ kind: "pageDown", half: false });
    expect(dispatchPopupKey("", { pageUp: true })).toEqual({ kind: "pageUp", half: false });
  });
  it("other letters bubble up as verbs", () => {
    expect(dispatchPopupKey("f", NO_KEY)).toEqual({ kind: "verb", key: "f" });
    expect(dispatchPopupKey("x", NO_KEY)).toEqual({ kind: "verb", key: "x" });
    expect(dispatchPopupKey("t", NO_KEY)).toEqual({ kind: "verb", key: "t" });
  });
  it("digits and punctuation are noops in popup convention", () => {
    expect(dispatchPopupKey("1", NO_KEY)).toEqual({ kind: "noop" });
    expect(dispatchPopupKey("!", NO_KEY)).toEqual({ kind: "noop" });
    expect(dispatchPopupKey("+", NO_KEY)).toEqual({ kind: "noop" });
  });
});
