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
import { type Db, openDb } from "../src/db.js";
import {
  ImportBucketInvalidError,
  ImportEdgeRefMissingError,
  ImportFrontmatterParseError,
  ImportLegacyLayoutError,
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
  it("imports cleanly into a destroyed-then-recreated empty workstream", async () => {
    seed("auth", ["design"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    await destroyWorkstream(db, { workstream: "auth" });

    importBucket(db, { bucketDir: bucket });
    expect(listTasks(db, "auth")).toHaveLength(1);
  });

  it("refuses to merge into an existing workstream that already has tasks", async () => {
    seed("auth", ["design"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    // Note: NOT destroying. The auth workstream is alive with tasks.

    expect(() => importBucket(db, { bucketDir: bucket })).toThrow(WorkstreamAlreadyExistsError);
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

  it("ImportLegacyLayoutError on a pre-0.3 single-source manifest", () => {
    const bucket = join(tmpDir, "legacy");
    mkdirSync(bucket);
    writeFileSync(
      join(bucket, "manifest.json"),
      JSON.stringify({
        workstream: "auth",
        exportedAt: "2025-01-01T00:00:00.000Z",
        muVersion: "0.2.0",
        eventsSeqAtExport: 1,
        tasks: [],
      }),
      "utf8",
    );
    expect(() => importBucket(db, { bucketDir: bucket })).toThrow(ImportLegacyLayoutError);
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
