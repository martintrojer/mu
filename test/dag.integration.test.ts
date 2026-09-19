import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatTreeNodeLabel, loadFullDag, renderForest, renderTaskTree } from "../src/dag.js";
import { type Db, openDb } from "../src/db.js";
import type { TaskStatus } from "../src/tasks/status.js";
import { addBlockEdge, addTask, setTaskStatus } from "../src/tasks.js";

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

  it("renders a task subtree with a bounded number of SQL reads", () => {
    const db = fixtureDb();
    for (let i = 0; i < 100; i++) {
      addTask(db, {
        workstream: "demo",
        localId: `t${i}`,
        title: `T${i}`,
        impact: 50,
        effortDays: 1,
        ...(i === 0 ? {} : { blockedBy: [`t${i - 1}`] }),
      });
    }
    const root = getTaskRow(db, "t0");
    let prepares = 0;
    const countedDb = new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "prepare") {
          return (...args: Parameters<Db["prepare"]>) => {
            prepares++;
            return target.prepare(...args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(renderTaskTree(countedDb, "demo", root, "dependents", (t) => t.status)).toContain(
      "t99  OPEN  T99",
    );
    expect(prepares).toBeLessThanOrEqual(4);
  });
});

describe("loadFullDag status filter", () => {
  it("filters tasks to the provided status set", () => {
    const db = fixtureDb();
    for (const [id, status] of [
      ["open", "OPEN"],
      ["in_progress", "IN_PROGRESS"],
      ["closed", "CLOSED"],
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

  it("ignores an invalid cross-workstream edge", () => {
    const db = fixtureDb();
    addTaskWithStatus(db, "local", "OPEN");
    addTask(db, {
      workstream: "other",
      localId: "foreign",
      title: "Foreign",
      impact: 50,
      effortDays: 1,
    });
    const local = db.prepare("SELECT id FROM tasks WHERE local_id = 'local'").get() as {
      id: number;
    };
    const foreign = db.prepare("SELECT id FROM tasks WHERE local_id = 'foreign'").get() as {
      id: number;
    };
    db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    ).run(local.id, foreign.id, new Date().toISOString());

    expect([...loadFullDag(db, "demo").edges.entries()]).toEqual([["local", []]]);
  });

  it("loads a dense workstream DAG in milliseconds", () => {
    const db = fixtureDb();
    const workstream = db
      .prepare("INSERT INTO workstreams (name, created_at) VALUES ('demo', ?) RETURNING id")
      .get(new Date().toISOString()) as { id: number };
    const insertTask = db.prepare(
      `INSERT INTO tasks
         (workstream_id, local_id, title, status, impact, effort_days, created_at, updated_at)
       VALUES (?, ?, ?, 'OPEN', 50, 1, ?, ?)`,
    );
    const taskIds: number[] = [];
    db.transaction(() => {
      for (let i = 0; i < 1_500; i++) {
        const now = new Date().toISOString();
        const result = insertTask.run(workstream.id, `t${i}`, `T${i}`, now, now);
        taskIds.push(Number(result.lastInsertRowid));
      }
      const insertEdge = db.prepare(
        "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
      );
      const now = new Date().toISOString();
      for (let i = 1; i < taskIds.length; i++) {
        const from = taskIds[i - 1];
        const to = taskIds[i];
        if (from !== undefined && to !== undefined) insertEdge.run(from, to, now);
      }
    })();

    const started = performance.now();
    expect(loadFullDag(db, "demo").tasks.size).toBe(1_500);
    // The former join plan was quadratic (~280ms at this size); the
    // edge-first plan is ~8ms. Leave ample headroom for loaded CI hosts.
    expect(performance.now() - started).toBeLessThan(150);
  });
});
