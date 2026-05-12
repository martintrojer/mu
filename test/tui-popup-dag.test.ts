import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DagPopup, buildDagBody, dagYankCommand } from "../src/cli/tui/popups/dag.js";
import { loadFullDag, renderForest } from "../src/dag.js";
import { type Db, openDb } from "../src/db.js";
import { type TaskRow, addBlockEdge, addTask, setTaskStatus } from "../src/tasks.js";
import { TASK_STATUSES } from "../src/tasks/status.js";

let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
});

function task(name: string, title = name): TaskRow {
  return {
    name,
    workstreamName: "demo",
    title,
    status: "OPEN",
    impact: 50,
    effortDays: 1,
    ownerName: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  };
}

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-tui-popup-dag-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function seedOnePerStatus(db: Db): void {
  for (const [id, status] of [
    ["open", "OPEN"],
    ["in_progress", "IN_PROGRESS"],
    ["closed", "CLOSED"],
    ["rejected", "REJECTED"],
    ["deferred", "DEFERRED"],
  ] as const) {
    addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
    if (status !== "OPEN") setTaskStatus(db, id, status, { workstream: "demo" });
  }
}

describe("renderForest", () => {
  it("renders a stable ASCII forest for multiple roots", () => {
    const roots = [task("root_a", "Root A"), task("root_b", "Root B"), task("root_c", "Root C")];
    const childA = task("child_a", "Child A");
    const childB = task("child_b", "Child B");
    const edges = new Map<string, string[]>([
      ["root_a", ["child_a", "child_b"]],
      ["root_b", []],
      ["root_c", []],
    ]);
    const tasksByName = new Map([...roots, childA, childB].map((t) => [t.name, t]));

    const out = renderForest(roots, edges, (t) => t.status, tasksByName);

    expect(out).toBe(
      [
        "root_a  OPEN  Root A",
        "├── child_a  OPEN  Child A",
        "└── child_b  OPEN  Child B",
        "",
        "root_b  OPEN  Root B",
        "",
        "root_c  OPEN  Root C",
      ].join("\n"),
    );
  });
});

describe("DagPopup", () => {
  it("is exported as a function", () => {
    expect(typeof DagPopup).toBe("function");
  });

  it("loads every root and edge for the current workstream", () => {
    const db = fixtureDb();
    for (const id of ["root_a", "root_b", "root_c", "child_a", "child_b"] as const) {
      addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
    }
    addBlockEdge(db, "demo", "child_a", "root_a");
    addBlockEdge(db, "demo", "child_b", "root_a");

    const dag = loadFullDag(db, "demo");

    expect(dag.roots.map((t) => t.name)).toEqual(["root_a", "root_b", "root_c"]);
    expect(dag.edges.get("root_a")).toEqual(["child_a", "child_b"]);
  });

  it("passes all statuses by default (existing DAG popup behaviour)", () => {
    const db = fixtureDb();
    seedOnePerStatus(db);

    const body = buildDagBody(db, "demo", new Set(TASK_STATUSES));

    expect(body.roots).toEqual(["closed", "deferred", "in_progress", "open", "rejected"]);
    expect(body.body).toContain("open");
    expect(body.body).toContain("in_progress");
    expect(body.body).toContain("closed");
    expect(body.body).toContain("CLOSED");
    expect(body.body).toContain("rejected");
    expect(body.body).toContain("deferred");
  });

  it("pressing c hides CLOSED tasks from the DAG body", () => {
    const db = fixtureDb();
    seedOnePerStatus(db);
    const statuses = new Set(TASK_STATUSES);
    statuses.delete("CLOSED");

    const body = buildDagBody(db, "demo", statuses);

    expect(body.roots).toEqual(["deferred", "in_progress", "open", "rejected"]);
    expect(body.body).not.toContain("closed");
    expect(body.body).toContain("open");
    expect(body.body).toContain("in_progress");
    expect(body.body).toContain("rejected");
    expect(body.body).toContain("deferred");
  });

  it("filter strip source reflects toggled status state", () => {
    const src = readFileSync("./src/cli/tui/use-status-filter.tsx", "utf8");
    expect(src).toContain("filters: ");
    expect(src).toContain('enabled ? "●" : "○"');
    expect(src).toContain('CLOSED: { key: "C", rest: "losed" }');
  });

  it("delegates chrome and body rendering through PopupShell + DrillScrollView", () => {
    const src = readFileSync("./src/cli/tui/popups/dag.tsx", "utf8");
    expect(src).toContain('import { PopupShell } from "../popup-shell.js"');
    expect(src).toContain("<PopupShell");
    expect(src).toContain("<DrillScrollView");
    expect(src).toContain("useDrillKeymap");
    expect(src).toContain("<StatusFilterStrip");
    expect(src).not.toContain("<TitledBox");
  });

  it("yank helper produces the focused task tree command", () => {
    expect(dagYankCommand("root_a", "demo")).toBe("mu task tree root_a -w demo");
  });
});
