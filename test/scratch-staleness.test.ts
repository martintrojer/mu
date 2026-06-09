// Fast-tier unit tests for the scratch idle-agent nudge predicate.
//
// Scratch agents are task-less by design, so the regular `idle` flag
// (which requires owning an IN_PROGRESS task) never fires for them.
// `isLingeringScratchAgent` is the special-case predicate that powers
// the `mu state` nudge so easy spawning doesn't accumulate forgotten
// panes. See docs/VOCABULARY.md "scratch workstream".

import { describe, expect, it } from "vitest";
import { isLingeringScratchAgent } from "../src/staleness.js";

describe("isLingeringScratchAgent", () => {
  const now = Date.parse("2026-06-09T12:00:00.000Z");
  const threshold = 300_000; // 5 min, matches MU_IDLE_THRESHOLD_MS default

  it("fires when the agent is older than the threshold", () => {
    const old = new Date(now - threshold - 1).toISOString();
    expect(isLingeringScratchAgent(old, threshold, now)).toBe(true);
  });

  it("does not fire just under the threshold", () => {
    const recent = new Date(now - threshold + 1000).toISOString();
    expect(isLingeringScratchAgent(recent, threshold, now)).toBe(false);
  });

  it("fires exactly at the threshold boundary", () => {
    const exact = new Date(now - threshold).toISOString();
    expect(isLingeringScratchAgent(exact, threshold, now)).toBe(true);
  });

  it("does not fire for a non-positive threshold (disabled)", () => {
    const old = new Date(now - 10 * threshold).toISOString();
    expect(isLingeringScratchAgent(old, 0, now)).toBe(false);
    expect(isLingeringScratchAgent(old, -1, now)).toBe(false);
  });

  it("returns false on an unparsable timestamp rather than throwing", () => {
    expect(isLingeringScratchAgent("not-a-date", threshold, now)).toBe(false);
  });
});
