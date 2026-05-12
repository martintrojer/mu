import { describe, expect, it } from "vitest";
import type { AgentRow } from "../src/agents.js";
import { AgentsCard } from "../src/cli/tui/cards/agents.js";
import { ReadyCard } from "../src/cli/tui/cards/ready.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { TaskRow } from "../src/tasks.js";
import { renderCardToText } from "./_card-render.js";

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

function agent(over: Partial<AgentRow> = {}): AgentRow {
  return {
    name: "worker-1",
    workstreamName: "demo",
    cli: "pi",
    paneId: "%1",
    status: "busy",
    role: "full-access",
    tab: null,
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    name: "ready_1",
    workstreamName: "demo",
    title: "Ready 1",
    status: "OPEN",
    impact: 80,
    effortDays: 1,
    ownerName: null,
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

describe("card row budgets", () => {
  it("cards with empty data still render their min-row padding", () => {
    const text = renderCardToText(ReadyCard({ snapshot: EMPTY_SNAPSHOT, rowBudget: 3 }));
    expect(text).toContain("(no ready tasks)");
    expect(text).toContain("3");
  });

  it("populated cards slice to the dynamic row budget", () => {
    const ready = Array.from({ length: 6 }, (_, i) =>
      task({ name: `ready_${i + 1}`, title: `Ready ${i + 1}` }),
    );
    const text = renderCardToText(
      ReadyCard({ snapshot: { ...EMPTY_SNAPSHOT, ready }, rowBudget: 4 }),
    );
    expect(text).toContain("+2 more · Shift+3");
    expect(text).toContain("ready_1");
    expect(text).toContain("ready_4");
    expect(text).not.toContain("ready_5");
    expect(text).not.toContain("ready_6");
  });

  it("agents card also obeys the dynamic row budget", () => {
    const agents = Array.from({ length: 4 }, (_, i) =>
      agent({ name: `worker-${i + 1}`, paneId: `%${i + 1}` }),
    );
    const text = renderCardToText(
      AgentsCard({
        snapshot: { ...EMPTY_SNAPSHOT, view: { ...EMPTY_SNAPSHOT.view, agents } },
        rowBudget: 2,
      }),
    );
    expect(text).toContain("+2 more · Shift+1");
    expect(text).toContain("worker-1");
    expect(text).toContain("worker-2");
    expect(text).not.toContain("worker-3");
  });
});
