import { describe, expect, it } from "vitest";
import { ReadyCard } from "../src/cli/tui/cards/ready.js";

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

describe("ReadyCard", () => {
  it("is exported as a function", () => {
    expect(typeof ReadyCard).toBe("function");
  });

  it("renders placeholder for null snapshot", () => {
    expect(ReadyCard({ snapshot: null })).toBeTruthy();
  });

  it("renders empty state for no ready tasks", () => {
    expect(ReadyCard({ snapshot: EMPTY_SNAPSHOT })).toBeTruthy();
  });
});
