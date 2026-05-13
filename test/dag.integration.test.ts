import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatTreeNodeLabel, loadFullDag, renderForest, renderTaskTree } from "../src/dag.js";
import { type Db, openDb } from "../src/db.js";
import { addBlockEdge, addTask, setTaskStatus } from "../src/tasks.js";
import type { TaskStatus } from "../src/tasks/status.js";

let openDbs: Db[] = [];

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
});

function fixtureDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), "mu-dag-"));
  const db = openDb({ path: join(dir, "mu.db") });
  openDbs.push(db);
  return db;
}

function addTaskWithStatus(db: Db, id: string, status: TaskStatus, title: string = id): void {
  addTask(db, { workstream: "demo", localId: id, title, impact: 50, effortDays: 1 });
  if (status !== "OPEN") setTaskStatus(db, id, status, { workstream: "demo" });
}

function getTaskRow(db: Db, id: string) {
  const row = db
    .prepare(
      `SELECT t.local_id AS name,
              ws.name AS workstreamName,
              t.title AS title,
              t.status AS status,
              t.impact AS impact,
              t.effort_days AS effortDays,
              owner.name AS ownerName,
              t.created_at AS createdAt,
              t.updated_at AS updatedAt
         FROM tasks t
         JOIN workstreams ws ON ws.id = t.workstream_id
    LEFT JOIN agents owner ON owner.id = t.owner_id
        WHERE ws.name = 'demo' AND t.local_id = ?`,
    )
    .get(id);
  if (row === undefined) throw new Error(`missing fixture task ${id}`);
  return row as Parameters<typeof formatTreeNodeLabel>[0];
}

describe("tree label rendering", () => {
  it("keeps the default label shape as name + status + title", () => {
    const db = fixtureDb();
    addTaskWithStatus(db, "task_a", "OPEN", "FEAT: long summary line");
    const task = getTaskRow(db, "task_a");

    expect(formatTreeNodeLabel(task, (t) => t.status)).toBe(
      "task_a  OPEN  FEAT: long summary line",
    );
  });

  it("can omit the title for compact consumers", () => {
    const db = fixtureDb();
    addTaskWithStatus(db, "task_a", "OPEN", "FEAT: long summary line");
    const task = getTaskRow(db, "task_a");

    expect(formatTreeNodeLabel(task, (t) => t.status, { includeTitle: false })).toBe(
      "task_a  OPEN",
    );
  });

  it("threads includeTitle=false through renderForest and renderTaskTree", () => {
    const db = fixtureDb();
    addTaskWithStatus(db, "root", "OPEN", "FEAT: root summary line");
    addTaskWithStatus(db, "child", "OPEN", "BUG: child summary line");
    addBlockEdge(db, "demo", "child", "root");
    const dag = loadFullDag(db, "demo");
    const root = getTaskRow(db, "root");

    const forest = renderForest(dag.roots, dag.edges, (t) => t.status, dag.tasks, {
      includeTitle: false,
    });
    const tree = renderTaskTree(db, "demo", root, "dependents", (t) => t.status, {
      includeTitle: false,
    });

    for (const out of [forest, tree]) {
      expect(out).toContain("root  OPEN");
      expect(out).toContain("child  OPEN");
      expect(out).not.toContain("FEAT: root summary line");
      expect(out).not.toContain("BUG: child summary line");
    }
  });
});

describe("loadFullDag status filter", () => {
  it("filters tasks to the provided status set", () => {
    const db = fixtureDb();
    for (const [id, status] of [
      ["open", "OPEN"],
      ["in_progress", "IN_PROGRESS"],
      ["closed", "CLOSED"],
      ["rejected", "REJECTED"],
      ["deferred", "DEFERRED"],
    ] as const) {
      addTaskWithStatus(db, id, status);
    }

    const dag = loadFullDag(db, "demo", { statuses: new Set(["OPEN"]) });

    expect([...dag.tasks.keys()]).toEqual(["open"]);
    expect(dag.roots.map((t) => t.name)).toEqual(["open"]);
    expect([...dag.edges.entries()]).toEqual([["open", []]]);
  });

  it("removes edges to hidden parents so visible dependents become roots", () => {
    const db = fixtureDb();
    addTaskWithStatus(db, "a", "CLOSED");
    addTaskWithStatus(db, "b", "OPEN");
    addBlockEdge(db, "demo", "b", "a");

    const dag = loadFullDag(db, "demo", { statuses: new Set(["OPEN"]) });

    expect([...dag.tasks.keys()]).toEqual(["b"]);
    expect(dag.roots.map((t) => t.name)).toEqual(["b"]);
    expect([...dag.edges.entries()]).toEqual([["b", []]]);
  });
});
