// Tests for src/cli/tui/use-popup-filter.tsx — the shared '/'
// substring filter primitive every list popup consumes.
//
// Per feat_popup_search_filter (workstream `tui-impl`): the reducer
// is the source of truth, so we drive it directly without React.
// classifyFilterKey is similarly pure. The hook itself is a thin
// wrapper around useReducer; covered structurally by the popup
// integration tests.

import { describe, expect, it } from "vitest";
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
    expect(classifyFilterKey(editing, "", { backspace: true } as { backspace: true })).toEqual({
      kind: "backspace",
    });
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
    expect(classifyFilterKey(editing, "", { f1: true })).toEqual({
      kind: "appendChar",
      char: "",
    });
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
