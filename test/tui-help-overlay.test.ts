import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("TUI help overlay", () => {
  it("documents the dashboard keybind-only popup shortcuts", () => {
    const src = readFileSync("./src/cli/tui/help.tsx", "utf8");
    expect(src).toContain('keys="g"');
    expect(src).toContain('effect="DAG popup"');
    expect(src).toContain('keys="t"');
    expect(src).toContain('effect="all-tasks popup"');
  });

  it("documents the DAG/all-tasks status toggles and all-tasks sort cycle", () => {
    const src = readFileSync("./src/cli/tui/help.tsx", "utf8");
    expect(src).toContain('keys="o/i/c/r/d"');
    expect(src).toContain('effect="status filter toggles (DAG + all-tasks popups)"');
    expect(src).toContain('keys="s"');
    expect(src).toContain('effect="cycle sort key (roi/recency/age/id)"');
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
