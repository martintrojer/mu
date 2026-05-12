import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DagPopup, dagYankCommand } from "../src/cli/tui/popups/dag.js";
import { loadFullDag, renderForest } from "../src/dag.js";
import { type Db, openDb } from "../src/db.js";
import { type TaskRow, addBlockEdge, addTask } from "../src/tasks.js";

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

  it("delegates chrome and body rendering through PopupShell + DrillScrollView", () => {
    const src = readFileSync("./src/cli/tui/popups/dag.tsx", "utf8");
    expect(src).toContain('import { PopupShell } from "../popup-shell.js"');
    expect(src).toContain("<PopupShell");
    expect(src).toContain("<DrillScrollView");
    expect(src).toContain("useDrillKeymap");
    expect(src).not.toContain("<TitledBox");
  });

  it("yank helper produces the focused task tree command", () => {
    expect(dagYankCommand("root_a", "demo")).toBe("mu task tree root_a -w demo");
  });
});
