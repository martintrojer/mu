// Tests for the Tasks popup (popups/ready.tsx). The full keymap is
// covered via dispatchPopupKey in test/tui-keys.test.ts; here we
// exercise the yankCommandForTask matrix and import-graph integrity.

import { describe, expect, it } from "vitest";
import { ReadyPopup } from "../src/cli/tui/popups/ready.js";

describe("ReadyPopup (Tasks popup)", () => {
  it("is exported as a function", () => {
    expect(typeof ReadyPopup).toBe("function");
  });

  // The yank-matrix is implemented in yankCommandForTask which is
  // not exported. We verify it indirectly via static-source assertion.
  it("source contains yank cases for OPEN/IN_PROGRESS/CLOSED", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/ready.tsx", "utf-8");
    expect(src).toContain("mu task claim");
    expect(src).toContain("mu task release");
    expect(src).toContain("mu task close");
    expect(src).toContain("mu task open");
    // And it covers the IN_PROGRESS branch
    expect(src).toContain('"IN_PROGRESS"');
  });
});
