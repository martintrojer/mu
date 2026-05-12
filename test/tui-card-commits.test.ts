// Tests for src/cli/tui/cards/commits.tsx (feat_tui_commits_card).

import { describe, expect, it } from "vitest";
import {
  CommitsCard,
  formatBackend,
  formatSubtitle,
  shortSha,
} from "../src/cli/tui/cards/commits.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { CommitSummary } from "../src/vcs.js";
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

function commit(over: Partial<CommitSummary> = {}): CommitSummary {
  return {
    sha: "1234567890abcdef",
    subject: "ship commits card",
    body: "",
    author: "tester",
    authorDate: "2026-05-11T00:00:00Z",
    relTime: "3m",
    ...over,
  };
}

describe("CommitsCard", () => {
  it("is exported as a function", () => {
    expect(typeof CommitsCard).toBe("function");
  });

  it("renders loading and empty states", () => {
    expect(renderCardToText(CommitsCard({ snapshot: null }))).toContain("loading…");
    const empty = renderCardToText(CommitsCard({ snapshot: EMPTY_SNAPSHOT }));
    expect(empty).toContain("Commits");
    expect(empty).toContain("(no vcs)");
    expect(empty).toContain("no commits");
  });

  it("renders sha-7, relTime, and subject for each visible commit", () => {
    const snapshot = {
      ...EMPTY_SNAPSHOT,
      commitsBackend: "git",
      recentCommits: [
        commit({ sha: "abcdef0123456789", subject: "first visible", relTime: "1m" }),
        commit({ sha: "fedcba9876543210", subject: "second visible", relTime: "2h" }),
      ],
    };
    const text = renderCardToText(CommitsCard({ snapshot }));
    expect(text).toContain("Commits");
    expect(text).toContain("2 · git · 1m");
    for (const needle of ["abcdef0", "fedcba9", "first visible", "second visible"]) {
      expectTextOnce(text, needle);
    }
    expect(text).toContain("1m");
    expect(text).toContain("2h");
  });

  it("truncates at the default row budget with bottomLabel '+N more · Shift+0'", () => {
    const recentCommits = Array.from({ length: 10 }, (_, i) =>
      commit({ sha: `${i + 1}`.repeat(40).slice(0, 40), subject: `Commit ${i + 1}` }),
    );
    const text = renderCardToText(
      CommitsCard({
        snapshot: { ...EMPTY_SNAPSHOT, commitsBackend: "git", recentCommits },
        rowBudget: 8,
      }),
    );
    expect(text).toContain("+2 more · Shift+0");
    for (let i = 1; i <= 8; i++) expectTextOnce(text, `Commit ${i}`);
    expectTextAbsent(text, "Commit 9");
    expectTextAbsent(text, "Commit 10");
  });
});

describe("CommitsCard pure helpers", () => {
  it("shortSha returns seven characters", () => {
    expect(shortSha("abcdef0123456789")).toBe("abcdef0");
  });

  it("formatBackend labels missing detection distinctly", () => {
    expect(formatBackend("git")).toBe("git");
    expect(formatBackend(null)).toBe("(no vcs)");
    expect(formatBackend(undefined)).toBe("(no vcs)");
  });

  it("formatSubtitle includes backend and newest relative time when present", () => {
    expect(formatSubtitle(0, null, undefined)).toBe("0 · (no vcs)");
    expect(formatSubtitle(3, "git", "2h")).toBe("3 · git · 2h");
  });
});
