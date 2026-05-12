import { describe, expect, it } from "vitest";
import { TracksCard } from "../src/cli/tui/cards/tracks.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { TaskRow } from "../src/tasks.js";
import type { Track } from "../src/tracks.js";
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
  recentCommits: [],
  doctor: null,
};

function task(name: string): TaskRow {
  return {
    name,
    workstreamName: "demo",
    title: name,
    status: "OPEN",
    impact: 50,
    effortDays: 1,
    ownerName: null,
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
  };
}

function track(rootNames: readonly string[], over: Partial<Track> = {}): Track {
  return {
    roots: rootNames.map(task),
    taskIds: new Set(rootNames),
    readyCount: 1,
    ...over,
  };
}

describe("TracksCard", () => {
  it("is exported as a function", () => {
    expect(typeof TracksCard).toBe("function");
  });

  it("renders the loading title row", () => {
    const text = renderCardToText(TracksCard({ snapshot: null }));
    expect(text).toContain("Tracks");
    expect(text).toContain("loading…");
  });

  it("renders the empty-state hint text", () => {
    const text = renderCardToText(TracksCard({ snapshot: EMPTY_SNAPSHOT }));
    expect(text).toContain("Tracks");
    expect(text).toContain('(no goals) try `mu task add -w demo --title "..."`');
  });

  it("renders title subtitle plus every visible track id/count/glyph exactly once", () => {
    const tracks = [
      track(["goal_alpha"], { taskIds: new Set(["goal_alpha"]), readyCount: 1 }),
      track(["goal_beta", "goal_gamma"], {
        taskIds: new Set(["goal_beta", "goal_gamma", "shared"]),
        readyCount: 0,
      }),
    ];
    const text = renderCardToText(TracksCard({ snapshot: { ...EMPTY_SNAPSHOT, tracks } }));

    expect(text).toContain("Tracks");
    expect(text).toContain("2 · 1 ready");
    expectTextOnce(text, "Track 1");
    expectTextOnce(text, "Track 2");
    expectTextOnce(text, "goal_alpha");
    expectTextOnce(text, "goal_beta");
    expectTextOnce(text, "goal_gamma");
    expectTextOnce(text, "(1 task · 1 ready)");
    expectTextOnce(text, "(3 tasks · 0 ready)");
    expectTextOnce(text, "⋈");
  });

  it("truncates at ROW_LIMIT with the bottomLabel '+N more · Shift+2'", () => {
    const tracks = Array.from({ length: 10 }, (_, i) => track([`goal_${i + 1}`]));
    const text = renderCardToText(TracksCard({ snapshot: { ...EMPTY_SNAPSHOT, tracks } }));

    expect(text).toContain("+2 more · Shift+2");
    for (let i = 1; i <= 8; i++) {
      expectTextOnce(text, `Track ${i}`);
      expectTextOnce(text, `goal_${i}`);
    }
    expectTextAbsent(text, "Track 9");
    expectTextAbsent(text, "goal_9");
    expectTextAbsent(text, "goal_10");
  });
});

// feat_card_footer_inset assertions live in test/tui-card-footer-inset.test.ts
// (single sweep across cards/*) — see review_tests_inline_card_source_blocks.
