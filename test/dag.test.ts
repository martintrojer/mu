import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFullDag } from "../src/dag.js";
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

function addTaskWithStatus(db: Db, id: string, status: TaskStatus): void {
  addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
  if (status !== "OPEN") setTaskStatus(db, id, status, { workstream: "demo" });
}

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
