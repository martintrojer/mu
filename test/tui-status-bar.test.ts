// status-bar.tsx — context-sensitive single-line status bar.
//
// Per feat_status_bar (workstream `tui-impl`): three zones (last
// yank | key hints | tick rate), with the LEFT zone truncated first
// when the terminal is too narrow.
//
// We can't easily snapshot ink output without ink-testing-library,
// so these are static-source / call-shape tests that catch the
// invariants the design pinned: the component is exported, it
// accepts every documented mode, the LEFT zone renders the yank
// command + copied tag, and the RIGHT zone renders the tick rate.

import { describe, expect, it } from "vitest";
import type { FooterState } from "../src/cli/tui/app.js";
import { StatusBar, type StatusMode } from "../src/cli/tui/status-bar.js";

function renderToString(node: unknown): string {
  // ink elements are React elements; recursively walk their props
  // and accumulate every string child. Sufficient for snapshot-style
  // text assertions without booting ink.
  function walk(n: unknown): string {
    if (n === null || n === undefined) return "";
    if (typeof n === "string") return n;
    if (typeof n === "number") return String(n);
    if (Array.isArray(n)) return n.map(walk).join("");
    if (typeof n === "object" && n !== null && "props" in n) {
      const props = (n as { props: { children?: unknown } }).props;
      return walk(props.children);
    }
    return "";
  }
  return walk(node);
}

describe("StatusBar", () => {
  it("is exported as a function", () => {
    expect(typeof StatusBar).toBe("function");
  });

  it.each<StatusMode>(["dashboard", "popup", "popup-filter", "help"])(
    "renders without crashing in %s mode",
    (mode) => {
      const node = StatusBar({ mode, tickMs: 1000, footer: null, cols: 80 });
      expect(node).toBeTruthy();
    },
  );

  it("renders the tick rate in the right zone (always visible)", () => {
    const node = StatusBar({ mode: "dashboard", tickMs: 2500, footer: null, cols: 80 });
    expect(renderToString(node)).toContain("2.50s");
  });

  it("renders the last yank in the left zone with the [copied] suffix", () => {
    const footer: FooterState = { command: "mu task claim foo -w demo", copied: true };
    const node = StatusBar({ mode: "dashboard", tickMs: 1000, footer, cols: 200 });
    const text = renderToString(node);
    expect(text).toContain("mu task claim foo -w demo");
    expect(text).toContain("[copied]");
  });

  it("uses [no clipboard] when the yank could not be copied", () => {
    const footer: FooterState = { command: "mu task release foo", copied: false };
    const node = StatusBar({ mode: "dashboard", tickMs: 1000, footer, cols: 200 });
    expect(renderToString(node)).toContain("[no clipboard]");
  });

  it("drops the LEFT zone when the terminal is too narrow", () => {
    // 30 cols can't hold tick (~6) + hints (~70) + a long yank line.
    const footer: FooterState = {
      command: "mu task claim some_quite_long_id -w demo",
      copied: true,
    };
    const node = StatusBar({ mode: "dashboard", tickMs: 1000, footer, cols: 30 });
    const text = renderToString(node);
    // LEFT zone is dropped (or near-dropped); the long yank id must
    // not appear verbatim in narrow mode.
    expect(text).not.toContain("some_quite_long_id");
    // But the tick rate still renders.
    expect(text).toContain("1.00s");
  });

  it("renders dashboard hints when mode=dashboard", () => {
    const node = StatusBar({ mode: "dashboard", tickMs: 1000, footer: null, cols: 200 });
    const text = renderToString(node);
    expect(text).toContain("toggle");
    expect(text).toContain("popup");
    expect(text).toContain("help");
    expect(text).toContain("quit");
    // Dashboard hint reflects 0-9 cards. Popup-opener label is plain
    // English 'Shift 0-9' (no '+', no glyph cluster) per user
    // preference — layout-independent and self-explanatory.
    expect(text).toContain("g");
    expect(text).toContain("DAG");
    expect(text).toContain("0-9");
    expect(text).toContain("Shift 0-9");
    expect(text).not.toContain("l commits");
    // F1 alias dropped per nit_tui_remove_f1_help_toggle.
    expect(text).not.toContain("F1");
    expect(text).not.toContain("!@#$");
  });

  it("popup list-mode hint cluster surfaces `Shift 0-9 switch popup`", () => {
    // Per nit_tui_status_bar_popup_shift_range: the popup-mode hint
    // must advertise the cross-popup hop affordance (otherwise users
    // can only discover it via the help overlay).
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Tasks",
      popupMode: "list",
    });
    const text = renderToString(node);
    expect(text).toContain("Shift 0-9");
    expect(text).toContain("switch popup");
  });

  it("popup drill-mode hint cluster does NOT advertise `Shift 0-9` (transient view)", () => {
    // Drill is a transient view that returns to the popup-list on Esc;
    // switching popups from drill mode is unusual. Keep it terse.
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Tasks",
      popupMode: "drill",
    });
    expect(renderToString(node)).not.toContain("Shift 0-9");
  });

  it("popup-filter hint cluster does NOT advertise `Shift 0-9` (digits are filter input mid-edit)", () => {
    const node = StatusBar({
      mode: "popup-filter",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Tasks",
    });
    expect(renderToString(node)).not.toContain("Shift 0-9");
  });

  it("renders popup hints with the popup name when mode=popup (default = list)", () => {
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Tasks",
    });
    const text = renderToString(node);
    expect(text).toContain("Tasks");
    expect(text).toContain("nav");
    expect(text).toContain("yank");
    expect(text).toContain("close");
  });

  it("popup list-mode hint cluster advertises `Enter drill`", () => {
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Agents",
      popupMode: "list",
    });
    expect(renderToString(node)).toContain("Enter");
    expect(renderToString(node)).toContain("drill");
  });

  it("popup drill-mode hint cluster advertises scroll + back instead of nav + close", () => {
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Tasks",
      popupMode: "drill",
    });
    const text = renderToString(node);
    expect(text).toContain("drill");
    expect(text).toContain("scroll");
    expect(text).toContain("back");
  });

  it("popup-list-mode hint cluster advertises `/ filter`", () => {
    // Per feat_popup_search_filter spec: the popup-mode hint must
    // surface `/` so users discover the keybinding without opening
    // the help overlay.
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Agents",
      popupMode: "list",
    });
    const text = renderToString(node);
    expect(text).toContain("/");
    expect(text).toContain("filter");
  });

  it("popup-filter mode renders the edit-time hint cluster", () => {
    const node = StatusBar({
      mode: "popup-filter",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Tasks",
    });
    const text = renderToString(node);
    // Per spec: `Esc cancel · Enter commit · Bksp edit`.
    expect(text).toContain("Esc");
    expect(text).toContain("cancel");
    expect(text).toContain("Enter");
    expect(text).toContain("commit");
    expect(text).toContain("Bksp");
    expect(text).toContain("edit");
    // The popup name stays in the cluster so the user sees which
    // popup they're filtering inside.
    expect(text).toContain("Tasks");
    expect(text).toContain("filter");
  });

  it("popup-filter mode renders without a popupName too (defensive)", () => {
    const node = StatusBar({
      mode: "popup-filter",
      tickMs: 1000,
      footer: null,
      cols: 200,
    });
    const text = renderToString(node);
    expect(text).toContain("filter");
    expect(text).toContain("cancel");
  });

  it("renders the dismiss hint when mode=help", () => {
    const node = StatusBar({ mode: "help", tickMs: 1000, footer: null, cols: 200 });
    const text = renderToString(node);
    expect(text).toContain("Esc");
    expect(text).toContain("close help");
  });
});
