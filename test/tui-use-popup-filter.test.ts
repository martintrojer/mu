// Tests for src/cli/tui/use-popup-filter.tsx — the shared '/'
// substring filter primitive every list popup consumes.
//
// Per feat_popup_search_filter (workstream `tui-impl`): the reducer
// is the source of truth, so we drive it directly without React.
// classifyFilterKey is similarly pure. The hook itself is a thin
// wrapper around useReducer; covered structurally by the popup
// integration tests.

import { Box, render } from "ink";
import { createElement, useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { KeyFlags } from "../src/cli/tui/keys.js";
import {
  type FilterAction,
  FilterPrompt,
  type FilterState,
  INITIAL_FILTER_STATE,
  applyFilter,
  classifyFilterKey,
  popupFilterReducer,
  usePopupFilter,
} from "../src/cli/tui/use-popup-filter.js";
import { CaptureStream, createInkCaptureStream, createInkInputStream } from "./_ink-render.js";

describe("popupFilterReducer", () => {
  it("starts in the documented initial state (empty query, not editing)", () => {
    expect(INITIAL_FILTER_STATE).toEqual({ query: "", editing: false });
  });

  it("startEdit flips editing on without touching the query", () => {
    const out = popupFilterReducer({ query: "abc", editing: false }, { kind: "startEdit" });
    expect(out).toEqual({ query: "abc", editing: true });
  });

  it("appendChar appends one printable character", () => {
    const a: FilterState = { query: "do", editing: true };
    const b = popupFilterReducer(a, { kind: "appendChar", char: "g" });
    expect(b).toEqual({ query: "dog", editing: true });
  });

  it("appendChar drops non-printable / empty / multi-char input", () => {
    const a: FilterState = { query: "x", editing: true };
    const empty = popupFilterReducer(a, { kind: "appendChar", char: "" });
    const tab = popupFilterReducer(a, { kind: "appendChar", char: "\t" });
    const multi = popupFilterReducer(a, { kind: "appendChar", char: "ab" });
    const ctrl = popupFilterReducer(a, { kind: "appendChar", char: "\x01" });
    expect(empty).toEqual(a);
    expect(tab).toEqual(a);
    expect(multi).toEqual(a);
    expect(ctrl).toEqual(a);
  });

  it("backspace pops one char", () => {
    const a: FilterState = { query: "dog", editing: true };
    const b = popupFilterReducer(a, { kind: "backspace" });
    expect(b).toEqual({ query: "do", editing: true });
  });

  it("backspace on empty query is a no-op", () => {
    const a: FilterState = { query: "", editing: true };
    const b = popupFilterReducer(a, { kind: "backspace" });
    expect(b).toEqual(a);
  });

  it("commit keeps the query, exits editing", () => {
    const a: FilterState = { query: "dog", editing: true };
    const b = popupFilterReducer(a, { kind: "commit" });
    expect(b).toEqual({ query: "dog", editing: false });
  });

  it("cancel clears query AND exits editing (full reset)", () => {
    const a: FilterState = { query: "dog", editing: true };
    const b = popupFilterReducer(a, { kind: "cancel" });
    expect(b).toEqual(INITIAL_FILTER_STATE);
  });

  it("reset clears query AND exits editing", () => {
    const a: FilterState = { query: "anything", editing: true };
    const b = popupFilterReducer(a, { kind: "reset" });
    expect(b).toEqual(INITIAL_FILTER_STATE);
  });

  it("typical edit→commit→re-edit→backspace flow lands on the expected state", () => {
    let s = INITIAL_FILTER_STATE;
    const seq: FilterAction[] = [
      { kind: "startEdit" },
      { kind: "appendChar", char: "d" },
      { kind: "appendChar", char: "o" },
      { kind: "appendChar", char: "g" },
      { kind: "commit" },
      // committed: stays applied, exits editing.
    ];
    for (const a of seq) s = popupFilterReducer(s, a);
    expect(s).toEqual({ query: "dog", editing: false });
    // Re-enter edit mode (pre-fill); refine via backspace + append.
    s = popupFilterReducer(s, { kind: "startEdit" });
    expect(s).toEqual({ query: "dog", editing: true });
    s = popupFilterReducer(s, { kind: "backspace" });
    s = popupFilterReducer(s, { kind: "appendChar", char: "e" });
    expect(s).toEqual({ query: "doe", editing: true });
  });
});

describe("classifyFilterKey", () => {
  const editing: FilterState = { query: "do", editing: true };
  const idle: FilterState = { query: "", editing: false };
  const keyDefaults: Required<KeyFlags> = {
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
  const backspaceKey = { ...keyDefaults, backspace: true };

  it("returns null when not editing (passthrough)", () => {
    expect(classifyFilterKey(idle, "x", {})).toBeNull();
    expect(classifyFilterKey(idle, "/", {})).toBeNull();
    expect(classifyFilterKey(idle, "j", {})).toBeNull();
  });

  it("Esc → cancel", () => {
    expect(classifyFilterKey(editing, "", { escape: true })).toEqual({ kind: "cancel" });
  });

  it("Enter → commit", () => {
    expect(classifyFilterKey(editing, "", { return: true })).toEqual({ kind: "commit" });
  });

  it("backspace via key.backspace flag", () => {
    expect(classifyFilterKey(editing, "", backspaceKey)).toEqual({ kind: "backspace" });
  });

  it("backspace via DEL byte (0x7f)", () => {
    expect(classifyFilterKey(editing, "\x7f", {})).toEqual({ kind: "backspace" });
  });

  it("backspace via BS byte (\\b)", () => {
    expect(classifyFilterKey(editing, "\b", {})).toEqual({ kind: "backspace" });
  });

  it("printable single char → appendChar", () => {
    expect(classifyFilterKey(editing, "g", {})).toEqual({ kind: "appendChar", char: "g" });
    expect(classifyFilterKey(editing, " ", {})).toEqual({ kind: "appendChar", char: " " });
    expect(classifyFilterKey(editing, "/", {})).toEqual({ kind: "appendChar", char: "/" });
  });

  it("nav keys (arrows / pageDown / pageUp / tab / Fn) consume-and-ignore", () => {
    // Returns an appendChar with empty char so the reducer drops it
    // → state unchanged → caller still sees "consumed" and the
    // popup's own j/k navigation is suppressed mid-edit.
    expect(classifyFilterKey(editing, "", { downArrow: true })).toEqual({
      kind: "appendChar",
      char: "",
    });
    expect(classifyFilterKey(editing, "", { upArrow: true })).toEqual({
      kind: "appendChar",
      char: "",
    });
    expect(classifyFilterKey(editing, "", { pageDown: true })).toEqual({
      kind: "appendChar",
      char: "",
    });
    expect(classifyFilterKey(editing, "", { tab: true })).toEqual({
      kind: "appendChar",
      char: "",
    });
    // F1 was dropped from the explicit consume list (per
    // nit_tui_remove_f1_help_toggle) since it's not a control key
    // anywhere in the TUI anymore. ink reports it as input="" with
    // no flag we recognise → falls through to the final
    // "unknown — consume-and-ignore" branch (still appendChar "").
  });

  it("Ctrl-* combos consume-and-ignore (so Ctrl-D doesn't page-scroll mid-edit)", () => {
    expect(classifyFilterKey(editing, "d", { ctrl: true })).toEqual({
      kind: "appendChar",
      char: "",
    });
  });
});

describe("applyFilter", () => {
  type Item = { id: string; label: string };
  const items: Item[] = [
    { id: "alpha", label: "Alpha goes first" },
    { id: "beta", label: "Beta is second" },
    { id: "gamma", label: "Doggone" },
    { id: "delta", label: "delta DOG" },
  ];
  const blob = (i: Item) => `${i.id} ${i.label}`;

  it("empty query returns a copy of the source array (not the same reference)", () => {
    const out = applyFilter(items, "", blob);
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
  });

  it("filters case-insensitively on the blob", () => {
    const out = applyFilter(items, "dog", blob);
    expect(out.map((i) => i.id)).toEqual(["gamma", "delta"]);
  });

  it("uppercase query matches lowercase blob and vice versa", () => {
    expect(applyFilter(items, "ALPHA", blob).map((i) => i.id)).toEqual(["alpha"]);
    expect(applyFilter(items, "beta", blob).map((i) => i.id)).toEqual(["beta"]);
  });

  it("query with no matches returns an empty array (not null)", () => {
    expect(applyFilter(items, "xyzzy", blob)).toEqual([]);
  });

  it("query that's just whitespace matches blobs containing spaces", () => {
    // Both rows have spaces; this is an explicit choice — we don't
    // strip whitespace from the query because the user is typing it.
    expect(applyFilter(items, " ", blob).length).toBeGreaterThan(0);
  });
});

describe("FilterPrompt rendering", () => {
  function renderToString(node: unknown): string {
    function walk(n: unknown): string {
      if (n === null || n === undefined) return "";
      if (typeof n === "string") return n;
      if (typeof n === "number") return String(n);
      if (Array.isArray(n)) return n.map(walk).join("");
      if (typeof n === "object" && n !== null && "props" in n) {
        return walk((n as { props: { children?: unknown } }).props.children);
      }
      return "";
    }
    return walk(node);
  }

  function fakeFilter(query: string, editing: boolean) {
    return {
      query,
      editing,
      onKey: () => "passthrough" as const,
      startEdit: () => {},
      reset: () => {},
    };
  }

  it("renders nothing while idle (no query AND not editing)", () => {
    expect(FilterPrompt({ state: fakeFilter("", false) })).toBeNull();
  });

  it("renders /<query>_ while editing (literal underscore caret)", () => {
    const node = FilterPrompt({ state: fakeFilter("dog", true) });
    const text = renderToString(node);
    expect(text).toContain("/");
    expect(text).toContain("dog");
    expect(text).toContain("_");
  });

  it("renders /_ even with an empty query while editing (just the caret)", () => {
    const node = FilterPrompt({ state: fakeFilter("", true) });
    const text = renderToString(node);
    expect(text).toContain("/");
    expect(text).toContain("_");
  });

  it("renders [filter] <query> after Enter (committed; not editing)", () => {
    const node = FilterPrompt({ state: fakeFilter("dog", false) });
    const text = renderToString(node);
    expect(text).toContain("[filter]");
    expect(text).toContain("dog");
    expect(text).not.toContain("_");
  });
});

describe("usePopupFilter enabled prop bubbling", () => {
  afterEach(() => {
    CaptureStream.cleanup();
  });

  // Tiny test harness: render a component that uses the hook with the
  // given options and immediately enters edit mode via startEdit().
  // We capture the bubbled editing values via the onEditingChange
  // callback. Behaviour seam (per test/README.md) instead of
  // source-grep — we want to verify what the hook DOES, not how it's
  // written.
  function renderHookHarness(opts: {
    enabled?: boolean;
    onEditingChange: (editing: boolean) => void;
  }) {
    function Harness(): JSX.Element {
      const flt = usePopupFilter({
        enabled: opts.enabled,
        onEditingChange: opts.onEditingChange,
      });
      // Auto-start the edit on first render so state.editing flips
      // to true. The hook's bubble-up effect should then either
      // bubble true (enabled !== false) or stay at false
      // (enabled === false).
      // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot mount effect
      useEffect(() => {
        flt.startEdit();
      }, []);
      return createElement(Box, null);
    }
    const stdin = createInkInputStream();
    const stdout = createInkCaptureStream({ columns: 80, rows: 24 });
    const stderr = createInkCaptureStream({ columns: 80, rows: 24 });
    const instance = render(createElement(Harness), {
      stdin,
      stdout,
      stderr,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    return instance;
  }

  it("enabled=true (default) bubbles state.editing through (false → true on startEdit)", async () => {
    const calls: boolean[] = [];
    const inst = renderHookHarness({
      onEditingChange: (e) => {
        calls.push(e);
      },
    });
    // Let the mount effect + state-flip flush.
    await new Promise((r) => setTimeout(r, 20));
    inst.unmount();
    // First bubble is the initial render (false). After startEdit
    // fires in useEffect the state-update triggers another render
    // and bubbles true.
    expect(calls[0]).toBe(false);
    expect(calls).toContain(true);
  });

  it("enabled=false bubbles false even after startEdit flips state.editing to true", async () => {
    const calls: boolean[] = [];
    const inst = renderHookHarness({
      enabled: false,
      onEditingChange: (e) => {
        calls.push(e);
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    inst.unmount();
    // Every bubble must be false — the hook clamps under enabled=false
    // regardless of what state.editing internally became.
    expect(calls.length).toBeGreaterThan(0);
    for (const v of calls) expect(v).toBe(false);
  });
});

describe("usePopupFilter (hook export shape)", () => {
  // Hook can't run without a renderer, but we can assert it's a
  // function (callable) and that the reducer/applyFilter/FilterPrompt
  // it depends on are exported.
  it("exports the hook + reducer + applyFilter + FilterPrompt", () => {
    expect(typeof usePopupFilter).toBe("function");
    expect(typeof popupFilterReducer).toBe("function");
    expect(typeof applyFilter).toBe("function");
    expect(typeof FilterPrompt).toBe("function");
    expect(typeof classifyFilterKey).toBe("function");
  });
});

// Per review_dedup_filter_editing_effect: the bubble-up was
// previously hand-rolled in eight popups. Now baked into the hook
// itself via the optional `onEditingChange` callback. These
// structural tests pin the contract — if a future refactor strips
// the option or breaks the wiring in any of the eight popups, this
// suite catches it before the StatusBar mode flip silently dies.
describe("usePopupFilter onEditingChange wiring (structural)", () => {
  it("every list popup wires onFilterEditingChange via the hook option (no hand-rolled useEffect)", async () => {
    const { readFileSync } = await import("node:fs");
    // The nine popups whose bubble-up was hand-rolled before this
    // refactor. Per review_tui_workspaces_two_filter_instances,
    // workspaces.tsx is now ALSO in the canonical list — its two
    // filter instances each pass `enabled` so the hook itself does
    // the right thing. (Each call site uses the multi-line form
    // because the option object includes `enabled: ...`.)
    const popups = [
      "agents",
      "blocked",
      "commits",
      "doctor",
      "inprogress",
      "log",
      "ready",
      "recent",
      "tracks",
    ];
    for (const name of popups) {
      const src = readFileSync(`./src/cli/tui/popups/${name}.tsx`, "utf-8");
      // Must use the option form (one of usePopupFilter's two valid
      // call shapes). The other valid shape is bare `usePopupFilter()`
      // — used by workspaces.tsx, which is excluded from this list.
      expect(src, `${name}.tsx should pass onEditingChange to usePopupFilter`).toContain(
        "usePopupFilter({ onEditingChange: onFilterEditingChange })",
      );
      // Must NOT hand-roll the bubble-up useEffect. Catches a future
      // refactor that adds back the duplicated three-line block.
      expect(
        src,
        `${name}.tsx must not hand-roll onFilterEditingChange?.(flt.editing)`,
      ).not.toContain("onFilterEditingChange?.(flt.editing)");
    }
  });

  it("workspaces.tsx uses two enabled-gated filter instances (no hand-rolled bubble)", async () => {
    // Per review_tui_workspaces_two_filter_instances:
    // workspaces has TWO filter instances (list + commits drill).
    // Each one passes its own `enabled` flag plus the shared
    // onFilterEditingChange callback; the hook decides which one
    // bubbles `true`. No more activeFilterEditing useEffect.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/workspaces.tsx", "utf-8");
    expect(src).toContain('enabled: !inShow && mode !== "drill",');
    expect(src).toContain('enabled: !inShow && mode === "drill",');
    expect(src).toContain("onEditingChange: onFilterEditingChange,");
    // The previous hand-roll is gone.
    expect(src).not.toContain("onFilterEditingChange?.(activeFilterEditing)");
    expect(src).not.toContain("const activeFilterEditing");
  });
});
