import { describe, expect, it } from "vitest";
import type { AgentRow } from "../src/agents.js";
import { AgentsCard } from "../src/cli/tui/cards/agents.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { TaskRow } from "../src/tasks.js";
import { expectTextOnce, renderCardToText } from "./_card-render.js";

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
    name: "build_x",
    workstreamName: "demo",
    title: "Build X",
    status: "IN_PROGRESS",
    impact: 50,
    effortDays: 1,
    ownerName: "worker-1",
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

describe("AgentsCard", () => {
  it("is exported as a function", () => {
    expect(typeof AgentsCard).toBe("function");
  });

  it("renders the loading title row", () => {
    const text = renderCardToText(AgentsCard({ snapshot: null }));
    expect(text).toContain("Agents");
    expect(text).toContain("loading…");
  });

  it("renders the empty-state hint text", () => {
    const text = renderCardToText(AgentsCard({ snapshot: EMPTY_SNAPSHOT }));
    expect(text).toContain("Agents");
    expect(text).toContain("(no agents) try `mu agent spawn worker-1 -w demo`");
  });

  it("renders title subtitle plus one row per populated agent", () => {
    const snapshot: WorkstreamSnapshot = {
      ...EMPTY_SNAPSHOT,
      view: {
        ...EMPTY_SNAPSHOT.view,
        agents: [
          agent({ name: "worker-1", status: "busy", idle: true }),
          agent({ name: "reviewer-1", paneId: "%2", status: "needs_input" }),
        ],
      },
      inProgress: [
        task({ name: "build_x", ownerName: "worker-1" }),
        task({ name: "review_x", title: "Review X", ownerName: "reviewer-1" }),
      ],
    };

    const text = renderCardToText(AgentsCard({ snapshot }));
    expect(text).toContain("Agents");
    expect(text).toContain("1 busy · 1 needs_input");
    expectTextOnce(text, "worker-1");
    expectTextOnce(text, "reviewer-1");
    expectTextOnce(text, "build_x");
    expectTextOnce(text, "review_x");
    expectTextOnce(text, "⚠ idle");
  });

  it("no '—' idle placeholder — exception-only render per nit_tui_agents_card_drop_idle_placeholder", () => {
    const snapshot: WorkstreamSnapshot = {
      ...EMPTY_SNAPSHOT,
      view: { ...EMPTY_SNAPSHOT.view, agents: [agent()] },
    };
    const text = renderCardToText(AgentsCard({ snapshot }));
    expect(text).not.toContain("⚠ idle");
    // The owned-task summary legitimately renders "—" when the agent
    // owns no tasks; the idle column itself should render no glyph.
    expect(text.endsWith("—")).toBe(true);
  });
});
