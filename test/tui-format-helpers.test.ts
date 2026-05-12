// Direct unit tests for src/cli/tui/format-helpers.ts — the pure
// formatters hoisted out of cards/* and popups/* in a single bundled
// pass per:
//   - review_dedup_age_ms
//   - review_dedup_color_for_bucket
//   - review_dedup_format_roi
//   - review_unify_format_when_since
//
// The card/popup unit tests still exercise the helpers via re-export
// (back-compat), but THIS suite pins the canonical behaviour at the
// single source of truth so a future drift inside a card can't quietly
// reintroduce the duplication this commit deleted.

import { describe, expect, it } from "vitest";
import {
  ageMs,
  colorForBucket,
  formatRoi,
  formatSinceClaim,
  formatWhen,
} from "../src/cli/tui/format-helpers.js";
import type { TaskRow } from "../src/tasks.js";

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

describe("ageMs", () => {
  it("returns the delta against `now`, never negative", () => {
    const t = task({ updatedAt: "2026-05-11T00:00:00Z" });
    const now = Date.parse("2026-05-11T00:01:30Z"); // +90s
    expect(ageMs(t, now)).toBe(90_000);
    // future updatedAt (clock skew): clamp to 0
    expect(ageMs(t, Date.parse("2026-05-10T23:59:00Z"))).toBe(0);
  });

  it("returns null when updatedAt is unparseable", () => {
    expect(ageMs(task({ updatedAt: "not-a-date" }), Date.now())).toBeNull();
  });
});

describe("colorForBucket", () => {
  it("high → green", () => {
    expect(colorForBucket("high")).toBe("green");
  });
  it("infinite → green (treated as a special-case high)", () => {
    expect(colorForBucket("infinite")).toBe("green");
  });
  it("mid → yellow", () => {
    expect(colorForBucket("mid")).toBe("yellow");
  });
  it("low → undefined (default text colour)", () => {
    expect(colorForBucket("low")).toBeUndefined();
  });
});

describe("formatRoi", () => {
  it("rounds impact / effortDays to a short integer", () => {
    expect(formatRoi(60, 0.2)).toBe("300");
    expect(formatRoi(75, 1)).toBe("75");
    expect(formatRoi(50, 3)).toBe("17");
    expect(formatRoi(99, 4)).toBe("25");
  });
  it("renders ∞ when effortDays is zero or negative", () => {
    expect(formatRoi(60, 0)).toBe("∞");
    expect(formatRoi(60, -1)).toBe("∞");
  });
});

describe("formatSinceClaim (in-flight, no suffix)", () => {
  it("null / undefined → em-dash sentinel", () => {
    expect(formatSinceClaim(null)).toBe("—");
    expect(formatSinceClaim(undefined)).toBe("—");
  });
  it("short relative-time tokens, no suffix", () => {
    expect(formatSinceClaim(0)).toBe("0s");
    expect(formatSinceClaim(45_000)).toBe("45s");
    expect(formatSinceClaim(60_000)).toBe("1m");
    expect(formatSinceClaim(15 * 60_000)).toBe("15m");
    expect(formatSinceClaim(60 * 60_000)).toBe("1h");
    expect(formatSinceClaim(5 * 60 * 60_000)).toBe("5h");
    expect(formatSinceClaim(24 * 60 * 60_000)).toBe("1d");
    expect(formatSinceClaim(7 * 24 * 60 * 60_000)).toBe("1w");
  });
});

describe("formatWhen (closed-at, ' ago' suffix)", () => {
  it("null / undefined → em-dash sentinel", () => {
    expect(formatWhen(null)).toBe("—");
    expect(formatWhen(undefined)).toBe("—");
  });
  it("short relative-time tokens with ` ago` suffix", () => {
    expect(formatWhen(0)).toBe("0s ago");
    expect(formatWhen(45_000)).toBe("45s ago");
    expect(formatWhen(60_000)).toBe("1m ago");
    expect(formatWhen(15 * 60_000)).toBe("15m ago");
    expect(formatWhen(60 * 60_000)).toBe("1h ago");
    expect(formatWhen(5 * 60 * 60_000)).toBe("5h ago");
    expect(formatWhen(24 * 60 * 60_000)).toBe("1d ago");
    expect(formatWhen(7 * 24 * 60 * 60_000)).toBe("1w ago");
  });
});

describe("formatSinceClaim ↔ formatWhen consistency", () => {
  // The whole point of unifying onto relTime/relTimeAgo: both tokens
  // share arithmetic, and `formatWhen(ms)` = `formatSinceClaim(ms) + " ago"`
  // for every non-null input.
  const samples = [0, 45_000, 60_000, 15 * 60_000, 60 * 60_000, 24 * 60 * 60_000];
  for (const ms of samples) {
    it(`agrees on ${ms}ms`, () => {
      expect(formatWhen(ms)).toBe(`${formatSinceClaim(ms)} ago`);
    });
  }
});
