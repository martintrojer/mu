// Tests for mu archive restore — structured un-archive without a
// markdown bucket round-trip.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArchiveSourceAmbiguousError,
  addToArchive,
  createArchive,
  restoreArchive,
} from "../src/archives.js";
import { type Db, openDb } from "../src/db.js";
import { listSnapshots } from "../src/snapshots.js";
import {
  addBlockEdge,
  addNote,
  addTask,
  closeTask,
  getTaskEdges,
  listNotes,
  listTasks,
} from "../src/tasks.js";
import { WorkstreamExistsError, ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-archive-restore-"));
  process.env.MU_STATE_DIR = tempDir;
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // best effort
  }
  rmSync(tempDir, { recursive: true, force: true });
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

function seedAlpha(): void {
  ensureWorkstream(db, "alpha");
  addTask(db, {
    localId: "design",
    workstream: "alpha",
    title: "Design alpha",
    impact: 80,
    effortDays: 1,
  });
  addTask(db, {
    localId: "build",
    workstream: "alpha",
    title: "Build alpha",
    impact: 70,
    effortDays: 2,
  });
  addTask(db, {
    localId: "ship",
    workstream: "alpha",
    title: "Ship alpha",
    impact: 90,
    effortDays: 1,
  });
  addBlockEdge(db, "alpha", "build", "design");
  addBlockEdge(db, "alpha", "ship", "build");
  addNote(db, "design", "DECISION: alpha", { workstream: "alpha", author: "user" });
  addNote(db, "build", "FILES: src/alpha.ts", { workstream: "alpha", author: "worker-1" });
  closeTask(db, "design", { workstream: "alpha", evidence: "seed closed" });
}

function seedBeta(): void {
  ensureWorkstream(db, "beta");
  addTask(db, {
    localId: "design",
    workstream: "beta",
    title: "Design beta",
    impact: 60,
    effortDays: 1,
  });
}

