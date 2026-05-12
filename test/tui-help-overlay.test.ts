import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("TUI help overlay", () => {
  it("documents the dashboard DAG popup shortcut", () => {
    const src = readFileSync("./src/cli/tui/help.tsx", "utf8");
    expect(src).toContain('keys="g"');
    expect(src).toContain('effect="DAG popup"');
  });

  it("documents the dashboard commits popup shortcut", () => {
    const src = readFileSync("./src/cli/tui/help.tsx", "utf8");
    expect(src).toContain('keys="l"');
    expect(src).toContain('effect="commits popup"');
  });
});
