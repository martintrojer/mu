import { describe, expect, it } from "vitest";
import { TracksPopup } from "../src/cli/tui/popups/tracks.js";

describe("TracksPopup", () => {
  it("is exported as a function", () => {
    expect(typeof TracksPopup).toBe("function");
  });
  it("source yanks `mu task tree <goal>`", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/tracks.tsx", "utf-8");
    expect(src).toContain("mu task tree");
  });
});
