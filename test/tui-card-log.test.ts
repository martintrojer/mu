import { describe, expect, it } from "vitest";
import { LogCard } from "../src/cli/tui/cards/log.js";

const EMPTY_SNAPSHOT = {
  workstreamName: "demo",
  view: { agents: [], orphans: [], report: { reaped: [], pruned: [] } },
  tracks: [],
  ready: [],
  inProgress: [],
  blocked: [],
  recentClosed: [],
  workspaces: [],
  workspaceOrphans: [],
  recent: [],
};

describe("LogCard", () => {
  it("is exported as a function", () => {
    expect(typeof LogCard).toBe("function");
  });

  it("renders placeholder for null snapshot", () => {
    expect(LogCard({ snapshot: null })).toBeTruthy();
  });

  it("renders empty state for no events", () => {
    expect(LogCard({ snapshot: EMPTY_SNAPSHOT })).toBeTruthy();
  });
});
