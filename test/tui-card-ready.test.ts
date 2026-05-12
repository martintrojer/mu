import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ReadyCard } from "../src/cli/tui/cards/ready.js";
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
    name: "task_01",
    workstreamName: "demo",
    title: "Task 01",
    status: "OPEN",
    impact: 80,
    effortDays: 1,
    ownerName: null,
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

describe("ReadyCard", () => {
  it("is exported as a function", () => {
    expect(typeof ReadyCard).toBe("function");
  });

  it("renders the loading title row", () => {
    const text = renderCardToText(ReadyCard({ snapshot: null }));
    expect(text).toContain("Ready");
    expect(text).toContain("loading…");
  });

  it("renders the empty-state hint text", () => {
    const text = renderCardToText(ReadyCard({ snapshot: EMPTY_SNAPSHOT }));
    expect(text).toContain("Ready");
    expect(text).toContain(
      "(no ready tasks) every blocker is OPEN/IN_PROGRESS or every task is closed",
    );
  });

  it("renders title subtitle plus every task name and ROI label exactly once", () => {
    const snapshot: WorkstreamSnapshot = {
      ...EMPTY_SNAPSHOT,
      ready: [
        task({ name: "build_x", title: "Build X", impact: 80, effortDays: 1 }),
        task({ name: "review_x", title: "Review X", impact: 45, effortDays: 0.5 }),
        task({ name: "ship_x", title: "Ship X", impact: 30, effortDays: 1 }),
      ],
    };

    const text = renderCardToText(ReadyCard({ snapshot }));
    expect(text).toContain("Ready");
    expect(text).toContain("3");
    for (const [name, title, roi] of [
      ["build_x", "Build X", "ROI 80"],
      ["review_x", "Review X", "ROI 90"],
      ["ship_x", "Ship X", "ROI 30"],
    ] as const) {
      expectTextOnce(text, name);
      expectTextOnce(text, title);
      expectTextOnce(text, roi);
    }
  });

  it("truncates at ROW_LIMIT with the bottomLabel '+N more · Shift+3'", () => {
    const ready = Array.from({ length: 12 }, (_, i) => {
      const n = String(i + 1).padStart(2, "0");
      return task({ name: `ready_${n}`, title: `Ready ${n}`, impact: 80 + i, effortDays: 1 });
    });
    const text = renderCardToText(ReadyCard({ snapshot: { ...EMPTY_SNAPSHOT, ready } }));

    expect(text).toContain("+2 more · Shift+3");
    for (let i = 1; i <= 10; i++) {
      expectTextOnce(text, `ready_${String(i).padStart(2, "0")}`);
    }
    expectTextAbsent(text, "ready_11");
    expectTextAbsent(text, "ready_12");
  });
});

// feat_card_footer_inset: the truncation hint is now inset into the
// bottom border via TitledBox.bottomLabel — the source MUST NOT
// render an in-body "+M more · …" line. Crude regex on the source
// is enough; the bottomLabel wire-up is asserted by tui-titled-box.
const SRC = readFileSync(
  fileURLToPath(new URL("../src/cli/tui/cards/ready.tsx", import.meta.url)),
  "utf8",
);
describe("ReadyCard source: no in-body '+M more' line", () => {
  it("does not render '+{...} more' as a body Text node", () => {
    expect(SRC).not.toMatch(/<Text[^>]*>\s*\u2026\s*\+/);
    expect(SRC).not.toMatch(/<Text[^>]*>[^<]*\+\$\{[^}]+\}\s*more/);
  });
  it("wires bottomLabel into TitledBox", () => {
    expect(SRC).toMatch(/bottomLabel=\{bottomLabel\}/);
  });
});
