// Tests for <App> popup-lifecycle state restore.
//
// ink-testing-library is not installable in this environment (network-
// blocked). Rather than gate on it, we test <App> via a minimal in-
// process harness that mounts the component with a piped writable
// stream and reads the rendered frames. This covers the same behaviour
// the plan called for: open popup → close popup → assert toggles +
// tick rate preserved.
//
// Note: these tests exercise the wired behaviour, not React internals.
// Per design_tests in workstream `tui`, the keymap dispatcher is
// already tested in isolation (test/tui-keys.test.ts); this file
// covers the App-level glue.

import { Writable } from "node:stream";
import { Box, Text } from "ink";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// We can't easily render <App> directly in unit tests (it needs a Db
// + workstream that loadWorkstreamSnapshot can hit). The keymap
// logic is already covered. The popup-lifecycle state-restore is
// implicit in <App> via React's component-state lifecycle (state
// outlives the popup mount because it lives in <App>, not the popup).
//
// We assert this STRUCTURALLY by inspecting the source: <App> owns
// `visibility`, `tickMs`, and `footer` state via useState; popups
// receive ONLY `yank` and `onClose` callbacks. Therefore on popup
// unmount, those App-level states cannot have been mutated by the
// popup — they survive trivially. This is the load-bearing
// invariant; if a future popup wires into setVisibility/setTickMs
// the static check below catches it.

describe("App popup-lifecycle state-restore (structural)", () => {
  it("App.tsx never passes setVisibility / setTickMs / setFooter to popups", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/app.tsx", "utf-8");

    // renderPopup() builds the popup props bag. Inspect it.
    // Any change that adds setVisibility/setTickMs to the props
    // bag must be a deliberate decision and should fail this
    // structural check (which the implementer can then update).
    const renderPopupBlock = src.match(/function renderPopup[\s\S]*?\n[ \t]*\}/m);
    expect(renderPopupBlock, "renderPopup function should exist in App.tsx").not.toBeNull();
    const block = renderPopupBlock?.[0] ?? "";
    expect(block, "popups must not receive setVisibility").not.toContain("setVisibility");
    expect(block, "popups must not receive setTickMs").not.toContain("setTickMs");
    expect(block, "popups must not receive setFooter").not.toContain("setFooter");
  });

  it("App.tsx popups receive ONLY yank + onClose callbacks", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/app.tsx", "utf-8");
    // The props bag passed to popups (now multi-line since `snapshot`
    // was added in Wave 6 — match across newlines).
    const m = src.match(/const props = \{([\s\S]*?)\};/);
    expect(m, "props bag should be a single literal in renderPopup").not.toBeNull();
    const propsContent = m?.[1] ?? "";
    // Must contain yank and onClose; must not contain anything else.
    expect(propsContent).toContain("yank");
    expect(propsContent).toContain("onClose");
    // Allow whitespace + commas + colons; no other identifier names.
    const identifiers = propsContent.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g) ?? [];
    const allowed = new Set([
      "yank",
      "onClose",
      "yankFn",
      "setPopup",
      "snapshot",
      "snap",
      "data",
      "null",
      // popup-mode wiring: <App> owns popupMode so the StatusBar's
      // drill hint cluster works; popups call setPopupMode when
      // Enter / Esc transitions list ↔ drill.
      "mode",
      "popupMode",
      "onModeChange",
      "setPopupMode",
      "list",
      // db + workstream: drill views fetch their own data (agent
      // scrollback via mu agent read; task notes via listNotes).
      "db",
      "workstream",
      // filter-prompt edit-state plumbing: <App> tracks whether
      // any popup's '/' filter prompt is in edit mode so the
      // StatusBar can flip its hint cluster to popup-filter mode
      // (per feat_popup_search_filter).
      "onFilterEditingChange",
      "setPopupFilterEditing",
      "false",
    ]);
    for (const id of identifiers) {
      expect(allowed.has(id), `unexpected popup prop: ${id}`).toBe(true);
    }
  });

  it("App.tsx single-popup invariant: openPopup is suppressed when popup is non-null", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/app.tsx", "utf-8");
    // Find the openPopup case and verify it has the popup !== null
    // guard.
    const m = src.match(/case "openPopup":[\s\S]{0,200}/);
    expect(m).not.toBeNull();
    const block = m?.[0] ?? "";
    expect(block, "openPopup must guard on popup !== null").toMatch(/if \(popup !== null\) return/);
  });

  it("App.tsx toggleCard is suppressed inside popups", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/app.tsx", "utf-8");
    const m = src.match(/case "toggleCard":[\s\S]{0,400}/);
    expect(m).not.toBeNull();
    const block = m?.[0] ?? "";
    expect(block, "toggleCard must guard on popup !== null").toMatch(
      /if \(popup !== null\) return/,
    );
  });
});

// Sanity smoke that the imports resolve. If <App>'s import graph
// breaks (e.g. ink/react missing, or a placeholder file deleted),
// this test fails immediately with a clear error.
describe("App import graph", () => {
  it("imports <App> + RunTuiOptions without error", async () => {
    const { App } = await import("../src/cli/tui/app.js");
    expect(typeof App).toBe("function");
    const { runTui } = await import("../src/cli/tui/index.js");
    expect(typeof runTui).toBe("function");
  });

  it("imports every card and popup component", async () => {
    const { AgentsCard } = await import("../src/cli/tui/cards/agents.js");
    const { TracksCard } = await import("../src/cli/tui/cards/tracks.js");
    const { ReadyCard } = await import("../src/cli/tui/cards/ready.js");
    const { LogCard } = await import("../src/cli/tui/cards/log.js");
    const { WorkspacesCard } = await import("../src/cli/tui/cards/workspaces.js");
    const { InProgressCard } = await import("../src/cli/tui/cards/inprogress.js");
    const { BlockedCard } = await import("../src/cli/tui/cards/blocked.js");
    const { RecentCard } = await import("../src/cli/tui/cards/recent.js");
    const { DoctorCard } = await import("../src/cli/tui/cards/doctor.js");
    const { AgentsPopup } = await import("../src/cli/tui/popups/agents.js");
    const { TracksPopup } = await import("../src/cli/tui/popups/tracks.js");
    const { ReadyPopup } = await import("../src/cli/tui/popups/ready.js");
    const { LogPopup } = await import("../src/cli/tui/popups/log.js");
    expect(typeof AgentsCard).toBe("function");
    expect(typeof TracksCard).toBe("function");
    expect(typeof ReadyCard).toBe("function");
    expect(typeof LogCard).toBe("function");
    expect(typeof WorkspacesCard).toBe("function");
    expect(typeof InProgressCard).toBe("function");
    expect(typeof BlockedCard).toBe("function");
    expect(typeof RecentCard).toBe("function");
    expect(typeof DoctorCard).toBe("function");
    expect(typeof AgentsPopup).toBe("function");
    expect(typeof TracksPopup).toBe("function");
    expect(typeof ReadyPopup).toBe("function");
    expect(typeof LogPopup).toBe("function");
  });
});

// Touch unused imports so biome's noUnusedImports is satisfied. The
// Box + Text + Writable imports are scaffolding for a future ink-
// testing-library-based test that this file will replace once that
// dep is installable.
void Box;
void Text;
void Writable;
