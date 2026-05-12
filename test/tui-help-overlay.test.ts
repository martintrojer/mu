import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("TUI help overlay", () => {
  it("documents the dashboard DAG popup shortcut", () => {
    const src = readFileSync("./src/cli/tui/help.tsx", "utf8");
    expect(src).toContain('keys="g"');
    expect(src).toContain('effect="DAG popup"');
  });

  it("documents the DAG popup status toggles", () => {
    const src = readFileSync("./src/cli/tui/help.tsx", "utf8");
    expect(src).toContain('keys="o/i/c/r/d"');
    expect(src).toContain('effect="toggle DAG status filter (in DAG popup)"');
  });

  it("documents the dashboard card and popup digit ranges", () => {
    const src = readFileSync("./src/cli/tui/help.tsx", "utf8");
    expect(src).toContain(
      "toggle Commits/Agents/Tracks/Ready/Log/Workspaces/In-progress/Blocked/Recent/Doctor (0-9)",
    );
    expect(src).toContain(`keys="Shift 0 ')'"`);
    expect(src).toContain('effect="Commits popup"');
    expect(src).toContain("Shift+8 '*' = Recent");
    expect(src).not.toContain('keys="l"');
  });
});
