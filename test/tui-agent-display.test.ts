import { describe, expect, it } from "vitest";
import type { AgentRow } from "../src/agents.js";
import {
  agentByName,
  agentStatusGlyph,
  formatAgentRefDisplayName,
  formatKnownAgentDisplayName,
} from "../src/cli/tui/agent-display.js";
import type { WorkstreamSnapshot } from "../src/state.js";

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

function snapshotWithAgents(agents: AgentRow[]): WorkstreamSnapshot {
  return {
    workstreamName: "demo",
    view: {
      agents,
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
}

describe("agent display helpers", () => {
  it("formats known agent rows with the status glyph", () => {
    const a = agent({ name: "worker-1", status: "busy" });

    expect(formatKnownAgentDisplayName(a)).toBe(`${agentStatusGlyph("busy")} worker-1`);
  });

  it("formats agent references with a glyph when the live agent is known", () => {
    const lookup = agentByName(
      snapshotWithAgents([agent({ name: "reviewer-1", status: "needs_input" })]),
    );

    expect(formatAgentRefDisplayName("reviewer-1", lookup)).toBe(
      `${agentStatusGlyph("needs_input")} reviewer-1`,
    );
  });

  it("keeps unknown agent references raw instead of inventing a status", () => {
    const lookup = agentByName(snapshotWithAgents([]));

    expect(formatAgentRefDisplayName("anonymous-worker", lookup)).toBe("anonymous-worker");
  });

  it("renders null agent references as an em dash", () => {
    expect(formatAgentRefDisplayName(null, agentByName(null))).toBe("—");
  });

  it("agentByName tolerates null and old partial snapshots", () => {
    expect(agentByName(null).size).toBe(0);
    expect(agentByName({} as WorkstreamSnapshot).size).toBe(0);
  });
});
