// Tests for src/cli/tui/cards/blocked.tsx (feat_card_7_blocked,
// workstream `tui-impl`).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlockedCard,
  formatSubtitle,
  glyphFor,
  pickTopBlocker,
  stillGating,
} from "../src/cli/tui/cards/blocked.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { type TaskEdgeWithStatus, type TaskRow, addBlockEdge, addTask } from "../src/tasks.js";
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
    name: "review_x",
    workstreamName: "demo",
    title: "Review X",
    status: "OPEN",
    impact: 75,
    effortDays: 1,
    ownerName: null,
    createdAt: "2026-05-11T00:00:00Z",
    updatedAt: "2026-05-11T00:00:00Z",
    ...over,
  };
}

let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-card-blocked-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function addBlockedFixture(db: Db): void {
  addTask(db, {
    workstream: "demo",
    localId: "design_x",
    title: "Design X",
    impact: 20,
    effortDays: 1,
  });
  addTask(db, {
    workstream: "demo",
    localId: "spec_x",
    title: "Spec X",
    impact: 20,
    effortDays: 1,
  });
  for (const id of ["review_x", "cherry_x", "ship_x"] as const) {
    addTask(db, {
      workstream: "demo",
      localId: id,
      title: id,
      impact: 75,
      effortDays: 1,
    });
    addBlockEdge(db, "demo", id, "design_x");
  }
  addBlockEdge(db, "demo", "review_x", "spec_x");
}

describe("BlockedCard", () => {
  it("is exported as a function", () => {
    expect(typeof BlockedCard).toBe("function");
  });

  it("renders the loading title row", () => {
    const text = renderCardToText(
      BlockedCard({ snapshot: null, db: fixtureDb(), workstream: "demo" }),
    );
    expect(text).toContain("Blocked");
    expect(text).toContain("loading…");
  });

  it("renders the empty-state hint text", () => {
    const text = renderCardToText(
      BlockedCard({ snapshot: EMPTY_SNAPSHOT, db: fixtureDb(), workstream: "demo" }),
    );
    expect(text).toContain("Blocked");
    expect(text).toContain("(none blocked)");
  });

  it("renders title subtitle plus every task name, ROI label, and glyph exactly once", () => {
    const db = fixtureDb();
    addBlockedFixture(db);
    const blocked = [
      task({ name: "review_x", title: "Review X", impact: 75, effortDays: 1 }),
      task({ name: "cherry_x", title: "Cherry X", impact: 40, effortDays: 0.5 }),
      task({ name: "ship_x", title: "Ship X", impact: 30, effortDays: 1 }),
    ];
    const text = renderCardToText(
      BlockedCard({ snapshot: { ...EMPTY_SNAPSHOT, blocked }, db, workstream: "demo" }),
    );

    expect(text).toContain("Blocked");
    expect(text).toContain("3 · top blocker: design_x");
    for (const [name, title, roi] of [
      ["review_x", "Review X", "75"],
      ["cherry_x", "Cherry X", "80"],
      ["ship_x", "Ship X", "30"],
    ] as const) {
      expectTextOnce(text, name);
      expectTextOnce(text, title);
      expectTextOnce(text, roi);
    }
    expect(text.split("⛓").length - 1).toBe(3);
  });

  it("truncates at ROW_LIMIT with the bottomLabel '+N more · Shift+7'", () => {
    const db = fixtureDb();
    addTask(db, {
      workstream: "demo",
      localId: "blocker",
      title: "Blocker",
      impact: 20,
      effortDays: 1,
    });
    const blocked = Array.from({ length: 10 }, (_, i) => {
      const name = `blocked_${i + 1}`;
      addTask(db, { workstream: "demo", localId: name, title: name, impact: 50, effortDays: 1 });
      addBlockEdge(db, "demo", name, "blocker");
      return task({ name, title: `Blocked ${i + 1}` });
    });
    const text = renderCardToText(
      BlockedCard({ snapshot: { ...EMPTY_SNAPSHOT, blocked }, db, workstream: "demo" }),
    );

    expect(text).toContain("+2 more · Shift+7");
    for (let i = 1; i <= 8; i++) expectTextOnce(text, `blocked_${i}`);
    expectTextAbsent(text, "blocked_9");
    expectTextAbsent(text, "blocked_10");
  });
});

describe("BlockedCard pure helpers", () => {
  it("glyphFor: every blocked row gets the chain-link glyph", () => {
    // Argumentless per review_dead_code_glyph_for_unused: the glyph
    // never depended on the row, so the previous TaskRow parameter
    // was an anticipatory abstraction (AGENTS.md ban).
    const g = glyphFor();
    expect(typeof g).toBe("string");
    expect(g.length).toBeGreaterThan(0);
    expect(g.length).toBeLessThanOrEqual(4);
    expect(g).toBe("⛓");
  });

  it("glyphFor: takes no arguments (review_dead_code_glyph_for_unused)", () => {
    expect(glyphFor.length).toBe(0);
  });

  it("stillGating: drops CLOSED blockers; keeps OPEN/IN_PROGRESS/REJECTED/DEFERRED", () => {
    const blockers: TaskEdgeWithStatus[] = [
      { name: "a", status: "CLOSED" },
      { name: "b", status: "OPEN" },
      { name: "c", status: "IN_PROGRESS" },
      { name: "d", status: "REJECTED" },
      { name: "e", status: "DEFERRED" },
      { name: "f", status: "CLOSED" },
    ];
    const out = stillGating(blockers);
    expect(out.map((b) => b.name)).toEqual(["b", "c", "d", "e"]);
  });

  it("stillGating: empty input → empty output (no crash)", () => {
    expect(stillGating([])).toEqual([]);
  });

  it("pickTopBlocker: returns the most-shared blocker across rows", () => {
    const lists: TaskEdgeWithStatus[][] = [
      [
        { name: "design_x", status: "OPEN" },
        { name: "spec_x", status: "OPEN" },
      ],
      [{ name: "design_x", status: "OPEN" }],
      [
        { name: "design_x", status: "IN_PROGRESS" },
        { name: "review_y", status: "OPEN" },
      ],
    ];
    expect(pickTopBlocker(lists)).toBe("design_x");
  });

  it("pickTopBlocker: ties broken alphabetically", () => {
    const lists: TaskEdgeWithStatus[][] = [
      [{ name: "zeta", status: "OPEN" }],
      [{ name: "alpha", status: "OPEN" }],
      [{ name: "mu", status: "OPEN" }],
    ];
    expect(pickTopBlocker(lists)).toBe("alpha");
  });

  it("pickTopBlocker: empty input → null", () => {
    expect(pickTopBlocker([])).toBeNull();
    expect(pickTopBlocker([[], []])).toBeNull();
  });

  it("formatSubtitle: total only when no top blocker", () => {
    expect(formatSubtitle(0, null)).toBe("0");
    expect(formatSubtitle(3, null)).toBe("3");
  });

  it("formatSubtitle: appends top blocker when present", () => {
    expect(formatSubtitle(3, "design_x")).toBe("3 · top blocker: design_x");
    expect(formatSubtitle(7, "spec_x")).toBe("7 · top blocker: spec_x");
  });
});

// feat_card_footer_inset assertions live in test/tui-card-footer-inset.test.ts
// (single sweep across cards/*) — see review_tests_inline_card_source_blocks.
