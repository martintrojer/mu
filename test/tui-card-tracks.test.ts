import { describe, expect, it } from "vitest";
import { TracksCard } from "../src/cli/tui/cards/tracks.js";

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

describe("TracksCard", () => {
  it("is exported as a function", () => {
    expect(typeof TracksCard).toBe("function");
  });

  it("renders placeholder for null snapshot", () => {
    expect(TracksCard({ snapshot: null })).toBeTruthy();
  });

  it("renders empty state for no tracks", () => {
    expect(TracksCard({ snapshot: EMPTY_SNAPSHOT })).toBeTruthy();
  });
});
