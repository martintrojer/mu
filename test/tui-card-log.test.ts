import { describe, expect, it } from "vitest";
import { LogCard } from "../src/cli/tui/cards/log.js";
import { type LogRow, formatClaimEvent } from "../src/logs.js";
import type { WorkstreamSnapshot } from "../src/state.js";
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

function logRow(seq: number, payload: string): LogRow {
  return {
    seq,
    workstreamName: "demo",
    source: `worker-${seq}`,
    kind: "event",
    payload,
    createdAt: `2026-05-11T00:00:0${seq % 10}Z`,
  };
}

describe("LogCard", () => {
  it("is exported as a function", () => {
    expect(typeof LogCard).toBe("function");
  });

  it("renders the loading title row", () => {
    const text = renderCardToText(LogCard({ snapshot: null }));
    expect(text).toContain("Activity log");
    expect(text).toContain("loading…");
  });

  it("renders the empty-state hint text", () => {
    const text = renderCardToText(LogCard({ snapshot: EMPTY_SNAPSHOT }));
    expect(text).toContain("Activity log");
    expect(text).toContain("(no events yet)");
  });

  it("renders title subtitle plus every visible event field exactly once", () => {
    const recent = [
      logRow(1, "task claim build_x by worker-1"),
      logRow(2, "task status build_x (IN_PROGRESS → CLOSED)"),
      logRow(3, "workspace refresh worker-1"),
    ];
    const text = renderCardToText(LogCard({ snapshot: { ...EMPTY_SNAPSHOT, recent } }));

    expect(text).toContain("Activity log");
    expect(text).toContain("last ↑3");
    for (const [source, verb] of [
      ["worker-1", "task claim"],
      ["worker-2", "task status"],
      ["worker-3", "workspace refresh"],
    ] as const) {
      expect(text).toContain(source);
      expectTextOnce(text, verb);
    }
    expect(text).toContain("build_x by worker-1");
    expect(text).toContain("build_x (IN_PROGRESS → CLOSED)");
  });

  it("truncates at the default row budget by rendering only the visible events", () => {
    const recent = Array.from({ length: 10 }, (_, i) => logRow(i + 1, `task claim task_${i + 1}`));
    const text = renderCardToText(
      LogCard({ snapshot: { ...EMPTY_SNAPSHOT, recent }, rowBudget: 8 }),
    );

    expect(text).toContain("Activity log");
    expect(text).toContain("last ↑8");
    for (let i = 1; i <= 8; i++) {
      expectTextOnce(text, `task_${i}`);
    }
    expectTextAbsent(text, "task_9");
    expectTextAbsent(text, "task_10");
  });

  it("renders structured task.claim events through the human-display payload", () => {
    const recent = [
      logRow(
        1,
        formatClaimEvent({
          localId: "build_x",
          actor: "worker-1",
          anonymous: false,
          prose: "task claim build_x by worker-1 (was owner=none)",
        }),
      ),
    ];
    const text = renderCardToText(LogCard({ snapshot: { ...EMPTY_SNAPSHOT, recent } }));

    expectTextOnce(text, "task claim");
    expect(text).toContain("build_x by worker-1");
    expectTextAbsent(text, "task.claim");
    expectTextAbsent(text, "actor=worker-1");
  });
});
