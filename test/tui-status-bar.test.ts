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

  it("renders the dashboard always-shown hint cluster", () => {
    const node = StatusBar({ mode: "dashboard", tickMs: 1000, footer: null, cols: 200 });
    const text = renderToString(node);
    expect(text).toContain("0-9");
    expect(text).toContain("cards");
    expect(text).toContain("Shift 0-9");
    expect(text).toContain("popups");
    expect(text).toContain("g");
    expect(text).toContain("DAG");
    expect(text).toContain("t");
    expect(text).toContain("tasks");
    expect(text).toContain("?");
    expect(text).toContain("help");
    expect(text).toContain("q");
    expect(text).toContain("quit");
    expect(text).not.toContain("l commits");
    expect(text).not.toContain("+/-");
    expect(text).not.toContain("refresh");
    // F1 alias dropped per nit_tui_remove_f1_help_toggle.
    expect(text).not.toContain("F1");
    expect(text).not.toContain("!@#$");
  });

  it("renders the dashboard Tab hint only for multi-workstream TUI", () => {
    const single = StatusBar({ mode: "dashboard", tickMs: 1000, footer: null, cols: 200 });
    const multi = StatusBar({
      mode: "dashboard",
      tickMs: 1000,
      footer: null,
      cols: 200,
      activeWorkstream: "demo",
    });
    expect(renderToString(single)).not.toContain("Tab ws");
    expect(renderToString(multi)).toContain("Tab");
    expect(renderToString(multi)).toContain("ws");
  });

  it("popup list-mode hint cluster advertises the canonical list affordances", () => {
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Tasks",
      popupMode: "list",
    });
    const text = renderToString(node);
    expect(text).toContain("Tasks");
    expect(text).toContain("j/k");
    expect(text).toContain("nav");
    expect(text).toContain("/");
    expect(text).toContain("filter");
    expect(text).toContain("Enter");
    expect(text).toContain("drill");
    expect(text).toContain("y");
    expect(text).toContain("yank");
    expect(text).toContain("Shift 0-9");
    expect(text).toContain("switch");
    expect(text).toContain("?");
    expect(text).toContain("help");
    expect(text).toContain("Esc");
    expect(text).toContain("back");
    expect(text).not.toContain("q");
    expect(text).not.toContain("quit");
  });

  it("popup drill-mode hint cluster advertises scroll/page/filter/yank/help/back", () => {
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "Tasks",
      popupMode: "drill",
    });
    const text = renderToString(node);
    expect(text).toContain("Tasks");
    expect(text).toContain("drill");
    expect(text).toContain("j/k");
    expect(text).toContain("scroll");
    expect(text).toContain("Ctrl-D/U");
    expect(text).toContain("page");
    expect(text).toContain("y");
    expect(text).toContain("yank");
    // `t tuicr` is per-drill (only git-show drills want it). It rides
    // each consumer's bottom-border hint via `bottomLabel`, NOT the
    // global popup-drill cluster, so generic drill modes (notes etc)
    // don't falsely advertise a no-op key.
    expect(text).not.toContain("tuicr");
    expect(text).toContain("?");
    expect(text).toContain("help");
    expect(text).toContain("Esc");
    expect(text).toContain("back");
    expect(text).not.toContain("Shift 0-9");
  });

  it("DAG popup has its own drill/status-filter hint cluster", () => {
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "DAG",
      popupMode: "list",
    });
    const text = renderToString(node);
    expect(text).toContain("DAG");
    expect(text).toContain("drill");
    expect(text).toContain("j/k");
    expect(text).toContain("scroll");
    expect(text).toContain("o/i/c/r/d");
    expect(text).toContain("filter");
    expect(text).toContain("y");
    expect(text).toContain("yank");
    expect(text).toContain("?");
    expect(text).toContain("help");
    expect(text).toContain("Esc");
    expect(text).toContain("back");
  });

  it("All tasks popup has its own filter/sort/search/drill hint cluster", () => {
    const node = StatusBar({
      mode: "popup",
      tickMs: 1000,
      footer: null,
      cols: 200,
      popupName: "All tasks",
      popupMode: "list",
    });
    const text = renderToString(node);
    expect(text).toContain("All tasks");
    expect(text).toContain("j/k");
    expect(text).toContain("nav");
    expect(text).toContain("o/i/c/r/d");
    expect(text).toContain("filter");
    expect(text).toContain("s");
    expect(text).toContain("sort");
    expect(text).toContain("/");
    expect(text).toContain("search");
    expect(text).toContain("Enter");
    expect(text).toContain("drill");
    expect(text).toContain("y");
    expect(text).toContain("yank");
    expect(text).toContain("Esc");
    expect(text).toContain("back");
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
    expect(text).toContain("Tasks");
    expect(text).toContain("filter");
    expect(text).toContain("type to match");
    expect(text).toContain("Enter");
    expect(text).toContain("commit");
    expect(text).toContain("Esc");
    expect(text).toContain("cancel");
    expect(text).not.toContain("Bksp");
    expect(text).not.toContain("n/N");
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
