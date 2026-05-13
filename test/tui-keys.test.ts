// Tests for src/cli/tui/keys.ts.
//
// Pure-function dispatcher; one test per binding from the
// design_global_keymap summary table.

import { describe, expect, it } from "vitest";
import {
  dispatchGlobalKey,
  dispatchGlobalKeyFromInk,
  dispatchPopupKey,
  dispatchPopupKeyFromInk,
  shouldSwallowGlobalKey,
  shouldSwallowGlobalKeyFromInk,
} from "../src/cli/tui/keys.js";
import type { InputMode, KeyFlags } from "../src/cli/tui/keys.js";
import { statusForToggleKey } from "../src/cli/tui/use-status-filter.js";

const NO_KEY: KeyFlags = {};
const KEY_DEFAULTS: Required<KeyFlags> = {
  ctrl: false,
  shift: false,
  meta: false,
  escape: false,
  return: false,
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  tab: false,
  pageUp: false,
  pageDown: false,
  f5: false,
};
const F1_KEY = { ...KEY_DEFAULTS, f1: true };

describe("dispatchGlobalKey: card toggles 0-9", () => {
  it.each([
    ["0", 0],
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
});

describe("dispatchGlobalKey: popup openers (g + Shift+0..Shift+9 → ) ! @ # $ % ^ & * ()", () => {
  it("g opens the DAG popup as a keybind-only string id", () => {
    expect(dispatchGlobalKey("g", NO_KEY)).toEqual({ kind: "openPopup", cardId: "dag" });
  });

  it("t opens the all-tasks popup as a keybind-only string id", () => {
    expect(dispatchGlobalKey("t", NO_KEY)).toEqual({ kind: "openPopup", cardId: "allTasks" });
  });

  it("l/L no longer opens Commits", () => {
    expect(dispatchGlobalKey("l", NO_KEY)).toEqual({ kind: "noop" });
    expect(dispatchGlobalKey("L", NO_KEY)).toEqual({ kind: "noop" });
  });

  it.each([
    [")", 0],
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
    expect(dispatchGlobalKey("", F1_KEY)).toEqual({ kind: "noop" });
  });
  it("c clearFooter (without ctrl)", () => {
    expect(dispatchGlobalKey("c", NO_KEY)).toEqual({ kind: "clearFooter" });
  });
  it("w is a noop — workstream picker dropped per review_dead_code_workstream_picker", () => {
    // The lie-with-toast `w` binding (was emitting a v0.next toast
    // and nothing else) was dropped: multi-ws Tab/Shift-Tab covers
    // the use case. If a real picker ever ships, restore the
    // binding then.
    expect(dispatchGlobalKey("w", NO_KEY)).toEqual({ kind: "noop" });
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

describe("dispatchGlobalKeyFromInk", () => {
  it("normalises ink key flags before global dispatch", () => {
    expect(dispatchGlobalKeyFromInk("", { f5: true })).toEqual({ kind: "refreshNow" });
    expect(dispatchGlobalKeyFromInk("", { tab: true, shift: true })).toEqual({ kind: "prevTab" });
  });
});

describe("dispatchPopupKeyFromInk", () => {
  it("normalises ink key flags before popup dispatch", () => {
    expect(dispatchPopupKeyFromInk("", { escape: true })).toEqual({ kind: "close" });
    expect(dispatchPopupKeyFromInk("", { pageDown: true })).toEqual({
      kind: "pageDown",
      half: false,
    });
    expect(dispatchPopupKeyFromInk("d", { ctrl: true })).toEqual({ kind: "pageDown", half: true });
  });
});

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
    expect(dispatchPopupKey("s", NO_KEY)).toEqual({ kind: "verb", key: "s" });
    expect(dispatchPopupKey("x", NO_KEY)).toEqual({ kind: "verb", key: "x" });
    expect(dispatchPopupKey("t", NO_KEY)).toEqual({ kind: "verb", key: "t" });
  });
  it("DAG/all-tasks status toggle letters still bubble up for popup-local handling", () => {
    for (const input of ["o", "i", "c", "r", "d"] as const) {
      expect(dispatchPopupKey(input, NO_KEY)).toEqual({ kind: "verb", key: input });
    }
  });
  it("digits and punctuation are noops in popup convention", () => {
    expect(dispatchPopupKey("1", NO_KEY)).toEqual({ kind: "noop" });
    expect(dispatchPopupKey("!", NO_KEY)).toEqual({ kind: "noop" });
    expect(dispatchPopupKey("+", NO_KEY)).toEqual({ kind: "noop" });
  });
});

describe("shouldSwallowGlobalKey: per-mode swallow rules", () => {
  // Per review_tui_help_overlay_swallows_only_some_keys: this
  // helper centralises the swallow lists that used to live
  // duplicated in <App>'s helpOpen branch and popup branch. Tests
  // codify the contract — a regression that adds a new global key
  // (e.g. a global "v" verb) without thinking about modal modes
  // will fail one of these cases.

  it("dashboard mode never swallows", () => {
    for (const c of ["q", "Q", "j", "k", "0", "!", "g", "t", "c", "+", "-", "=", "r", "?"]) {
      expect(shouldSwallowGlobalKey(c, NO_KEY, "dashboard")).toBe(false);
    }
    expect(shouldSwallowGlobalKey("", { escape: true }, "dashboard")).toBe(false);
    expect(shouldSwallowGlobalKey("", { tab: true }, "dashboard")).toBe(false);
  });

  it("help mode swallows everything except Ctrl-C", () => {
    // Help.tsx's local useInput owns scroll; App's branch swallows
    // every other key so the global keymap stays inert. The caller
    // pre-handles `Esc`/`q`/`Q`/`?` for close — this helper still
    // says "swallow" for them so the global dispatcher is skipped.
    for (const c of ["q", "Q", "j", "k", "0", "!", "g", "t", "c", "+", "-", "=", "r", "?"]) {
      expect(shouldSwallowGlobalKey(c, NO_KEY, "help")).toBe(true);
    }
    expect(shouldSwallowGlobalKey("", { escape: true }, "help")).toBe(true);
    // Ctrl-C bypass: universal exit must reach the caller's
    // explicit Ctrl-C handler regardless of mode.
    expect(shouldSwallowGlobalKey("c", { ctrl: true }, "help")).toBe(false);
  });

  it("popup mode swallows close keys, card toggles, popup openers, and `c`", () => {
    // Close keys: popup owns close.
    expect(shouldSwallowGlobalKey("", { escape: true }, "popup")).toBe(true);
    expect(shouldSwallowGlobalKey("q", NO_KEY, "popup")).toBe(true);
    expect(shouldSwallowGlobalKey("Q", NO_KEY, "popup")).toBe(true);
    // Card toggles 0-9.
    for (const c of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(shouldSwallowGlobalKey(c, NO_KEY, "popup")).toBe(true);
    }
    // Popup-opener glyphs.
    for (const c of ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"]) {
      expect(shouldSwallowGlobalKey(c, NO_KEY, "popup")).toBe(true);
    }
    // Keybind-only popup openers + footer-clear.
    expect(shouldSwallowGlobalKey("g", NO_KEY, "popup")).toBe(true);
    expect(shouldSwallowGlobalKey("t", NO_KEY, "popup")).toBe(true);
    expect(shouldSwallowGlobalKey("c", NO_KEY, "popup")).toBe(true);
  });

  it("popup mode lets tick/refresh/help/tab/Ctrl-C bubble to the global dispatcher", () => {
    // These remain global even inside a popup so the user can
    // still tweak refresh rate, force a poke, and toggle help.
    for (const c of ["+", "-", "=", "r", "?"]) {
      expect(shouldSwallowGlobalKey(c, NO_KEY, "popup")).toBe(false);
    }
    expect(shouldSwallowGlobalKey("", { tab: true }, "popup")).toBe(false);
    expect(shouldSwallowGlobalKey("", { tab: true, shift: true }, "popup")).toBe(false);
    expect(shouldSwallowGlobalKey("", { f5: true }, "popup")).toBe(false);
    // Ctrl-C universal escape.
    expect(shouldSwallowGlobalKey("c", { ctrl: true }, "popup")).toBe(false);
  });

  it("popup-filter mode swallows everything except Ctrl-C", () => {
    // The filter prompt is the active text input; tick/refresh/
    // help/tab/etc. would compete with the user's typing.
    for (const c of ["q", "Q", "j", "k", "0", "!", "g", "t", "c", "+", "-", "=", "r", "?"]) {
      expect(shouldSwallowGlobalKey(c, NO_KEY, "popup-filter")).toBe(true);
    }
    expect(shouldSwallowGlobalKey("", { escape: true }, "popup-filter")).toBe(true);
    expect(shouldSwallowGlobalKey("", { tab: true }, "popup-filter")).toBe(true);
    // Ctrl-C still wins.
    expect(shouldSwallowGlobalKey("c", { ctrl: true }, "popup-filter")).toBe(false);
  });

  it("shouldSwallowGlobalKeyFromInk normalises ink key flags", () => {
    expect(shouldSwallowGlobalKeyFromInk("", { escape: true }, "popup")).toBe(true);
    expect(shouldSwallowGlobalKeyFromInk("", { tab: true }, "popup")).toBe(false);
    expect(shouldSwallowGlobalKeyFromInk("c", { ctrl: true }, "help")).toBe(false);
  });

  it("InputMode is exhaustive (compile-time check via switch)", () => {
    // If a future change adds a new InputMode, the switch in
    // shouldSwallowGlobalKey will fail noUncheckedIndexedAccess /
    // exhaustiveness; this test documents the four-mode contract.
    const modes: InputMode[] = ["dashboard", "help", "popup", "popup-filter"];
    expect(modes).toHaveLength(4);
  });
});

describe("DAG popup status-toggle key classifier", () => {
  it.each([
    ["o", "OPEN"],
    ["i", "IN_PROGRESS"],
    ["c", "CLOSED"],
    ["r", "REJECTED"],
    ["d", "DEFERRED"],
  ] as const)("%s toggles %s", (input, status) => {
    expect(statusForToggleKey(input, NO_KEY)).toBe(status);
  });

  it("ignores modified keys so Ctrl-D remains page-down", () => {
    expect(statusForToggleKey("d", { ctrl: true })).toBeUndefined();
    expect(dispatchPopupKey("d", { ctrl: true })).toEqual({ kind: "pageDown", half: true });
  });

  it("returns undefined for non-toggle letters", () => {
    expect(statusForToggleKey("x", NO_KEY)).toBeUndefined();
  });
});
