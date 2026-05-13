// Tests for src/importing.ts — the inverse of src/exporting.ts.
//
// Round-trip is the load-bearing contract: workstream X with N tasks
// + M edges + K notes → mu workstream export → wipe X via destroy →
// mu workstream import → DB has X with the same N + M + K (modulo
// owner_id, which is intentionally nulled on import).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  ImportBucketInvalidError,
  ImportEdgeRefMissingError,
  ImportFrontmatterParseError,
  ImportSourceNotInBucketError,
  WorkstreamAlreadyExistsError,
  importBucket,
} from "../src/importing.js";
import {
  addBlockEdge,
  addNote,
  addTask,
  getTaskEdges,
  listNotes,
  listTasks,
} from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { destroyWorkstream, exportWorkstream } from "../src/workstream.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mu-importing-test-"));
  db = openDb({ path: join(tmpDir, "mu.db") });
  // Renderer / importer don't touch tmux, but destroyWorkstream does.
  // Stub a no-op tmux so the wipe-then-import path runs fully offline.
  setTmuxExecutor(async (args) => {
    const verb = args[0];
    if (verb === "has-session") return { exitCode: 1, stdout: "", stderr: "no session" };
    if (verb === "kill-session") return { exitCode: 0, stdout: "", stderr: "" };
    if (verb === "list-sessions") return { exitCode: 1, stdout: "", stderr: "no server" };
    return { exitCode: 1, stdout: "", stderr: `unmocked ${args.join(" ")}` };
  });
});

afterEach(() => {
  resetTmuxExecutor();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seed(workstream: string, ids: string[]): void {
  for (const id of ids) {
    addTask(db, {
      localId: id,
      workstream,
      title: `Task ${id}`,
      impact: 50,
      effortDays: 1,
    });
  }
}

describe("importBucket — round-trip", () => {
  it("export → destroy → import rebuilds tasks + edges + notes", async () => {
    seed("auth", ["design", "build", "ship"]);
    addBlockEdge(db, "auth", "build", "design");
    addBlockEdge(db, "auth", "ship", "build");
    addNote(db, "design", "DECISION: JWT", { author: "alice", workstream: "auth" });
    addNote(db, "design", "context follow-up", { author: "alice", workstream: "auth" });
    addNote(db, "build", "FILES: src/auth.rs", { author: "bob", workstream: "auth" });
    addNote(db, "ship", "checklist done", { author: "system", workstream: "auth" });

    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });

    await destroyWorkstream(db, { workstream: "auth" });
    expect(listTasks(db, "auth")).toHaveLength(0);

    const result = importBucket(db, { bucketDir: bucket });
    expect(result.bucketVersion).toBe(2);
    expect(result.sources).toHaveLength(1);
    const auth = result.sources[0];
    if (!auth) throw new Error("unreachable");
    expect(auth.workstreamName).toBe("auth");
    expect(auth.tasksImported).toBe(3);
    expect(auth.edgesImported).toBe(2);
    expect(auth.notesImported).toBe(4);
    expect(auth.tombstonesSkipped).toBe(0);

    const tasks = listTasks(db, "auth");
    expect(tasks.map((t) => t.name).sort()).toEqual(["build", "design", "ship"]);
    expect(getTaskEdges(db, "build", "auth").blockers).toEqual(["design"]);
    expect(getTaskEdges(db, "ship", "auth").blockers).toEqual(["build"]);
    const designNotes = listNotes(db, "design", "auth");
    expect(designNotes.map((n) => n.content)).toEqual(["DECISION: JWT", "context follow-up"]);
    expect(designNotes.map((n) => n.author)).toEqual(["alice", "alice"]);
    const shipNotes = listNotes(db, "ship", "auth");
    expect(shipNotes.map((n) => n.content)).toEqual(["checklist done"]);
    expect(shipNotes.map((n) => n.author)).toEqual(["system"]);
  });

  it("preserves NULL note authors distinctly from literal system", async () => {
    seed("auth", ["ship"]);
    addNote(db, "ship", "operator-less note", { workstream: "auth" });

    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });

    await destroyWorkstream(db, { workstream: "auth" });
    importBucket(db, { bucketDir: bucket });

    const shipNotes = listNotes(db, "ship", "auth");
    expect(shipNotes.map((n) => n.content)).toEqual(["operator-less note"]);
    expect(shipNotes.map((n) => n.author)).toEqual([null]);
  });
});

