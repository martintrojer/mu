// Tests for src/cli/tui/cards/blocked.tsx (feat_card_7_blocked,
// workstream `tui-impl`). ink-testing-library is not installable in
// this environment so we lean on:
//   - calling the FC as a plain function (catches import-graph drift),
//   - asserting on the pure helpers (glyphFor, stillGating,
//     pickTopBlocker, formatSubtitle).
//
// Mirrors test/tui-card-inprogress.test.ts and
// test/tui-card-workspaces.test.ts.

import { describe, expect, it } from "vitest";
import {
  BlockedCard,
  formatSubtitle,
  glyphFor,
  pickTopBlocker,
  stillGating,
} from "../src/cli/tui/cards/blocked.js";
import type { Db } from "../src/db.js";
import type { TaskEdgeWithStatus, TaskRow } from "../src/tasks.js";

const EMPTY_SNAPSHOT = {
  workstreamName: "demo",
  view: { agents: [], orphans: [], report: { reaped: [], pruned: [] } },
  tracks: [],
  ready: [],
  inProgress: [],
  blocked: [],
  recentClosed: [],
  workspaces: [],
  workspaceOrphans: [],
  recent: [],
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

// Stub Db that returns a controllable per-task blocker list when the
// card calls getTaskEdgesWithStatus(db, name, ws). We don't need to
// actually plumb getTaskEdgesWithStatus through a stub: the FC is
// allowed to call into the SDK, but here we exercise it ONLY for the
// null-snapshot + empty-list branches (which never touch db). The
// populated-rows branch is exercised via the pure helpers below.
const STUB_DB = null as unknown as Db;

describe("BlockedCard", () => {
  it("is exported as a function", () => {
    expect(typeof BlockedCard).toBe("function");
  });

  it("renders a placeholder for null snapshot (loading state)", () => {
    const result = BlockedCard({ snapshot: null, db: STUB_DB, workstream: "demo" });
    expect(result).toBeTruthy();
  });

  it("renders the empty-state hint when no blocked tasks exist", () => {
    const result = BlockedCard({
      snapshot: EMPTY_SNAPSHOT,
      db: STUB_DB,
      workstream: "demo",
    });
    expect(result).toBeTruthy();
  });
});

describe("BlockedCard pure helpers", () => {
  it("glyphFor: every blocked row gets the chain-link glyph", () => {
    const g = glyphFor(task());
    expect(typeof g).toBe("string");
    expect(g.length).toBeGreaterThan(0);
    expect(g.length).toBeLessThanOrEqual(4);
    // Pin the actual codepoint — chain link U+26D3.
    expect(g).toBe("⛓");
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
    // All three appear once → alphabetic min wins.
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

// feat_card_footer_inset: bottom-border inset replaces the in-body
// "+M more · …" line. Crude regex on the source is enough.
import { readFileSync as _readFileSync_blocked } from "node:fs";
import { fileURLToPath as _fileURLToPath_blocked } from "node:url";
const _SRC_blocked = _readFileSync_blocked(
  _fileURLToPath_blocked(new URL("../src/cli/tui/cards/blocked.tsx", import.meta.url)),
  "utf8",
);
describe("blocked.tsx source: no in-body '+M more' line", () => {
  it("does not render '+{...} more' as a body Text node", () => {
    expect(_SRC_blocked).not.toMatch(/<Text[^>]*>\s*\u2026\s*\+/);
    expect(_SRC_blocked).not.toMatch(/<Text[^>]*>[^<]*\+\${[^}]+\}\s*more/);
  });
  it("wires bottomLabel into TitledBox", () => {
    expect(_SRC_blocked).toMatch(/bottomLabel=\{bottomLabel\}/);
  });
});
