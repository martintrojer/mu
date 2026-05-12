// Snap-to-null on workstream change for the dashboard poll loop
// (bug_tui_tab_switch_stale_render, workstream `tui-impl`).
//
// Without the fix, Tab on the multi-ws TUI flips the `workstream`
// prop but useDashboardSnapshot still has the OLD ws's snapshot in
// state until its newly-scheduled effect's first tick resolves —
// React renders one frame against the stale snapshot, so the cards
// show OLD-ws data UNDER the NEW-ws tab strip.
//
// Fix lives in src/cli/tui/state.ts as a pure helper plus a
// "derive-state-from-props" branch in useDashboardSnapshot. We test
// the helper directly (it's a one-liner today; the seam exists so
// future work — case-insensitive matching, alias resolution — has
// somewhere to live and so this regression has a unit test) plus a
// static-source assertion that the hook actually wires it through.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldDiscardForWorkstream } from "../src/cli/tui/state.js";

describe("shouldDiscardForWorkstream — pure helper", () => {
  it("returns false when the workstream is unchanged (no discard)", () => {
    expect(shouldDiscardForWorkstream("alpha", "alpha")).toBe(false);
  });

  it("returns true when the workstream changes (must discard)", () => {
    expect(shouldDiscardForWorkstream("alpha", "beta")).toBe(true);
  });

  it("returns true when transitioning from empty to a name", () => {
    // Defensive: the initial render's lastWsRef is the prop itself,
    // so this branch isn't actually exercised by the hook today.
    // The helper still returns the obvious answer.
    expect(shouldDiscardForWorkstream("", "alpha")).toBe(true);
  });

  it("returns true when transitioning from a name to empty", () => {
    expect(shouldDiscardForWorkstream("alpha", "")).toBe(true);
  });

  it("is case-sensitive (workstream names are exact match today)", () => {
    expect(shouldDiscardForWorkstream("Alpha", "alpha")).toBe(true);
  });
});

describe("useDashboardSnapshot — wires the snap-to-null branch (static)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, "..", "src", "cli", "tui", "state.ts"), "utf8");

  it("imports useRef alongside useEffect / useState", () => {
    expect(src).toMatch(/from\s+"react"/);
    expect(src).toMatch(/\buseRef\b/);
  });

  it("declares a lastWsRef and compares it during render", () => {
    expect(src).toMatch(/lastWsRef\s*=\s*useRef\s*\(\s*workstream\s*\)/);
    expect(src).toMatch(
      /shouldDiscardForWorkstream\s*\(\s*lastWsRef\.current\s*,\s*workstream\s*\)/,
    );
  });

  it("snaps the cached snapshot to null when the workstream changes", () => {
    // setData({ data: null, error: null }) inside the discard branch
    // is the actual cure for the stale-frame; assert it's wired.
    expect(src).toMatch(/setData\s*\(\s*\{\s*data:\s*null/);
  });
});
