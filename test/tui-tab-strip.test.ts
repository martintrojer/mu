// tab-strip.tsx — multi-workstream tab switcher rendered above the
// dashboard.
//
// Per feat_tui_multi_workstream (workstream `tui-impl`): when the
// TUI is launched with N≥2 workstreams, a one-row strip appears
// above the cards listing each ws with the active one highlighted.
// Tab / Shift-Tab cycles. With N=1 (single-ws TUI, the v0 default)
// the strip renders NOTHING so the byte-for-byte single-ws frame
// is preserved.
//
// Same testing strategy as tui-status-bar.test.ts: walk the JSX
// tree manually rather than booting ink (ink-testing-library is
// network-blocked in this env).

import { describe, expect, it } from "vitest";
import { TabStrip } from "../src/cli/tui/tab-strip.js";

function renderToString(node: unknown): string {
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

describe("TabStrip", () => {
  it("is exported as a function", () => {
    expect(typeof TabStrip).toBe("function");
  });

  it("renders nothing when only one workstream is loaded (N=1 = single-ws TUI)", () => {
    // The single-ws case must render null so the frame is identical
    // to the pre-multi-ws build. Any visual change there would
    // regress every snapshot / acceptance assertion.
    const node = TabStrip({ workstreams: ["alpha"], active: 0, terminalColumns: 200 });
    expect(node).toBeNull();
  });

  it("renders nothing for an empty workstream list (defensive)", () => {
    const node = TabStrip({ workstreams: [], active: 0, terminalColumns: 200 });
    expect(node).toBeNull();
  });

  it("renders every workstream name when N>=2 and they fit", () => {
    const node = TabStrip({
      workstreams: ["alpha", "beta", "gamma"],
      active: 0,
      terminalColumns: 200,
    });
    const text = renderToString(node);
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
    expect(text).toContain("gamma");
  });

  it("highlights the active tab with a leading marker", () => {
    // Active tab gets `▸ ` prepended (colour-blind-safe affordance,
    // independent of the bold/cyan styling). The non-active tabs
    // appear as bare names.
    const node = TabStrip({ workstreams: ["alpha", "beta"], active: 1, terminalColumns: 200 });
    const text = renderToString(node);
    // Active tab is beta:
    expect(text).toContain("▸ beta");
    // Non-active alpha must not have the marker:
    expect(text).not.toContain("▸ alpha");
  });

  it("renders ` · ` separators between adjacent tabs", () => {
    const node = TabStrip({ workstreams: ["a", "b", "c"], active: 1, terminalColumns: 200 });
    const text = renderToString(node);
    // Two separators expected for three tabs.
    const seps = text.split(" · ").length - 1;
    expect(seps).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the Tab / Shift-Tab affordance hint", () => {
    // Discoverability: without the hint, multi-ws users have to
    // open the help overlay to learn the binding. Mirror the
    // status-bar hint cluster's bias toward inline discoverability.
    const node = TabStrip({ workstreams: ["a", "b"], active: 0, terminalColumns: 200 });
    expect(renderToString(node)).toContain("Tab");
    expect(renderToString(node)).toContain("Shift-Tab");
  });

  it("renders a `workstreams:` label so the strip is self-documenting", () => {
    const node = TabStrip({ workstreams: ["a", "b"], active: 0, terminalColumns: 200 });
    expect(renderToString(node)).toContain("workstreams:");
  });

  it("clamps gracefully when active is out of range (defensive: caller's job, but we shouldn't crash)", () => {
    // Out-of-range active clamps to the last tab, so the active
    // marker is still rendered and the component does not throw.
    const node = TabStrip({ workstreams: ["alpha", "beta"], active: 99, terminalColumns: 200 });
    expect(node).not.toBeNull();
    const text = renderToString(node);
    expect(text).toContain("alpha");
    expect(text).toContain("▸ beta");
  });

  it("renders overflow counters and keeps the active marker visible", () => {
    const node = TabStrip({
      workstreams: [
        "ws-01",
        "ws-02",
        "ws-03",
        "ws-04",
        "ws-05",
        "ws-06",
        "ws-07",
        "ws-08",
        "ws-09",
        "ws-10",
        "ws-11",
        "ws-12",
      ],
      active: 5,
      terminalColumns: 80,
    });
    const text = renderToString(node);
    expect(text).toMatch(/‹\d+/);
    expect(text).toContain("▸ ws-06");
    expect(text).toMatch(/›\d+/);
    expect(text).not.toContain("ws-01 · ws-02 · ws-03");
  });

  it("is hook-free — callable from any context without an ink render tree (regression for bug_tab_strip_conditional_hook_crash)", () => {
    // Previously TabStrip called a `useStdout()`-backed helper that
    // sometimes ran and sometimes didn't depending on the
    // `terminalColumns` prop. On small panes (where the prop flipped
    // between defined and undefined across renders) ink crashed with
    // 'Rendered fewer hooks than expected'. The fix made the
    // component pure: terminalColumns is required, the parent <App>
    // reads useStdout once and threads it down. This test pins that
    // contract by calling TabStrip outside any React context — it
    // must not throw, and must not require a React render tree.
    expect(() =>
      TabStrip({ workstreams: ["alpha", "beta"], active: 0, terminalColumns: 200 }),
    ).not.toThrow();
    expect(() =>
      TabStrip({ workstreams: ["alpha", "beta"], active: 0, terminalColumns: 20 }),
    ).not.toThrow();
    expect(() => TabStrip({ workstreams: ["only"], active: 0, terminalColumns: 20 })).not.toThrow();
  });
});
