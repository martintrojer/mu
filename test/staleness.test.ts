import { describe, expect, it } from "vitest";
import { WORKSPACE_STALE_THRESHOLD, isWorkspaceStale } from "../src/staleness.js";

describe("workspace staleness threshold", () => {
  it("marks null and values below 10 as fresh, and 10+ as stale", () => {
    expect(WORKSPACE_STALE_THRESHOLD).toBe(10);
    expect(isWorkspaceStale(null)).toBe(false);
    expect(isWorkspaceStale(9)).toBe(false);
    expect(isWorkspaceStale(10)).toBe(true);
  });
});