describe("importBucket — multi-source", () => {
  it("imports every source-ws subdir in one call", async () => {
    seed("auth", ["design"]);
    seed("ui", ["mockup", "implement"]);
    addBlockEdge(db, "ui", "implement", "mockup");

    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    exportWorkstream(db, { workstream: "ui", outDir: bucket });

    await destroyWorkstream(db, { workstream: "auth" });
    await destroyWorkstream(db, { workstream: "ui" });

    const result = importBucket(db, { bucketDir: bucket });
    expect(result.sources.map((s) => s.workstreamName).sort()).toEqual(["auth", "ui"]);
    expect(listTasks(db, "auth").map((t) => t.name)).toEqual(["design"]);
    expect(
      listTasks(db, "ui")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["implement", "mockup"]);
    expect(getTaskEdges(db, "implement", "ui").blockers).toEqual(["mockup"]);
  });
});

describe("importBucket — --workstream override", () => {
  it("renames a single-source bucket on import", async () => {
    seed("auth", ["design"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    await destroyWorkstream(db, { workstream: "auth" });

    const result = importBucket(db, { bucketDir: bucket, workstreamOverride: "auth-v2" });
    expect(result.sources[0]?.workstreamName).toBe("auth-v2");
    expect(listTasks(db, "auth-v2").map((t) => t.name)).toEqual(["design"]);
    expect(listTasks(db, "auth")).toHaveLength(0);
  });

  it("rejects --workstream override against a multi-source bucket", async () => {
    seed("auth", ["design"]);
    seed("ui", ["mockup"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    exportWorkstream(db, { workstream: "ui", outDir: bucket });

    expect(() => importBucket(db, { bucketDir: bucket, workstreamOverride: "merged" })).toThrow(
      ImportBucketInvalidError,
    );
  });
});

describe("importBucket — --dry-run", () => {
  it("walks the bucket but writes nothing", async () => {
    seed("auth", ["design", "build"]);
    addBlockEdge(db, "auth", "build", "design");
    addNote(db, "design", "DECISION: x", { workstream: "auth" });
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    await destroyWorkstream(db, { workstream: "auth" });

    const result = importBucket(db, { bucketDir: bucket, dryRun: true });
    expect(result.sources[0]?.tasksImported).toBe(2);
    expect(result.sources[0]?.edgesImported).toBe(1);
    expect(result.sources[0]?.notesImported).toBe(1);
    // No DB writes.
    expect(listTasks(db, "auth")).toHaveLength(0);
  });
});

describe("importBucket — idempotency / collision", () => {
  function expectImportAlreadyExists(bucket: string): WorkstreamAlreadyExistsError {
    let caught: unknown;
    try {
      importBucket(db, { bucketDir: bucket });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkstreamAlreadyExistsError);
    const err = caught as WorkstreamAlreadyExistsError;
    expect(err.errorNextSteps().map((step) => step.command)).toEqual([
      "mu workstream import <bucket> --workstream <new-name>",
      "mu workstream destroy -w auth --yes",
    ]);
    return err;
  }

  it("imports cleanly after destroy drops the workstreams row", async () => {
    seed("auth", ["design"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    await destroyWorkstream(db, { workstream: "auth" });

    const row = db.prepare("SELECT 1 AS x FROM workstreams WHERE name = ?").get("auth") as
      | { x: number }
      | undefined;
    expect(row).toBeUndefined();

    importBucket(db, { bucketDir: bucket });
    expect(listTasks(db, "auth")).toHaveLength(1);
  });

  it("refuses to merge into an existing workstream that already has tasks", async () => {
    seed("auth", ["design"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    // Note: NOT destroying. The auth workstream is alive with tasks.

    const err = expectImportAlreadyExists(bucket);
    expect(err.message).toContain("refuses to merge silently");
  });

  it("refuses to merge into an existing workstream that has agents but zero tasks", async () => {
    seed("auth", ["design"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    await destroyWorkstream(db, { workstream: "auth" });

    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    expect(listTasks(db, "auth")).toHaveLength(0);

    expectImportAlreadyExists(bucket);
    expect(listTasks(db, "auth")).toHaveLength(0);
  });

  it("refuses to merge into an existing workstream that has workspaces but zero tasks", async () => {
    seed("auth", ["design"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    await destroyWorkstream(db, { workstream: "auth" });

    insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
    const ws = db.prepare("SELECT id FROM workstreams WHERE name = ?").get("auth") as
      | { id: number }
      | undefined;
    const agent = db
      .prepare("SELECT id FROM agents WHERE name = ? AND workstream_id = ?")
      .get("worker-1", ws?.id ?? -1) as { id: number } | undefined;
    if (ws === undefined || agent === undefined) throw new Error("failed to seed workspace");
    db.prepare(
      `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
       VALUES (?, ?, 'none', ?, NULL, ?)`,
    ).run(agent.id, ws.id, join(tmpDir, "workspace-worker-1"), new Date().toISOString());
    expect(listTasks(db, "auth")).toHaveLength(0);

    expectImportAlreadyExists(bucket);
    expect(listTasks(db, "auth")).toHaveLength(0);
  });
});

describe("importBucket — tombstones", () => {
  it("skips tombstoned tasks and counts them separately", async () => {
    seed("auth", ["design", "build"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    // Drop `build` from the DB then re-export so the renderer
    // banners it on disk.
    const { deleteTask } = await import("../src/tasks.js");
    deleteTask(db, "build", "auth");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    expect(readFileSync(join(bucket, "auth/tasks/build.md"), "utf8")).toMatch(
      /^> \*\*Deleted from DB on /,
    );

    await destroyWorkstream(db, { workstream: "auth" });

    const result = importBucket(db, { bucketDir: bucket });
    expect(result.sources[0]?.tasksImported).toBe(1);
    expect(result.sources[0]?.tombstonesSkipped).toBe(1);
    expect(listTasks(db, "auth").map((t) => t.name)).toEqual(["design"]);
  });
});

describe("importBucket — validation errors", () => {
  it("ImportEdgeRefMissingError when a task references a non-existent blocker", async () => {
    seed("auth", ["design", "build"]);
    addBlockEdge(db, "auth", "build", "design");
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    // Surgically delete the design task .md so the build task's
    // blocked_by becomes a dangling ref.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(bucket, "auth/tasks/design.md"));
    await destroyWorkstream(db, { workstream: "auth" });

    expect(() => importBucket(db, { bucketDir: bucket })).toThrow(ImportEdgeRefMissingError);
    // Nothing committed (transaction rollback).
    expect(listTasks(db, "auth")).toHaveLength(0);
  });

  it("ImportFrontmatterParseError on malformed frontmatter; nothing committed", async () => {
    seed("auth", ["design"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    await destroyWorkstream(db, { workstream: "auth" });
    // Corrupt the design.md frontmatter (drop the closing ---).
    const path = join(bucket, "auth/tasks/design.md");
    const broken = readFileSync(path, "utf8").replace("---\n\n# Task design", "# Task design");
    writeFileSync(path, broken, "utf8");

    expect(() => importBucket(db, { bucketDir: bucket })).toThrow(ImportFrontmatterParseError);
    expect(listTasks(db, "auth")).toHaveLength(0);
  });

  it("ImportBucketInvalidError when the bucket dir is missing or has no manifest", () => {
    expect(() => importBucket(db, { bucketDir: join(tmpDir, "no-such-dir") })).toThrow(
      ImportBucketInvalidError,
    );
    const empty = join(tmpDir, "empty");
    mkdirSync(empty);
    expect(() => importBucket(db, { bucketDir: empty })).toThrow(ImportBucketInvalidError);
  });
});

describe("importBucket — preserves timestamps", () => {
  it("created_at / updated_at survive the round trip", async () => {
    seed("auth", ["design"]);
    const before = listTasks(db, "auth")[0];
    if (!before) throw new Error("seed failed");
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    await destroyWorkstream(db, { workstream: "auth" });
    expect(existsSync(join(bucket, "auth/tasks/design.md"))).toBe(true);
    importBucket(db, { bucketDir: bucket });
    const after = listTasks(db, "auth")[0];
    if (!after) throw new Error("import dropped the row");
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBe(before.updatedAt);
    // Owner forced to NULL.
    expect(after.ownerName).toBeNull();
  });
});

describe("importBucket — partial import (per-source-ws subdir + --source-ws filter)", () => {
  /** Build a 3-source bucket on disk in tmpDir/bucket and wipe the
   *  live workstreams. Returns the bucket directory. */
  async function buildThreeSourceBucket(): Promise<string> {
    seed("auth", ["design", "build"]);
    addBlockEdge(db, "auth", "build", "design");
    addNote(db, "design", "DECISION: JWT", { author: "alice", workstream: "auth" });
    seed("ui", ["mockup"]);
    seed("api", ["spec", "impl"]);
    addBlockEdge(db, "api", "impl", "spec");

    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    exportWorkstream(db, { workstream: "ui", outDir: bucket });
    exportWorkstream(db, { workstream: "api", outDir: bucket });

    await destroyWorkstream(db, { workstream: "auth" });
    await destroyWorkstream(db, { workstream: "ui" });
    await destroyWorkstream(db, { workstream: "api" });
    return bucket;
  }

  it("Form 1 — per-source-ws subdir path imports just that source", async () => {
    const bucket = await buildThreeSourceBucket();
    const result = importBucket(db, { bucketDir: join(bucket, "auth") });
    expect(result.bucketVersion).toBe(2);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.workstreamName).toBe("auth");
    expect(result.sources[0]?.tasksImported).toBe(2);
    expect(result.sources[0]?.edgesImported).toBe(1);
    expect(result.sources[0]?.notesImported).toBe(1);
    expect(
      listTasks(db, "auth")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["build", "design"]);
    // Siblings stayed off-disk.
    expect(listTasks(db, "ui")).toHaveLength(0);
    expect(listTasks(db, "api")).toHaveLength(0);
  });

  it("Form 1 — bucketLabel flows through from the parent manifest", async () => {
    const bucket = await buildThreeSourceBucket();
    // exportWorkstream sets bucketLabel = null (one-shot), so just
    // verify the field is read from the parent (matches the bucket).
    const parentResult = importBucket(db, {
      bucketDir: join(bucket, "auth"),
      dryRun: true,
    });
    const fullDryRun = importBucket(db, { bucketDir: bucket, dryRun: true });
    expect(parentResult.bucketLabel).toBe(fullDryRun.bucketLabel);
    expect(parentResult.bucketVersion).toBe(fullDryRun.bucketVersion);
  });

  it("Form 2 — --source-ws filters to a single source", async () => {
    const bucket = await buildThreeSourceBucket();
    const result = importBucket(db, { bucketDir: bucket, sourceWs: ["ui"] });
    expect(result.sources.map((s) => s.workstreamName)).toEqual(["ui"]);
    expect(listTasks(db, "ui").map((t) => t.name)).toEqual(["mockup"]);
    expect(listTasks(db, "auth")).toHaveLength(0);
    expect(listTasks(db, "api")).toHaveLength(0);
  });

  it("Form 2 — --source-ws X,Y on a 3-source bucket imports X+Y, not Z", async () => {
    const bucket = await buildThreeSourceBucket();
    const result = importBucket(db, { bucketDir: bucket, sourceWs: ["auth", "ui"] });
    expect(result.sources.map((s) => s.workstreamName).sort()).toEqual(["auth", "ui"]);
    expect(
      listTasks(db, "auth")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["build", "design"]);
    expect(listTasks(db, "ui").map((t) => t.name)).toEqual(["mockup"]);
    expect(listTasks(db, "api")).toHaveLength(0);
  });

  it("Form 1 + --workstream rename — restores under the new name", async () => {
    const bucket = await buildThreeSourceBucket();
    const result = importBucket(db, {
      bucketDir: join(bucket, "auth"),
      workstreamOverride: "auth-v2",
    });
    expect(result.sources[0]?.workstreamName).toBe("auth-v2");
    expect(
      listTasks(db, "auth-v2")
        .map((t) => t.name)
        .sort(),
    ).toEqual(["build", "design"]);
    expect(listTasks(db, "auth")).toHaveLength(0);
  });

  it("Form 2 + --source-ws X --workstream rename — single-source rename works", async () => {
    const bucket = await buildThreeSourceBucket();
    const result = importBucket(db, {
      bucketDir: bucket,
      sourceWs: ["ui"],
      workstreamOverride: "ui-v2",
    });
    expect(result.sources[0]?.workstreamName).toBe("ui-v2");
    expect(listTasks(db, "ui-v2").map((t) => t.name)).toEqual(["mockup"]);
  });

  it("Form 2 + multi --source-ws X,Y + --workstream — rejects (multi-source rule)", async () => {
    const bucket = await buildThreeSourceBucket();
    expect(() =>
      importBucket(db, {
        bucketDir: bucket,
        sourceWs: ["auth", "ui"],
        workstreamOverride: "merged",
      }),
    ).toThrow(ImportBucketInvalidError);
  });

  it("Form 2 — bad --source-ws name surfaces ImportSourceNotInBucketError; nothing committed", async () => {
    const bucket = await buildThreeSourceBucket();
    let caught: unknown;
    try {
      importBucket(db, { bucketDir: bucket, sourceWs: ["nope"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ImportSourceNotInBucketError);
    const err = caught as ImportSourceNotInBucketError;
    expect(err.badName).toBe("nope");
    expect(err.validNames.sort()).toEqual(["api", "auth", "ui"]);
    // No partial state.
    expect(listTasks(db, "auth")).toHaveLength(0);
    expect(listTasks(db, "ui")).toHaveLength(0);
    expect(listTasks(db, "api")).toHaveLength(0);
  });

  it("Form 1 against an orphan source-ws subdir (no parent bucket manifest) — ImportBucketInvalidError", async () => {
    // Build a bucket, then COPY the per-source-ws subdir somewhere
    // else so it loses its parent. (Using a fresh tmpdir under the
    // existing one keeps cleanup automatic.)
    const bucket = await buildThreeSourceBucket();
    const orphanRoot = join(tmpDir, "orphan");
    mkdirSync(orphanRoot);
    const orphanWsDir = join(orphanRoot, "auth");
    mkdirSync(orphanWsDir);
    mkdirSync(join(orphanWsDir, "tasks"));
    writeFileSync(join(orphanWsDir, "README.md"), "# orphan\n", "utf8");
    writeFileSync(join(orphanWsDir, "INDEX.md"), "# index\n", "utf8");
    // Copy one task file so the dir has the right shape.
    writeFileSync(
      join(orphanWsDir, "tasks", "design.md"),
      readFileSync(join(bucket, "auth", "tasks", "design.md"), "utf8"),
      "utf8",
    );

    let caught: unknown;
    try {
      importBucket(db, { bucketDir: orphanWsDir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ImportBucketInvalidError);
    expect((caught as Error).message).toMatch(/per-source-ws subdir/);
    expect((caught as Error).message).toMatch(/manifest\.json/);
  });

  it("Form 1 + --source-ws — anti-feature guard fires", async () => {
    const bucket = await buildThreeSourceBucket();
    let caught: unknown;
    try {
      importBucket(db, {
        bucketDir: join(bucket, "auth"),
        sourceWs: ["auth"],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ImportBucketInvalidError);
    expect((caught as Error).message).toMatch(/cannot pass --source-ws/);
    // Nothing landed.
    expect(listTasks(db, "auth")).toHaveLength(0);
  });
});
