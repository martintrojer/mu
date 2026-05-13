import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AllTasksPopup,
  allTasksFromSnapshotOrDb,
  allTasksListTitle,
  allTasksScrollPercent,
  allTasksYankCommand,
  nextTaskSortKey,
  sortIndicator,
} from "../src/cli/tui/popups/all-tasks.js";
import { applyCursor, centredVisibleSlice } from "../src/cli/tui/popups/scroll.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { type TaskRow, addTask, listTasks, setTaskStatus } from "../src/tasks.js";
import { sortTasks } from "../src/tasks/sort.js";
import { TASK_STATUSES } from "../src/tasks/status.js";
import {
  CaptureStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  waitForInkOutput,
} from "./_ink-render.js";

let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  CaptureStream.cleanup();
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

function seedMany(db: Db, count: number): TaskRow[] {
  for (let i = 0; i < count; i++) {
    const id = `task_${String(i).padStart(3, "0")}`;
    addTask(db, {
      workstream: "demo",
      localId: id,
      title: `Task ${String(i).padStart(3, "0")}`,
      impact: 50,
      effortDays: 1,
    });
  }
  return sortTasks(listTasks(db, "demo"), "id");
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderAllTasksAfterMovingToCursor(opts: {
  db: Db;
  tasks: TaskRow[];
  cursor: number;
  rows: number;
}): Promise<{ lines: string[]; unmount: () => void }> {
  const stdin = createInkInputStream();
  const stdout = createInkCaptureStream({ columns: 120, rows: opts.rows });
  const instance = render(
    createElement(AllTasksPopup, {
      yank: async () => {},
      onClose: () => {},
      snapshot: { allTasks: opts.tasks } as WorkstreamSnapshot,
      fastTickNonce: 0,
      mode: "list",
      onModeChange: () => {},
      db: opts.db,
      workstream: "demo",
    }),
    { stdout, stdin, stderr: process.stderr, debug: false, patchConsole: false },
  );

  await waitForInkOutput(stdout);
  for (let i = 0; i < opts.cursor; i++) {
    stdin.write("j");
    await pause(1);
  }
  await waitForInkOutput(stdout);

  return { lines: latestRenderedFrame(stdout), unmount: () => instance.unmount() };
}

describe("AllTasksPopup", () => {
  it("is exported as a function", () => {
    expect(typeof AllTasksPopup).toBe("function");
  });

  it("initial data contains every task across statuses and sorts by ROI desc", () => {
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
    expect(allTasksFromSnapshotOrDb(null, db, "demo").map((t) => t.name)).toEqual([
      "closed",
      "deferred",
      "in_progress",
      "open",
      "rejected",
    ]);
  });

  it("pressing c hides CLOSED tasks (same status-filter semantics as DAG)", () => {
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

  it("renders a centred task window for a 200-task list with the cursor at 100", async () => {
    const db = fixtureDb();
    const tasks = seedMany(db, 200);

    const { lines, unmount } = await renderAllTasksAfterMovingToCursor({
      db,
      tasks,
      cursor: 100,
      rows: 20,
    });
    unmount();

    const taskRows = lines.filter((line) => /│ task_\d{3}/.test(line));
    expect(taskRows).toHaveLength(15);
    expect(taskRows.map((line) => line.match(/task_\d{3}/)?.[0])).toEqual(
      Array.from({ length: 15 }, (_, i) => `task_${String(i + 93).padStart(3, "0")}`),
    );
    expect(taskRows.at(7) ?? "").toContain("task_100");
    expect(lines.at(0) ?? "").toContain("All tasks · popup (101/200) · 50%");
    expect(lines.at(-1)).toContain("mu task show task_100 -w demo");
  });

  it("j/k navigation advances and retreats the rendered task window", () => {
    const db = fixtureDb();
    const tasks = seedMany(db, 200);
    const viewport = 15;

    let cursor = 0;
    let win = centredVisibleSlice(tasks, cursor, viewport);
    expect(win.start).toBe(0);
    expect(win.visible[0]?.name).toBe("task_000");

    for (let i = 0; i < 100; i++) {
      cursor = applyCursor(cursor, { kind: "moveDown" }, tasks.length, viewport);
    }
    win = centredVisibleSlice(tasks, cursor, viewport);
    expect(cursor).toBe(100);
    expect(win.start).toBe(93);
    expect(win.visible[0]?.name).toBe("task_093");
    expect(win.visible[7]?.name).toBe("task_100");

    for (let i = 0; i < 90; i++) {
      cursor = applyCursor(cursor, { kind: "moveUp" }, tasks.length, viewport);
    }
    win = centredVisibleSlice(tasks, cursor, viewport);
    expect(cursor).toBe(10);
    expect(win.start).toBe(3);
    expect(win.visible[0]?.name).toBe("task_003");
    expect(win.visible[7]?.name).toBe("task_010");
  });

  it("omits the title percent indicator when the filtered list fits the viewport", () => {
    expect(allTasksScrollPercent(0, 5, 15)).toBeNull();
    expect(allTasksListTitle(0, 5, 15)).toBe("All tasks · popup (1/5)");
  });

  it("y yanks `mu task show <id>` for the focused row", () => {
    expect(allTasksYankCommand("open", "demo")).toBe("mu task show open -w demo");
  });

  it("source wires Enter to TaskDetailDrill through the standard task-list popup pattern", () => {
    const src = readFileSync("./src/cli/tui/popups/all-tasks.tsx", "utf-8");
    expect(src).toContain("TaskDetailDrill");
    // Post-review_tui_task_popups_duplicated_template: the per-popup
    // renderNotes useMemo moved into the shared useNotesDrill hook.
    expect(src).toContain("useNotesDrill");
    expect(src).toContain('onModeChange("drill")');
    expect(src).toContain('onModeChange("list")');
  });

  it("reuses useStatusFilter + StatusFilterStrip and sortTasks from src/tasks/sort", () => {
    const src = readFileSync("./src/cli/tui/popups/all-tasks.tsx", "utf-8");
    expect(src).toContain("useStatusFilter");
    expect(src).toContain("StatusFilterStrip");
    expect(src).toContain('from "../../../tasks/sort.js"');
    expect(src).not.toContain('from "../../../cli.js"');
  });

  it("renders only the visible task window, not every filtered task", async () => {
    const db = fixtureDb();
    const tasks = seedMany(db, 200);

    const { lines, unmount } = await renderAllTasksAfterMovingToCursor({
      db,
      tasks,
      cursor: 100,
      rows: 20,
    });
    unmount();

    const text = lines.join("\n");
    expect(text).toContain("filter: 200 of 200");
    expect(text).not.toContain("visible / 200 total");
    expect(text).not.toContain("task_000");
    expect(text).not.toContain("task_092");
    expect(text).toContain("task_093");
    expect(text).toContain("task_107");
    expect(text).not.toContain("task_108");
    expect(text).not.toContain("task_199");
  });
});
