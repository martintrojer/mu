import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DbReplayLocalIdConflictError,
  DbReplayWorkstreamMissingError,
  exportDb,
  replayDb,
} from "../src/db-sync.js";
import { type Db, openDb } from "../src/db.js";
import { addBlockEdge, addNote, addTask } from "../src/tasks.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let localDb: Db;
let sidecarDb: Db;
let localPath: string;
let sidecarPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-db-replay-"));
  localPath = join(tempDir, "local.db");
  sidecarPath = join(tempDir, "sidecar.db");
  localDb = openDb({ path: localPath });
  sidecarDb = openDb({ path: join(tempDir, "sidecar-source.db") });
});

afterEach(() => {
  localDb.close();
  sidecarDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function task(db: Db, localId: string, title = localId, workstream = "alpha"): void {
  addTask(db, { workstream, localId, title, impact: 50, effortDays: 1 });
}

function exportSidecar(): void {
  exportDb(sidecarDb, sidecarPath);
}

function taskIds(db: Db): string[] {
  return (
    db
      .prepare(
        "SELECT local_id FROM tasks WHERE workstream_id = (SELECT id FROM workstreams WHERE name = 'alpha') ORDER BY local_id",
      )
      .all() as { local_id: string }[]
  ).map((r) => r.local_id);
}

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

describe("replayDb", () => {
  it("--task adds a single task plus its notes and eligible edges", () => {
    task(localDb, "base", "Base");
    task(sidecarDb, "base", "Base");
    task(sidecarDb, "lost", "Lost");
    addBlockEdge(sidecarDb, "alpha", "lost", "base");
    addNote(sidecarDb, "lost", "parked note", { workstream: "alpha", author: "worker" });
    exportSidecar();

    const dry = replayDb(localDb, sidecarPath);
    expect(dry.dryRun).toBe(true);
    expect(dry.tasks.map((t) => t.localId)).toEqual(["lost"]);

    const result = replayDb(localDb, sidecarPath, { apply: true, tasks: ["lost"] });
    expect(result.added).toEqual({ tasks: 1, notes: 1, edges: 1 });
    expect(result.snapshotId).toBeDefined();
    expect(taskIds(localDb)).toEqual(["base", "lost"]);
    expect(count(localDb, "SELECT COUNT(*) AS n FROM task_notes")).toBe(1);
    expect(count(localDb, "SELECT COUNT(*) AS n FROM task_edges")).toBe(1);
  });

  it("--all adds every missing task, note, and edge", () => {
    task(localDb, "base", "Base");
    task(sidecarDb, "base", "Base");
    task(sidecarDb, "a", "A");
    task(sidecarDb, "b", "B");
    addBlockEdge(sidecarDb, "alpha", "b", "a");
    addNote(sidecarDb, "a", "note a", { workstream: "alpha" });
    addNote(sidecarDb, "b", "note b", { workstream: "alpha" });
    exportSidecar();

    const result = replayDb(localDb, sidecarPath, { apply: true, all: true });
    expect(result.added).toEqual({ tasks: 2, notes: 2, edges: 1 });
    expect(taskIds(localDb)).toEqual(["a", "b", "base"]);
  });

  it("refuses selected local_id collision with diverged content", () => {
    task(localDb, "same", "Local title");
    task(sidecarDb, "same", "Sidecar title");
    exportSidecar();

    expect(() => replayDb(localDb, sidecarPath, { apply: true, tasks: ["same"] })).toThrow(
      DbReplayLocalIdConflictError,
    );
    expect(taskIds(localDb)).toEqual(["same"]);
  });

  it("errors clearly when the sidecar workstream does not exist locally", async () => {
    task(sidecarDb, "a", "A");
    exportSidecar();

    expect(() => replayDb(localDb, sidecarPath)).toThrow(DbReplayWorkstreamMissingError);
    const cli = await runCli(["db", "replay", sidecarPath, "--json"], localPath);
    expect(cli.exitCode).toBe(13);
    expect(JSON.parse(cli.stderr)).toMatchObject({ error: "DbReplayWorkstreamMissingError" });
  });

  it("is idempotent: second replay is a no-op", () => {
    task(localDb, "base", "Base");
    task(sidecarDb, "base", "Base");
    task(sidecarDb, "lost", "Lost");
    addNote(sidecarDb, "lost", "parked note", { workstream: "alpha" });
    exportSidecar();

    expect(replayDb(localDb, sidecarPath, { apply: true, tasks: ["lost"] }).added).toEqual({
      tasks: 1,
      notes: 1,
      edges: 0,
    });
    expect(replayDb(localDb, sidecarPath, { apply: true, tasks: ["lost"] }).added).toEqual({
      tasks: 0,
      notes: 0,
      edges: 0,
    });
    expect(count(localDb, "SELECT COUNT(*) AS n FROM snapshots")).toBe(1);
  });

  it("skips an edge with one missing endpoint and warns", () => {
    task(localDb, "base", "Base");
    task(sidecarDb, "base", "Base");
    task(sidecarDb, "lost", "Lost");
    task(sidecarDb, "other", "Other");
    addBlockEdge(sidecarDb, "alpha", "lost", "other");
    exportSidecar();

    const result = replayDb(localDb, sidecarPath, { apply: true, tasks: ["lost"] });
    expect(result.added).toEqual({ tasks: 1, notes: 0, edges: 0 });
    expect(result.warnings).toEqual([
      "skipped edge other -> lost: one endpoint is missing locally",
    ]);
    expect(count(localDb, "SELECT COUNT(*) AS n FROM task_edges")).toBe(0);
  });

  it("auto-snapshot is recoverable", async () => {
    task(localDb, "base", "Base");
    task(sidecarDb, "base", "Base");
    task(sidecarDb, "lost", "Lost");
    exportSidecar();

    replayDb(localDb, sidecarPath, { apply: true, tasks: ["lost"] });
    expect(taskIds(localDb)).toEqual(["base", "lost"]);

    localDb.close();
    const undo = await runCli(["undo", "--yes", "--json"], localPath);
    expect(undo.error).toBeUndefined();
    localDb = openDb({ path: localPath });
    expect(taskIds(localDb)).toEqual(["base"]);
  });
});
