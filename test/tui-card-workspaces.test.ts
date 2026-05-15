// Tests for src/cli/tui/cards/workspaces.tsx (feat_card_5_workspaces,
// workstream `tui-impl`).

import { describe, expect, it } from "vitest";
import {
  WorkspacesCard,
  colorForBehind,
  colorForGlyph,
  formatBehind,
  formatSubtitle,
  glyphFor,
  isStale,
} from "../src/cli/tui/cards/workspaces.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { WorkspaceRow } from "../src/workspace.js";
import { expectTextAbsent, expectTextOnce, renderCardToText } from "./_card-render.js";

const EMPTY_SNAPSHOT: WorkstreamSnapshot = {
  workstreamName: "demo",
  view: {
    agents: [],
    orphans: [],
    report: { prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "report-only" },
  },
  tracks: [],
  ready: [],
  inProgress: [],
  blocked: [],
  recentClosed: [],
  allTasks: [],
  workspaces: [],
  workspaceOrphans: [],
  recent: [],
  recentCommits: [],
  commitsBackend: null,
  doctor: null,
};

function row(over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    agentName: "worker-1",
    workstreamName: "demo",
    backend: "git",
    path: "/tmp/demo/worker-1",
    parentRef: "abc123def4567890",
    createdAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

describe("WorkspacesCard", () => {
  it("is exported as a function", () => {
    expect(typeof WorkspacesCard).toBe("function");
  });

  it("renders the loading title row", () => {
    const text = renderCardToText(WorkspacesCard({ snapshot: null }));
    expect(text).toContain("Workspaces");
    expect(text).toContain("loading…");
  });

  it("renders the empty-state hint text", () => {
    const text = renderCardToText(WorkspacesCard({ snapshot: EMPTY_SNAPSHOT }));
    expect(text).toContain("Workspaces");
    expect(text).toContain("(no workspaces) try `mu agent spawn worker-1 -w demo --workspace`");
  });

  it("renders title subtitle plus every workspace agent and glyph exactly once", () => {
    const workspaces = [
      row({ agentName: "worker-1", commitsBehindMain: 1, dirty: false }),
      row({ agentName: "worker-2", commitsBehindMain: 12, dirty: false, parentRef: "def456" }),
      row({ agentName: "worker-3", commitsBehindMain: 0, dirty: true, parentRef: null }),
    ];

    const text = renderCardToText(
      WorkspacesCard({ snapshot: { ...EMPTY_SNAPSHOT, workspaces }, rowBudget: 8 }),
    );
    expect(text).toContain("Workspaces");
    expect(text).toContain("3 · 1 stale · 1 dirty");
    for (const agent of ["worker-1", "worker-2", "worker-3"] as const) {
      expectTextOnce(text, agent);
    }
    expect(text).toContain("12");
    expectTextOnce(text, "★");
    expectTextOnce(text, "ⓘ");
    expectTextOnce(text, "✓");
  });

  it("truncates at the default row budget with the bottomLabel '+N more · Shift+5'", () => {
    const workspaces = Array.from({ length: 10 }, (_, i) =>
      row({ agentName: `worker-${i + 1}`, commitsBehindMain: i }),
    );
    const text = renderCardToText(
      WorkspacesCard({ snapshot: { ...EMPTY_SNAPSHOT, workspaces }, rowBudget: 8 }),
    );

    expect(text).toContain("+2 more · Shift+5");
    for (let i = 1; i <= 8; i++) expectTextOnce(text, `worker-${i}`);
    expectTextAbsent(text, "worker-9");
    expectTextAbsent(text, "worker-10");
  });
});

describe("WorkspacesCard pure helpers", () => {
  it("isStale: ≥10 commits behind ⇒ true; below ⇒ false; unknown ⇒ false", () => {
    expect(isStale(0)).toBe(false);
    expect(isStale(2)).toBe(false);
    expect(isStale(9)).toBe(false);
    expect(isStale(10)).toBe(true);
    expect(isStale(50)).toBe(true);
    expect(isStale(null)).toBe(false);
    expect(isStale(undefined)).toBe(false);
  });

  it("formatBehind: number ⇒ String(n); null/undefined ⇒ em-dash", () => {
    expect(formatBehind(0)).toBe("0");
    expect(formatBehind(7)).toBe("7");
    expect(formatBehind(null)).toBe("—");
    expect(formatBehind(undefined)).toBe("—");
  });

  it("colorForBehind: green ≤2, yellow 3-9, red ≥10, undefined ⇒ default", () => {
    expect(colorForBehind(0)).toBe("green");
    expect(colorForBehind(2)).toBe("green");
    expect(colorForBehind(3)).toBe("yellow");
    expect(colorForBehind(9)).toBe("yellow");
    expect(colorForBehind(10)).toBe("red");
    expect(colorForBehind(100)).toBe("red");
    expect(colorForBehind(null)).toBeUndefined();
    expect(colorForBehind(undefined)).toBeUndefined();
  });

  it("glyphFor: dirty wins over stale wins over clean", () => {
    expect(glyphFor(row({ dirty: true, commitsBehindMain: 50 }))).toBe("★");
    expect(glyphFor(row({ dirty: true, commitsBehindMain: 0 }))).toBe("★");
    expect(glyphFor(row({ dirty: false, commitsBehindMain: 12 }))).toBe("ⓘ");
    expect(glyphFor(row({ dirty: false, commitsBehindMain: 0 }))).toBe("✓");
    expect(glyphFor(row({ dirty: undefined, commitsBehindMain: 0 }))).toBe("✓");
    expect(glyphFor(row({ dirty: null, commitsBehindMain: 50 }))).toBe("ⓘ");
  });

  it("colorForGlyph: dirty=red, stale=yellow, clean=green", () => {
    expect(colorForGlyph(row({ dirty: true }))).toBe("red");
    expect(colorForGlyph(row({ dirty: false, commitsBehindMain: 12 }))).toBe("yellow");
    expect(colorForGlyph(row({ dirty: false, commitsBehindMain: 0 }))).toBe("green");
  });

  it("formatSubtitle: zeros are suppressed; positives are joined with ' · '", () => {
    expect(formatSubtitle(0, 0, 0)).toBe("0");
    expect(formatSubtitle(3, 0, 0)).toBe("3");
    expect(formatSubtitle(3, 1, 0)).toBe("3 · 1 stale");
    expect(formatSubtitle(3, 0, 2)).toBe("3 · 2 dirty");
    expect(formatSubtitle(5, 1, 2)).toBe("5 · 1 stale · 2 dirty");
  });
});

// feat_card_footer_inset assertions live in test/tui-card-footer-inset.test.ts
// (single sweep across cards/*) — see review_tests_inline_card_source_blocks.
