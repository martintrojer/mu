import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/tasks.js";
import { TASK_SORT_KEYS, type TaskSortKey, sortTasks } from "../src/tasks/sort.js";

function row(over: {
  name: string;
  impact: number;
  effortDays: number;
  createdAt: string;
  updatedAt: string;
}): TaskRow {
  return {
    name: over.name,
    workstreamName: "ws",
    title: over.name,
    status: "OPEN",
    impact: over.impact,
    effortDays: over.effortDays,
    ownerName: null,
    createdAt: over.createdAt,
    updatedAt: over.updatedAt,
  };
}

// a: low ROI (10/2 = 5), oldest, most recently touched
const rowA = row({
  name: "a",
  impact: 10,
  effortDays: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-05-01T00:00:00.000Z",
});
// b: high ROI (90/1 = 90), middle, middle touched
const rowB = row({
  name: "b",
  impact: 90,
  effortDays: 1,
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
});
// c: med ROI (40/2 = 20), newest, least recently touched
const rowC = row({
  name: "c",
  impact: 40,
  effortDays: 2,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const rows = [rowA, rowB, rowC];

describe("sortTasks", () => {
  it("roi: highest impact/effort first (default for next/ready)", () => {
    expect(sortTasks(rows, "roi").map((t) => t.name)).toEqual(["b", "c", "a"]);
  });

  it("roi: ties by smaller effort, then id", () => {
    const x = row({
      name: "x",
      impact: 20,
      effortDays: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const y = row({
      name: "y",
      impact: 10,
      effortDays: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const z = row({
      name: "z",
      impact: 10,
      effortDays: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(sortTasks([z, x, y], "roi").map((t) => t.name)).toEqual(["y", "z", "x"]);
  });

  it("roi: zero-effort rows sort to the top as infinity", () => {
    const zero = row({
      name: "zero",
      impact: 1,
      effortDays: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(sortTasks([rowB, zero], "roi").map((t) => t.name)).toEqual(["zero", "b"]);
  });

  it("recency: most-recently-updated first (updated_at DESC)", () => {
    expect(sortTasks(rows, "recency").map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("age: oldest-first (created_at ASC) — surfaces stale work", () => {
    expect(sortTasks(rows, "age").map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("id: local_id ASC — boring tiebreaker default for `task list`", () => {
    expect(sortTasks([rowC, rowA, rowB], "id").map((t) => t.name)).toEqual(["a", "b", "c"]);
  });

  it("returns a copy (does not mutate the input array)", () => {
    const input = [rowA, rowB, rowC];
    const before = input.slice();
    sortTasks(input, "roi");
    expect(input).toEqual(before);
  });
});

describe("TASK_SORT_KEYS", () => {
  it("exports the stable sort-key cycle order", () => {
    const expected: TaskSortKey[] = ["roi", "recency", "age", "id"];
    expect([...TASK_SORT_KEYS]).toEqual(expected);
  });
});