function counts(workstream: string): { tasks: number; edges: number; notes: number } {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*)
            FROM tasks t JOIN workstreams ws ON ws.id = t.workstream_id
           WHERE ws.name = ?) AS tasks,
         (SELECT COUNT(*)
            FROM task_edges e
            JOIN tasks t ON t.id = e.from_task_id
            JOIN workstreams ws ON ws.id = t.workstream_id
           WHERE ws.name = ?) AS edges,
         (SELECT COUNT(*)
            FROM task_notes n
            JOIN tasks t ON t.id = n.task_id
            JOIN workstreams ws ON ws.id = t.workstream_id
           WHERE ws.name = ?) AS notes`,
    )
    .get(workstream, workstream, workstream) as { tasks: number; edges: number; notes: number };
  return row;
}

describe("restoreArchive SDK", () => {
  it("restores from a single-source archive without --source", () => {
    seedAlpha();
    createArchive(db, "wave");
    addToArchive(db, "wave", "alpha");

    const result = restoreArchive(db, "wave", "alpha-restored");

    expect(result).toMatchObject({
      archiveLabel: "wave",
      sourceWorkstream: "alpha",
      workstreamName: "alpha-restored",
      restoredTasks: 3,
      restoredEdges: 2,
    });
    expect(listTasks(db, "alpha-restored").map((task) => task.name)).toEqual([
      "build",
      "design",
      "ship",
    ]);
    expect(getTaskEdges(db, "ship", "alpha-restored").blockers).toEqual(["build"]);
    expect(listNotes(db, "design", "alpha-restored").map((note) => note.content)).toEqual([
      "DECISION: alpha",
      "CLOSE: seed closed",
    ]);
  });

  it("multi-source archive without --source throws a clear ambiguous-source error", () => {
    seedAlpha();
    seedBeta();
    createArchive(db, "wave");
    addToArchive(db, "wave", "alpha");
    addToArchive(db, "wave", "beta");

    let caught: unknown;
    try {
      restoreArchive(db, "wave", "restored");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ArchiveSourceAmbiguousError);
    const err = caught as ArchiveSourceAmbiguousError;
    expect(err.message).toContain("alpha");
    expect(err.message).toContain("beta");
    expect(
      err
        .errorNextSteps()
        .map((step) => step.command)
        .join("\n"),
    ).toContain("--source alpha");
  });

  it("restores from a multi-source archive with --source", () => {
    seedAlpha();
    seedBeta();
    createArchive(db, "wave");
    addToArchive(db, "wave", "alpha");
    addToArchive(db, "wave", "beta");

    const result = restoreArchive(db, "wave", "beta-copy", { sourceWorkstream: "beta" });

    expect(result.restoredTasks).toBe(1);
    expect(listTasks(db, "beta-copy").map((task) => task.title)).toEqual(["Design beta"]);
  });

  it("--as collision with an existing workstream throws WorkstreamExistsError", () => {
    seedAlpha();
    ensureWorkstream(db, "taken");
    createArchive(db, "wave");
    addToArchive(db, "wave", "alpha");

    expect(() => restoreArchive(db, "wave", "taken")).toThrow(WorkstreamExistsError);
  });

  it("round-trip property preserves task/edge/note counts, local ids, and statuses", () => {
    seedAlpha();
    const beforeCounts = counts("alpha");
    const beforeTasks = listTasks(db, "alpha").map((task) => ({
      name: task.name,
      status: task.status,
    }));
    createArchive(db, "wave");
    addToArchive(db, "wave", "alpha");

    restoreArchive(db, "wave", "alpha-roundtrip");

    expect(counts("alpha-roundtrip")).toEqual(beforeCounts);
    expect(
      listTasks(db, "alpha-roundtrip").map((task) => ({
        name: task.name,
        status: task.status,
      })),
    ).toEqual(beforeTasks);
  });

  it("auto-snapshot is recoverable: restore then undo returns to pre-restore state", async () => {
    seedAlpha();
    createArchive(db, "wave");
    addToArchive(db, "wave", "alpha");
    db.close();

    const restored = await runCli(["archive", "restore", "wave", "--as", "alpha-copy"], dbPath);
    expect(restored.error).toBeUndefined();
    expect(restored.exitCode).toBeNull();
    db = openDb({ path: dbPath });
    expect(listTasks(db, "alpha-copy")).toHaveLength(3);
    expect(
      listSnapshots(db).some((snapshot) => snapshot.label === "archive restore wave as alpha-copy"),
    ).toBe(true);
    db.close();

    const undo = await runCli(["undo", "--yes"], dbPath);
    expect(undo.error).toBeUndefined();
    expect(undo.exitCode).toBeNull();
    db = openDb({ path: dbPath });
    expect(listTasks(db, "alpha-copy")).toHaveLength(0);
    expect(listTasks(db, "alpha")).toHaveLength(3);
  });
});

describe("mu archive restore CLI", () => {
  it("wires restore --json and reports the restored counts", async () => {
    seedAlpha();
    createArchive(db, "wave");
    addToArchive(db, "wave", "alpha");
    db.close();

    const result = await runCli(
      ["archive", "restore", "wave", "--as", "alpha-copy", "--json"],
      dbPath,
    );
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBeNull();
    const obj = JSON.parse(result.stdout.trim()) as {
      archiveLabel: string;
      sourceWorkstream: string;
      workstreamName: string;
      restoredTasks: number;
      restoredEdges: number;
      restoredNotes: number;
      nextSteps: Array<{ command: string }>;
    };
    expect(obj).toMatchObject({
      archiveLabel: "wave",
      sourceWorkstream: "alpha",
      workstreamName: "alpha-copy",
      restoredTasks: 3,
      restoredEdges: 2,
    });
    expect(obj.restoredNotes).toBeGreaterThan(0);
    expect(obj.nextSteps.map((step) => step.command)).toContain("mu task list -w alpha-copy");
  });
});
