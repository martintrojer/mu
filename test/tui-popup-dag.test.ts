import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cellWidth } from "../src/cli/tui/columns.js";
import {
  DagPopup,
  buildDagBody,
  dagYankCommand,
  truncateDagBody,
} from "../src/cli/tui/popups/dag.js";
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

  it("omits task titles from DAG popup nodes", () => {
    const db = fixtureDb();
    addTask(db, {
      workstream: "demo",
      localId: "compact_node",
      title: "FEAT: recognisable summary line that should not render",
      impact: 50,
      effortDays: 1,
    });

    const body = buildDagBody(db, "demo", new Set(TASK_STATUSES));

    expect(body.body).toContain("compact_node");
    expect(body.body).toContain("OPEN");
    expect(body.body).not.toContain("FEAT: recognisable summary line");
  });

  it("truncates long DAG lines to the popup content width with a safety margin", () => {
    const db = fixtureDb();
    const longRoot = `root_${"x".repeat(58)}`;
    addTask(db, {
      workstream: "demo",
      localId: longRoot,
      title: "title should be omitted before truncation",
      impact: 50,
      effortDays: 1,
    });
    const contentWidth = 30;

    const body = buildDagBody(db, "demo", new Set(TASK_STATUSES), contentWidth);
    const lines = body.body.split("\n");

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toBeDefined();
    expect(cellWidth(line ?? "")).toBeLessThanOrEqual(contentWidth - 1);
    expect(line).toContain("…");
  });

  it("truncateDagBody clips each logical line without adding wrapped rows", () => {
    const body = ["a".repeat(40), `${"b".repeat(40)}  CLOSED`].join("\n");
    const clipped = truncateDagBody(body, 12);
    const lines = clipped.split("\n");

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(cellWidth(line)).toBeLessThanOrEqual(11);
      expect(line).toContain("…");
    }
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
    expect(src).toContain("includeTitle: false");
    expect(src).toContain("truncateDagBody(body, contentWidth)");
    expect(src).not.toContain("<TitledBox");
  });

  it("yank helper produces the focused task tree command", () => {
    expect(dagYankCommand("root_a", "demo")).toBe("mu task tree root_a -w demo");
  });
});
