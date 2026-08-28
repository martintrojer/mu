import { describe, expect, it } from "vitest";
import { LogCard } from "../src/cli/tui/cards/log.js";
import type { LogRow } from "../src/logs.js";
import type { WorkstreamSnapshot } from "../src/state.js";
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

function logRow(seq: number, payload: string): LogRow {
  return {
    seq,
    workstreamName: "demo",
    source: `worker-${seq}`,
    kind: "event",
    intent: null,
    group: `grp-${seq}`,
    op: "put",
    payload,
    createdAt: `2026-05-11T00:00:0${seq % 10}Z`,
  };
}

describe("LogCard", () => {
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

  // Uses the verbs that SURVIVED v2-retire-log-shim (agent.* /
  // workspace.*). The retired `task *` prose no longer classifies, so it
  // would render unsplit and get truncated by the column budget \u2014 which
  // is a rendering detail, not what this test is about.
  it("renders title subtitle plus every visible event field exactly once", () => {
    const recent = [
      logRow(1, "agent spawn worker-a"),
      logRow(2, "agent free worker-b"),
      logRow(3, "workspace refresh worker-1"),
    ];
    const text = renderCardToText(LogCard({ snapshot: { ...EMPTY_SNAPSHOT, recent } }));

    expect(text).toContain("Activity log");
    expect(text).toContain("last ↑3");
    for (const [source, verb] of [
      ["worker-1", "agent spawn"],
      ["worker-2", "agent free"],
      ["worker-3", "workspace refresh"],
    ] as const) {
      expect(text).toContain(source);
      expectTextOnce(text, verb);
    }
    expect(text).toContain("worker-a");
    expect(text).toContain("worker-b");
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

  // v2-retire-log-shim deleted the tab-delimited `task.claim<TAB>...`
  // payload prefix (and the strip-on-render helper that existed only to
  // undo it). Claim attribution is `ops.actor` now, so payloads render
  // VERBATIM — nothing to unwrap, and no delimiter noise to leak.
  it("renders payloads verbatim, with no structured prefix to strip", () => {
    const recent = [logRow(1, "task claim build_x by worker-1 (was owner=none)")];
    const text = renderCardToText(LogCard({ snapshot: { ...EMPTY_SNAPSHOT, recent } }));

    expectTextOnce(text, "task claim");
    expect(text).toContain("build_x by worker-1");
    expectTextAbsent(text, "actor=worker-1");
    expectTextAbsent(text, "\t");
  });
});
