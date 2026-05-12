import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AllTasksPopup,
  allTasksFromSnapshotOrDb,
  allTasksYankCommand,
  nextTaskSortKey,
  sortIndicator,
} from "../src/cli/tui/popups/all-tasks.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { type TaskRow, addTask, listTasks, setTaskStatus } from "../src/tasks.js";
import { sortTasks } from "../src/tasks/sort.js";
import { TASK_STATUSES } from "../src/tasks/status.js";

let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-all-tasks-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function seedOnePerStatus(db: Db): void {
  for (const [id, status, impact, effortDays] of [
    ["open", "OPEN", 50, 1],
    ["in_progress", "IN_PROGRESS", 90, 1],
    ["closed", "CLOSED", 20, 1],
    ["rejected", "REJECTED", 10, 1],
    ["deferred", "DEFERRED", 30, 1],
  ] as const) {
    addTask(db, { workstream: "demo", localId: id, title: id, impact, effortDays });
    if (status !== "OPEN") setTaskStatus(db, id, status, { workstream: "demo" });
  }
}

describe("AllTasksPopup", () => {
  it("is exported as a function", () => {
    expect(typeof AllTasksPopup).toBe("function");
  });

  it("initial data contains every task across statuses and sorts by ROI desc", async () => {
    const db = fixtureDb();
    seedOnePerStatus(db);

    const allTasks = listTasks(db, "demo");
    const sorted = sortTasks(allTasks, "roi");

    expect(allTasks.map((t) => t.status).sort()).toEqual([...TASK_STATUSES].sort());
    expect(sorted.map((t) => t.name)).toEqual([
      "in_progress",
      "open",
      "deferred",
      "closed",
      "rejected",
    ]);
  });

  it("falls back to listTasks(db, workstream) when snapshot.allTasks is not populated", () => {
    const db = fixtureDb();
    seedOnePerStatus(db);
    const snapshot = { allTasks: [] } as WorkstreamSnapshot;

    expect(allTasksFromSnapshotOrDb(snapshot, db, "demo").map((t) => t.name)).toEqual([
      "closed",
      "deferred",
      "in_progress",
      "open",
      "rejected",
    ]);
  });

  it("pressing c hides CLOSED tasks (same status-filter semantics as DAG)", async () => {
    const db = fixtureDb();
    seedOnePerStatus(db);
    const allTasks = listTasks(db, "demo");
    const statuses = new Set(TASK_STATUSES);
    statuses.delete("CLOSED");

    const visible = sortTasks(
      allTasks.filter((t: TaskRow) => statuses.has(t.status)),
      "roi",
    );

    expect(visible.map((t) => t.name)).not.toContain("closed");
    expect(visible.map((t) => t.name)).toEqual(["in_progress", "open", "deferred", "rejected"]);
  });

  it("pressing s cycles sort key and the sort indicator updates", () => {
    expect(nextTaskSortKey("roi")).toBe("recency");
    expect(nextTaskSortKey("recency")).toBe("age");
    expect(nextTaskSortKey("age")).toBe("id");
    expect(nextTaskSortKey("id")).toBe("roi");
    expect(sortIndicator("roi")).toContain("sort: [s]ort=roi ↓");
    expect(sortIndicator("recency")).toContain("updated");
  });

  it("y yanks `mu task show <id>` for the focused row", () => {
    expect(allTasksYankCommand("open", "demo")).toBe("mu task show open -w demo");
  });

  it("source wires Enter to TaskDetailDrill through the standard task-list popup pattern", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/all-tasks.tsx", "utf-8");
    expect(src).toContain("TaskDetailDrill");
    expect(src).toContain("renderNotes");
    expect(src).toContain('onModeChange("drill")');
    expect(src).toContain('onModeChange("list")');
  });

  it("reuses useStatusFilter + StatusFilterStrip and sortTasks from src/tasks/sort", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/all-tasks.tsx", "utf-8");
    expect(src).toContain("useStatusFilter");
    expect(src).toContain("StatusFilterStrip");
    expect(src).toContain('from "../../../tasks/sort.js"');
    expect(src).not.toContain('from "../../../cli.js"');
  });
});
