import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToArchive, createArchive } from "../src/archives.js";
import { type DbExportManifest, DbExportTargetExistsError, exportDb } from "../src/db-sync.js";
import { CURRENT_SCHEMA_VERSION, type Db, openDb } from "../src/db.js";
import { appendLog, latestSeq } from "../src/logs.js";
import { addBlockEdge, addNote, addTask } from "../src/tasks.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-db-export-"));
  db = openDb({ path: join(tempDir, "source.db") });
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function manifest(path: string): DbExportManifest {
  return JSON.parse(readFileSync(`${path}.manifest.json`, "utf8")) as DbExportManifest;
}

function count(dbHandle: Db, table: string): number {
  const row = dbHandle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function task(localId: string, workstream: string, title = localId): void {
  addTask(db, { localId, workstream, title, impact: 50, effortDays: 1 });
}

describe("exportDb", () => {
  it("exports a VACUUMed DB copy that opens with matching task/workstream/archive data", () => {
    task("design", "alpha", "Design");
    task("build", "alpha", "Build");
    addBlockEdge(db, "alpha", "build", "design");
    addNote(db, "design", "note one", { workstream: "alpha", author: "tester" });
    task("ship", "beta", "Ship");
    createArchive(db, "done");
    addToArchive(db, "done", "alpha");

    const target = join(tempDir, "export.db");
    const result = exportDb(db, target);
    expect(existsSync(result.file)).toBe(true);
    expect(existsSync(result.manifestPath)).toBe(true);

    const copied = openDb({ path: target, readonly: true });
    try {
      expect(count(copied, "tasks")).toBe(count(db, "tasks"));
      const archivedSql =
        "SELECT source_workstream, original_local_id, title FROM archived_tasks ORDER BY original_local_id";
      expect(copied.prepare(archivedSql).all()).toEqual(db.prepare(archivedSql).all());
      const names = copied.prepare("SELECT name FROM workstreams ORDER BY name").all() as {
        name: string;
      }[];
      expect(names.map((r) => r.name)).toEqual(["alpha", "beta"]);
      const sample = copied.prepare("SELECT local_id FROM tasks WHERE title = 'Design'").get() as {
        local_id: string;
      };
      expect(sample.local_id).toBe("design");
    } finally {
      copied.close();
    }
  });

  it("writes schema v8 machine manifest with per-workstream latestSeq", () => {
    task("a", "alpha", "A");
    addNote(db, "a", "hello", { workstream: "alpha" });
    task("b", "beta", "B");
    const alphaId = (
      db.prepare("SELECT id FROM workstreams WHERE name = 'alpha'").get() as { id: number }
    ).id;
    const betaId = (
      db.prepare("SELECT id FROM workstreams WHERE name = 'beta'").get() as { id: number }
    ).id;
    appendLog(db, {
      workstream: "alpha",
      source: "tester",
      kind: "message",
      payload: "alpha-only",
    });

    const target = join(tempDir, "manifested.db");
    exportDb(db, target);
    const parsed = manifest(target);

    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.schemaVersion).toBe(8);
    expect(parsed.machineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(parsed.workstreams).toHaveLength(2);
    // exportDb emits a `db export` agent_logs event per included
    // workstream BEFORE building the manifest (parked-detection seam,
    // src/parked.ts), so manifest seq == post-event local seq. This
    // also makes re-importing the export classify as IDENTICAL.
    expect(parsed.workstreams.find((w) => w.name === "alpha")?.latestSeq).toBe(
      latestSeq(db, alphaId),
    );
    expect(parsed.workstreams.find((w) => w.name === "beta")?.latestSeq).toBe(
      latestSeq(db, betaId),
    );
  });

  it("refuses to overwrite unless force is set", () => {
    const target = join(tempDir, "exists.db");
    writeFileSync(target, "already here", "utf8");
    expect(() => exportDb(db, target)).toThrow(DbExportTargetExistsError);
    expect(readFileSync(target, "utf8")).toBe("already here");

    const result = exportDb(db, target, { force: true });
    expect(result.overwritten).toBe(true);
    expect(existsSync(result.manifestPath)).toBe(true);
  });

  it("exports an empty DB with an empty workstreams manifest", () => {
    const target = join(tempDir, "empty.db");
    exportDb(db, target);
    expect(manifest(target).workstreams).toEqual([]);

    const copied = openDb({ path: target, readonly: true });
    try {
      expect(count(copied, "workstreams")).toBe(0);
    } finally {
      copied.close();
    }
  });

  it("CLI nextSteps suggest the default dry-run import without a bogus --dry-run flag", async () => {
    const target = join(tempDir, "cli-export.db");
    const result = await runCli(["db", "export", target], join(tempDir, "cli-source.db"));

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toContain("mu db import /tmp/mu.db");
    expect(result.stdout).not.toContain("--dry-run");
  });
});
