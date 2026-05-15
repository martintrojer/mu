import { describe, expect, it } from "vitest";
import type { AgentRow } from "../src/agents.js";
import { AgentsCard } from "../src/cli/tui/cards/agents.js";
import { BlockedCard } from "../src/cli/tui/cards/blocked.js";
import { CommitsCard } from "../src/cli/tui/cards/commits.js";
import { DoctorCard } from "../src/cli/tui/cards/doctor.js";
import { InProgressCard } from "../src/cli/tui/cards/inprogress.js";
import { LogCard } from "../src/cli/tui/cards/log.js";
import { ReadyCard } from "../src/cli/tui/cards/ready.js";
import { RecentCard } from "../src/cli/tui/cards/recent.js";
import { TracksCard } from "../src/cli/tui/cards/tracks.js";
import { WorkspacesCard } from "../src/cli/tui/cards/workspaces.js";
import { CARD_CONFIGS, type CardId } from "../src/cli/tui/layout.js";
import type { Db } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import type { TaskRow } from "../src/tasks.js";
import { renderCardToText } from "./_card-render.js";

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

const UNUSED_DB = undefined as unknown as Db;

interface CardCase {
  id: CardId;
  name: string;
  render: (rowBudget: number) => JSX.Element;
}

const CARD_CASES: CardCase[] = [
  {
    id: 0,
    name: "Commits",
    render: (rowBudget) => CommitsCard({ snapshot: null, rowBudget, cols: 80 }),
  },
  {
    id: 1,
    name: "Agents",
    render: (rowBudget) => AgentsCard({ snapshot: null, rowBudget, cols: 80 }),
  },
  {
    id: 2,
    name: "Tracks",
    render: (rowBudget) => TracksCard({ snapshot: null, rowBudget, cols: 80 }),
  },
  {
    id: 3,
    name: "Ready",
    render: (rowBudget) => ReadyCard({ snapshot: null, rowBudget, cols: 80 }),
  },
  {
    id: 4,
    name: "Activity log",
    render: (rowBudget) => LogCard({ snapshot: null, rowBudget, cols: 80 }),
  },
  {
    id: 5,
    name: "Workspaces",
    render: (rowBudget) => WorkspacesCard({ snapshot: null, rowBudget, cols: 80 }),
  },
  {
    id: 6,
    name: "In-progress",
    render: (rowBudget) => InProgressCard({ snapshot: null, rowBudget, cols: 80 }),
  },
  {
    id: 7,
    name: "Blocked",
    render: (rowBudget) =>
      BlockedCard({ snapshot: null, db: UNUSED_DB, workstream: "demo", rowBudget, cols: 80 }),
  },
  {
    id: 8,
    name: "Recent",
    render: (rowBudget) => RecentCard({ snapshot: null, rowBudget, cols: 80 }),
  },
  {
    id: 9,
    name: "Doctor",
    render: (rowBudget) => DoctorCard({ snapshot: null, rowBudget, cols: 80 }),
  },
];

function numberTokens(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

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
  for (const card of CARD_CASES) {
    it(`${card.name} passes exactly chrome + rowBudget as its fixed height`, () => {
      const rowBudget = CARD_CONFIGS[card.id].minRows + 4;
      const text = renderCardToText(card.render(rowBudget));
      const tokens = numberTokens(text);
      expect(tokens).toContain(String(CARD_CONFIGS[card.id].chrome + rowBudget));
      expect(tokens).toContain(String(rowBudget));
    });
  }

  it("cards with empty data still expose their dynamic row budget in the render tree", () => {
    const text = renderCardToText(ReadyCard({ snapshot: EMPTY_SNAPSHOT, rowBudget: 3 }));
    expect(text).toContain("(no ready tasks)");
    const tokens = numberTokens(text);
    expect(tokens).toContain(String(CARD_CONFIGS[3].chrome + 3));
    expect(tokens).toContain("3");
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
