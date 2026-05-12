import { describe, expect, it } from "vitest";
import { LogPopup } from "../src/cli/tui/popups/log.js";

describe("LogPopup", () => {
  it("is exported as a function", () => {
    expect(typeof LogPopup).toBe("function");
  });
  it("source yanks classified verbs (mu task show / mu agent show)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/log.tsx", "utf-8");
    expect(src).toContain("mu task show");
    expect(src).toContain("mu agent show");
  });
  it("Enter drills into a read-only full-payload view of the focused event", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/log.tsx", "utf-8");
    // Header comment explains the drill (replaces the prior
    // "intentionally UNBOUND" no-op rationale; we keep that word
    // in the same paragraph as historical context so future
    // readers don't try to revert).
    expect(src).toMatch(/Enter[^\n]*drills/i);
    // The drill case is wired (not a silent return).
    expect(src).toContain('case "drill":');
    expect(src).toContain('onModeChange("drill")');
    // Drill-mode body is rendered via the shared primitive with
    // the focused event's full untruncated human-display payload
    // (structured task.claim payloads strip their tab-delimited
    // sentinel before display).
    expect(src).toContain("<DrillScrollView");
    expect(src).toContain("body={drillBody}");
    expect(src).toContain("focused ? displayEventPayload(focused.payload) :");
    // Drill-mode keymap: scroll, jump, yank-by-seq, esc/q back.
    // Per review_dedup_drill_keymap the per-popup applyScroll /
    // setDetailScrollTop skeleton now lives in useDrillKeymap.
    expect(src).toContain("useDrillKeymap");
    expect(src).toContain("drill.dispatch(action)");
    expect(src).not.toContain("setDetailScrollTop");
    // Yank target in drill mode points at the single-event
    // lookup command (mu log --since <seq-1> -n 1).
    expect(src).toContain("mu log --since");
  });
});
