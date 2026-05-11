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
  it("source documents the Enter no-op (drill is intentionally unbound)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/log.tsx", "utf-8");
    // Comment + handler both present so the next agent doesn't
    // "fix" the missing drill case.
    expect(src).toMatch(/Enter[^\n]*UNBOUND/i);
    expect(src).toContain('case "drill":');
  });
});
