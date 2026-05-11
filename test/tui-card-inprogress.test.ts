// Tests for src/cli/tui/cards/inprogress.tsx (feat_card_6_inprogress,
// workstream `tui-impl`). ink-testing-library is not installable in
// this environment so we lean on:
//   - calling the FC as a plain function (catches import-graph drift),
//   - asserting on the pure helpers (sinceClaim formatter, glyphFor,
//     isStale, formatSubtitle, ageMs).
//
// Mirrors test/tui-card-workspaces.test.ts.

import { describe, expect, it } from "vitest";
import {
  InProgressCard,
  STALE_CLAIM_THRESHOLD_MS,
  ageMs,
  formatSinceClaim,
  formatSubtitle,
  glyphFor,
  isStale,
} from "../src/cli/tui/cards/inprogress.js";
import type { TaskRow } from "../src/tasks.js";

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

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    name: "design_x",
    workstreamName: "demo",
    title: "Design X",
    status: "IN_PROGRESS",
    impact: 50,
    effortDays: 1,
    ownerName: "worker-1",
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

describe("InProgressCard", () => {
  it("is exported as a function", () => {
    expect(typeof InProgressCard).toBe("function");
  });

  it("renders a placeholder for null snapshot (loading state)", () => {
    const result = InProgressCard({ snapshot: null });
    expect(result).toBeTruthy();
  });

  it("renders the empty-state hint when no IN_PROGRESS tasks exist", () => {
    const result = InProgressCard({ snapshot: EMPTY_SNAPSHOT });
    expect(result).toBeTruthy();
  });

  it("renders rows for a populated inProgress list", () => {
    const result = InProgressCard({
      snapshot: {
        ...EMPTY_SNAPSHOT,
        inProgress: [
          task({ name: "design_x", ownerName: "worker-1" }),
          task({ name: "review_x", ownerName: "reviewer-1", title: "Review X" }),
          task({ name: "cherry_x", ownerName: null, title: "Cherry-pick X" }),
        ],
      },
    });
    expect(result).toBeTruthy();
  });
});

describe("InProgressCard pure helpers", () => {
  it("STALE_CLAIM_THRESHOLD_MS matches the mu idle threshold default (5min)", () => {
    expect(STALE_CLAIM_THRESHOLD_MS).toBe(300_000);
  });

  it("glyphFor: every IN_PROGRESS row gets the cog glyph", () => {
    const g = glyphFor(task());
    // The cog is a single visible character; we don't pin the exact
    // codepoint because STATUS_EMOJI may evolve, but it must be a
    // non-empty short string (≤ 4 bytes / 1-2 columns).
    expect(typeof g).toBe("string");
    expect(g.length).toBeGreaterThan(0);
    expect(g.length).toBeLessThanOrEqual(4);
  });

  it("ageMs: returns the delta against `now`, never negative", () => {
    const t = task({ updatedAt: "2026-05-11T00:00:00Z" });
    const now = Date.parse("2026-05-11T00:01:30Z"); // +90s
    expect(ageMs(t, now)).toBe(90_000);
    // future updatedAt (clock skew): clamp to 0
    expect(ageMs(t, Date.parse("2026-05-10T23:59:00Z"))).toBe(0);
  });

  it("ageMs: returns null when updatedAt is unparseable", () => {
    expect(ageMs(task({ updatedAt: "not-a-date" }), Date.now())).toBeNull();
  });

  it("isStale: ≥5min ⇒ true; below ⇒ false; null/undefined ⇒ false", () => {
    expect(isStale(0)).toBe(false);
    expect(isStale(60_000)).toBe(false);
    expect(isStale(STALE_CLAIM_THRESHOLD_MS - 1)).toBe(false);
    expect(isStale(STALE_CLAIM_THRESHOLD_MS)).toBe(true);
    expect(isStale(STALE_CLAIM_THRESHOLD_MS * 10)).toBe(true);
    expect(isStale(null)).toBe(false);
    expect(isStale(undefined)).toBe(false);
  });

  it("formatSinceClaim: short relative-time tokens", () => {
    expect(formatSinceClaim(null)).toBe("—");
    expect(formatSinceClaim(undefined)).toBe("—");
    expect(formatSinceClaim(0)).toBe("0s");
    expect(formatSinceClaim(45_000)).toBe("45s");
    expect(formatSinceClaim(60_000)).toBe("1m");
    expect(formatSinceClaim(15 * 60_000)).toBe("15m");
    expect(formatSinceClaim(60 * 60_000)).toBe("1h");
    expect(formatSinceClaim(5 * 60 * 60_000)).toBe("5h");
    expect(formatSinceClaim(24 * 60 * 60_000)).toBe("1d");
    expect(formatSinceClaim(7 * 24 * 60 * 60_000)).toBe("1w");
  });

  it("formatSubtitle: stale leg suppressed when zero", () => {
    expect(formatSubtitle(0, 0)).toBe("0");
    expect(formatSubtitle(3, 0)).toBe("3");
    expect(formatSubtitle(3, 1)).toBe("3 · 1 stale");
    expect(formatSubtitle(7, 4)).toBe("7 · 4 stale");
  });
});
