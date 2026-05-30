import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AllTasksPopup,
  type BlockedFilterMode,
  allTasksFromSnapshotOrDb,
  allTasksListTitle,
  allTasksScrollPercent,
  allTasksYankCommand,
  applyBlockedFilter,
  nextBlockedFilter,
  nextTaskSortKey,
  sortIndicator,
} from "../src/cli/tui/popups/all-tasks.js";
import { applyCursor, centredVisibleSlice } from "../src/cli/tui/popups/scroll.js";
import { type Db, openDb } from "../src/db.js";
import type { WorkstreamSnapshot } from "../src/state.js";
import { type TaskRow, addTask, listTasks, setTaskStatus } from "../src/tasks.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { sortTasks } from "../src/tasks/sort.js";
import { TASK_STATUSES } from "../src/tasks/status.js";
import {
  CaptureStream,
  createInkCaptureStream,
  createInkInputStream,
  latestRenderedFrame,
  simulateInput,
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
    expect(taskRows).toHaveLength(14);
    expect(taskRows.map((line) => line.match(/task_\d{3}/)?.[0])).toEqual(
      Array.from({ length: 14 }, (_, i) => `task_${String(i + 93).padStart(3, "0")}`),
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

  // Regression for bug_filter_drill_opens_wrong_task: with the '/'
  // text filter active, pressing Enter on the cursor row must drill
  // into the matched-and-cursored task — NOT a task at the same
  // index in the unfiltered set. The pre-fix code dropped the text
  // filter on mode === "drill", which shifted visibleTasks under a
  // constant cursor and resolved the wrong task identity.
  it("with text filter 'abc', cursor at row 1 of [match0, match1, match2], Enter drills into match1", async () => {
    const db = fixtureDb();
    // 50 noise tasks then 3 "abc" matches sprinkled among them. We
    // pick three matches whose unfiltered indices are NOT 0, 1, 2 so
    // the pre-fix bug ("drill into unfiltered[1]") would land on a
    // visibly-different task than the filtered cursor target.
    // Noise tasks at HIGHER impact than abc_* matches so the
    // matches sort to the BOTTOM of the unfiltered ROI list. The
    // pre-fix bug landed unfiltered[1] = noise; this seed makes the
    // identity mismatch loud (drill title would say `noise_<X>`
    // instead of `abc_second`).
    for (let i = 0; i < 50; i++) {
      const id = `noise_${String(i).padStart(2, "0")}`;
      addTask(db, {
        workstream: "demo",
        localId: id,
        title: `noise task ${i}`,
        impact: 90,
        effortDays: 1,
      });
    }
    const matchIds = ["abc_first", "abc_second", "abc_third"];
    for (const id of matchIds) {
      addTask(db, {
        workstream: "demo",
        localId: id,
        title: `${id} matches`,
        impact: 10,
        effortDays: 1,
      });
    }
    const allTasks = sortTasks(listTasks(db, "demo"), "roi");

    const stdin = createInkInputStream();
    const stdout = createInkCaptureStream({ columns: 120, rows: 30 });
    const modeChanges: Array<"list" | "drill"> = [];
    let mode: "list" | "drill" = "list";
    const props = {
      yank: async () => {},
      onClose: () => {},
      snapshot: { allTasks } as WorkstreamSnapshot,
      fastTickNonce: 0,
      mode,
      onModeChange: (next: "list" | "drill") => {
        modeChanges.push(next);
        mode = next;
        instance.rerender(createElement(AllTasksPopup, { ...props, mode: next }));
      },
      db,
      workstream: "demo",
    };
    const instance = render(createElement(AllTasksPopup, props), {
      stdout,
      stdin,
      stderr: process.stderr,
      debug: false,
      patchConsole: false,
    });

    await waitForInkOutput(stdout);
    // Open '/', type "abc", commit. Char-by-char so the reducer
    // appends each printable individually (the helper writes the
    // whole string verbatim, but ink's parse-keypress only emits
    // one keypress per chunk and the reducer's appendChar guard
    // requires single chars).
    await simulateInput(stdin, "/");
    await simulateInput(stdin, "a");
    await simulateInput(stdin, "b");
    await simulateInput(stdin, "c");
    await simulateInput(stdin, "enter");
    await waitForInkOutput(stdout);
    // Move cursor down once → should now sit on the SECOND match
    // (sort:roi puts the three abc_* matches first because they have
    // the highest impact).
    await simulateInput(stdin, "j");
    await waitForInkOutput(stdout);
    // Snapshot the list-mode title to confirm we are on visible row 2/3.
    const listFrame = latestRenderedFrame(stdout).join("\n");
    expect(listFrame).toContain("All tasks · popup (2/3)");
    expect(listFrame).toContain("filter: 3 of 53");
    // The cursored row in the filtered view is `abc_second`. The
    // unfiltered position-1 row is `noise_01` (high impact) — used
    // by the assertion below to prove the drill DID NOT shift to
    // unfiltered[1] under the pre-fix bug.
    expect(allTasks[1]?.name).toMatch(/^noise_/);
    // Press Enter → drill. The drill title MUST contain the abc match
    // identity, not a task from the unfiltered position-1 set
    // (the pre-fix bug would have surfaced "noise_01" or similar
    // here because dropping the text filter made visibleTasks shift
    // back to all 53 rows).
    await simulateInput(stdin, "enter");
    await waitForInkOutput(stdout);
    expect(modeChanges).toEqual(["drill"]);
    const drillFrame = latestRenderedFrame(stdout).join("\n");
    expect(drillFrame).toContain("abc_second");
    expect(drillFrame).not.toMatch(/All tasks · noise_/);
    instance.unmount();
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
    expect(text).toContain("task_106");
    expect(text).not.toContain("task_107");
    expect(text).not.toContain("task_199");
  });

  // ─── Blocked indicator + filter ──────────────────────────────────

  it("nextBlockedFilter cycles all → only → hide → all", () => {
    expect(nextBlockedFilter("all")).toBe("only");
    expect(nextBlockedFilter("only")).toBe("hide");
    expect(nextBlockedFilter("hide")).toBe("all");
  });

  it("applyBlockedFilter filters correctly in each mode", () => {
    const tasks = [{ name: "a" }, { name: "b" }, { name: "c" }];
    const blockedNames = new Set(["b"]);
    expect(applyBlockedFilter(tasks, blockedNames, "all").map((t) => t.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(applyBlockedFilter(tasks, blockedNames, "only").map((t) => t.name)).toEqual(["b"]);
    expect(applyBlockedFilter(tasks, blockedNames, "hide").map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("shows ⛓ glyph next to status for blocked tasks", async () => {
    const db = fixtureDb();
    addTask(db, {
      workstream: "demo",
      localId: "blocker",
      title: "Blocker",
      impact: 90,
      effortDays: 1,
    });
    addTask(db, {
      workstream: "demo",
      localId: "blocked",
      title: "Blocked",
      impact: 50,
      effortDays: 1,
    });
    addBlockEdge(db, "demo", "blocked", "blocker");

    const allTasks = sortTasks(listTasks(db, "demo"), "roi");
    const blocked = allTasks.filter((t) => t.name === "blocked");

    const stdin = createInkInputStream();
    const stdout = createInkCaptureStream({ columns: 120, rows: 20 });
    const instance = render(
      createElement(AllTasksPopup, {
        yank: async () => {},
        onClose: () => {},
        snapshot: { allTasks, blocked } as unknown as WorkstreamSnapshot,
        fastTickNonce: 0,
        mode: "list",
        onModeChange: () => {},
        db,
        workstream: "demo",
      }),
      { stdout, stdin, stderr: process.stderr, debug: false, patchConsole: false },
    );
    await waitForInkOutput(stdout);
    const text = latestRenderedFrame(stdout).join("\n");
    // The blocked task should show the chain glyph in its status column
    expect(text).toMatch(/blocked.*OPEN ⛓/);
    // The non-blocked task should NOT show the chain glyph
    expect(text).toMatch(/blocker.*OPEN(?! ⛓)/);
    instance.unmount();
  });

  it("b key cycles through blocked filter modes and filters the list", async () => {
    const db = fixtureDb();
    addTask(db, {
      workstream: "demo",
      localId: "blocker",
      title: "Blocker",
      impact: 90,
      effortDays: 1,
    });
    addTask(db, {
      workstream: "demo",
      localId: "blocked_one",
      title: "Blocked One",
      impact: 50,
      effortDays: 1,
    });
    addBlockEdge(db, "demo", "blocked_one", "blocker");

    const allTasks = sortTasks(listTasks(db, "demo"), "roi");
    const blocked = allTasks.filter((t) => t.name === "blocked_one");

    const stdin = createInkInputStream();
    const stdout = createInkCaptureStream({ columns: 120, rows: 20 });
    const instance = render(
      createElement(AllTasksPopup, {
        yank: async () => {},
        onClose: () => {},
        snapshot: { allTasks, blocked } as unknown as WorkstreamSnapshot,
        fastTickNonce: 0,
        mode: "list",
        onModeChange: () => {},
        db,
        workstream: "demo",
      }),
      { stdout, stdin, stderr: process.stderr, debug: false, patchConsole: false },
    );
    await waitForInkOutput(stdout);

    // Initial: all tasks visible
    let text = latestRenderedFrame(stdout).join("\n");
    expect(text).toContain("blocker");
    expect(text).toContain("blocked_one");
    expect(text).toContain("filter: 2 of 2");

    // Press b → only blocked
    await simulateInput(stdin, "b");
    await waitForInkOutput(stdout);
    text = latestRenderedFrame(stdout).join("\n");
    expect(text).toContain("only blocked");
    expect(text).toContain("blocked_one");
    expect(text).toContain("filter: 1 of 2");

    // Press b → hide blocked
    await simulateInput(stdin, "b");
    await waitForInkOutput(stdout);
    text = latestRenderedFrame(stdout).join("\n");
    expect(text).toContain("hide blocked");
    expect(text).toContain("blocker");
    expect(text).toContain("filter: 1 of 2");

    // Press b → back to all
    await simulateInput(stdin, "b");
    await waitForInkOutput(stdout);
    text = latestRenderedFrame(stdout).join("\n");
    expect(text).toContain("filter: 2 of 2");

    instance.unmount();
  });
});
