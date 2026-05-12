// Tests for src/cli/tui/cards/inprogress.tsx (feat_card_6_inprogress,
// workstream `tui-impl`).

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
import type { WorkstreamSnapshot } from "../src/state.js";
import type { TaskRow } from "../src/tasks.js";
import { expectTextAbsent, expectTextOnce, renderCardToText } from "./_card-render.js";

const EMPTY_SNAPSHOT: WorkstreamSnapshot = {
  workstreamName: "demo",
  view: {
    agents: [],
    orphans: [],
    report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "status-only" },
  },
  tracks: [],
  ready: [],
  inProgress: [],
  blocked: [],
  recentClosed: [],
  workspaces: [],
  workspaceOrphans: [],
  recent: [],
  doctor: null,
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

  it("renders the loading title row", () => {
    const text = renderCardToText(InProgressCard({ snapshot: null }));
    expect(text).toContain("In-progress");
    expect(text).toContain("loading…");
  });

  it("renders the empty-state hint text", () => {
    const text = renderCardToText(InProgressCard({ snapshot: EMPTY_SNAPSHOT }));
    expect(text).toContain("In-progress");
    expect(text).toContain("(none in progress)");
  });

  it("renders title subtitle plus every task name and glyph exactly once", () => {
    const snapshot: WorkstreamSnapshot = {
      ...EMPTY_SNAPSHOT,
      inProgress: [
        task({ name: "design_x", ownerName: "worker-1", title: "Design X" }),
        task({ name: "review_x", ownerName: "reviewer-1", title: "Review X" }),
        task({ name: "cherry_x", ownerName: null, title: "Cherry-pick X" }),
      ],
    };

    const text = renderCardToText(InProgressCard({ snapshot }));
    expect(text).toContain("In-progress");
    expect(text).toContain("3 · 3 stale");
    for (const [name, owner, title] of [
      ["design_x", "worker-1", "Design X"],
      ["review_x", "reviewer-1", "Review X"],
      ["cherry_x", "—", "Cherry-pick X"],
    ] as const) {
      expectTextOnce(text, name);
      expectTextOnce(text, owner);
      expectTextOnce(text, title);
    }
    expect(text.split("").length - 1).toBe(3);
  });

  it("truncates at ROW_LIMIT with the bottomLabel '+N more · Shift+6'", () => {
    const inProgress = Array.from({ length: 10 }, (_, i) =>
      task({ name: `progress_${i + 1}`, title: `Progress ${i + 1}` }),
    );
    const text = renderCardToText(InProgressCard({ snapshot: { ...EMPTY_SNAPSHOT, inProgress } }));

    expect(text).toContain("+2 more · Shift+6");
    for (let i = 1; i <= 8; i++) expectTextOnce(text, `progress_${i}`);
    expectTextAbsent(text, "progress_9");
    expectTextAbsent(text, "progress_10");
  });
});

describe("InProgressCard pure helpers", () => {
  it("STALE_CLAIM_THRESHOLD_MS matches the mu idle threshold default (5min)", () => {
    expect(STALE_CLAIM_THRESHOLD_MS).toBe(300_000);
  });

  it("glyphFor: every IN_PROGRESS row gets the cog glyph", () => {
    // Argumentless per review_dead_code_glyph_for_unused: the glyph
    // never depended on the row, so the previous TaskRow parameter
    // was an anticipatory abstraction (AGENTS.md ban).
    const g = glyphFor();
    // The cog is a single visible character; we don't pin the exact
    // codepoint because STATUS_EMOJI may evolve, but it must be a
    // non-empty short string (≤ 4 bytes / 1-2 columns).
    expect(typeof g).toBe("string");
    expect(g.length).toBeGreaterThan(0);
    expect(g.length).toBeLessThanOrEqual(4);
  });

  it("glyphFor: takes no arguments (review_dead_code_glyph_for_unused)", () => {
    expect(glyphFor.length).toBe(0);
  });

  it("ageMs: returns the delta against `now`, never negative", () => {
    const t = task({ updatedAt: "2026-05-11T00:00:00Z" });
    const now = Date.parse("2026-05-11T00:01:30Z"); // +90s
    expect(ageMs(t, now)).toBe(90_000);
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

// feat_card_footer_inset assertions live in test/tui-card-footer-inset.test.ts
// (single sweep across cards/*) — see review_tests_inline_card_source_blocks.
