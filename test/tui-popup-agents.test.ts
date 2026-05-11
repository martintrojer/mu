import { describe, expect, it } from "vitest";
import { AgentsPopup } from "../src/cli/tui/popups/agents.js";

describe("AgentsPopup", () => {
  it("is exported as a function", () => {
    expect(typeof AgentsPopup).toBe("function");
  });
  it("source covers yank verbs (send / free / close)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/agents.tsx", "utf-8");
    expect(src).toContain("mu agent send");
    expect(src).toContain("mu agent free");
    expect(src).toContain("mu agent close");
  });
});
