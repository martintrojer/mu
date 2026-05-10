// Tests for src/exporting.ts — the unified bucket renderer used by
// `mu workstream export` and `mu archive export`.
//
// The renderer's invariants:
//   - bucketVersion: 2 disk shape (top-level README/INDEX/manifest +
//     per-source-ws subdir with README/INDEX/tasks/<id>.md).
//   - Additive: a re-export of source-ws X into a bucket containing
//     source-ws Y appends X's subdir without touching Y's.
//   - Idempotent at the per-task level via sha256 short-circuit.
//   - Tasks deleted from the source between exports are preserved
//     with a one-time banner.
//   - Refuses to write into a legacy (pre-0.3, single-source) export
//     directory; throws LegacyExportLayoutError.
//   - Auto-export at destroy time uses this same renderer.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToArchive, createArchive } from "../src/archives.js";
import { type Db, openDb } from "../src/db.js";
import { type ExportManifest, LegacyExportLayoutError, exportArchive } from "../src/exporting.js";
import { addNote, addTask, deleteTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { destroyWorkstream, exportWorkstream } from "../src/workstream.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mu-exporting-test-"));
  db = openDb({ path: join(tmpDir, "mu.db") });
  // Renderer never invokes tmux, but destroyWorkstream does. Stub
  // out has-session / kill-session so the destroy-auto-export test
  // can run without a live tmux server.
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

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string, prefix: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(cur, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

function readManifest(outDir: string): ExportManifest {
  return JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as ExportManifest;
}

function seed(workstream: string, ids: string[]): void {
  for (const id of ids) {
    addTask(db, {
      localId: id,
      workstream,
      title: id.slice(0, 1).toUpperCase() + id.slice(1),
      impact: 50,
      effortDays: 1,
    });
  }
}

describe("renderToBucket — single workstream", () => {
  it("scaffolds a bucket and writes one source-ws subdir on first export", () => {
    seed("auth", ["design", "build"]);
    const outDir = join(tmpDir, "bucket");

    const result = exportWorkstream(db, { workstream: "auth", outDir });

    expect(result.written).toBe(2);
    expect(result.unchanged).toBe(0);
    expect(result.preserved).toBe(0);
    expect(listFiles(outDir)).toEqual([
      "INDEX.md",
      "README.md",
      "auth/INDEX.md",
      "auth/README.md",
      "auth/tasks/build.md",
      "auth/tasks/design.md",
      "manifest.json",
    ]);

    const manifest = readManifest(outDir);
    expect(manifest.bucketVersion).toBe(2);
    expect(manifest.bucketLabel).toBeNull();
    expect(Object.keys(manifest.sources)).toEqual(["auth"]);
    const auth = manifest.sources.auth;
    expect(auth).toBeDefined();
    if (!auth) throw new Error("unreachable");
    expect(auth.tasks.map((t) => t.id)).toEqual(["build", "design"]);
    expect(auth.tasks[0]?.path).toBe("auth/tasks/build.md");
  });

  it("re-exports the same source-ws with zero file rewrites (sha256 short-circuit)", async () => {
    seed("auth", ["design"]);
    const outDir = join(tmpDir, "bucket");

    exportWorkstream(db, { workstream: "auth", outDir });
    const beforeMtime = statSync(join(outDir, "auth/tasks/design.md")).mtimeMs;
    // Force a measurable mtime gap.
    await new Promise((r) => setTimeout(r, 25));

    const second = exportWorkstream(db, { workstream: "auth", outDir });
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(statSync(join(outDir, "auth/tasks/design.md")).mtimeMs).toBe(beforeMtime);
  });

  it("preserves a deleted task on disk with a one-time banner", () => {
    seed("auth", ["design", "build"]);
    const outDir = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir });

    deleteTask(db, "build", "auth");

    const second = exportWorkstream(db, { workstream: "auth", outDir });
    expect(second.preserved).toBe(1);
    const buildMd = readFileSync(join(outDir, "auth/tasks/build.md"), "utf8");
    expect(buildMd).toMatch(/^> \*\*Deleted from DB on /);

    // Re-export must NOT prepend a second banner.
    const third = exportWorkstream(db, { workstream: "auth", outDir });
    expect(third.preserved).toBe(1);
    const buildMd2 = readFileSync(join(outDir, "auth/tasks/build.md"), "utf8");
    expect((buildMd2.match(/Deleted from DB on/g) ?? []).length).toBe(1);
  });
});

describe("renderToBucket — additive across workstreams", () => {
  it("appends a second source-ws into an existing bucket without touching the first", async () => {
    seed("auth", ["design"]);
    seed("ui", ["mockup"]);
    const outDir = join(tmpDir, "bucket");

    exportWorkstream(db, { workstream: "auth", outDir });
    const authMtime = statSync(join(outDir, "auth/tasks/design.md")).mtimeMs;
    await new Promise((r) => setTimeout(r, 25));

    exportWorkstream(db, { workstream: "ui", outDir });

    expect(listFiles(outDir)).toEqual([
      "INDEX.md",
      "README.md",
      "auth/INDEX.md",
      "auth/README.md",
      "auth/tasks/design.md",
      "manifest.json",
      "ui/INDEX.md",
      "ui/README.md",
      "ui/tasks/mockup.md",
    ]);
    // First source-ws untouched.
    expect(statSync(join(outDir, "auth/tasks/design.md")).mtimeMs).toBe(authMtime);
    // Both sources tracked in manifest.
    const manifest = readManifest(outDir);
    expect(Object.keys(manifest.sources).sort()).toEqual(["auth", "ui"]);
  });

  it("manifest preserves bucketCreatedAt across additive re-exports", async () => {
    seed("auth", ["design"]);
    seed("ui", ["mockup"]);
    const outDir = join(tmpDir, "bucket");

    exportWorkstream(db, { workstream: "auth", outDir });
    const firstManifest = readManifest(outDir);
    const createdAt = firstManifest.bucketCreatedAt;
    await new Promise((r) => setTimeout(r, 25));

    exportWorkstream(db, { workstream: "ui", outDir });
    const secondManifest = readManifest(outDir);
    expect(secondManifest.bucketCreatedAt).toBe(createdAt);
    expect(secondManifest.bucketLastUpdatedAt > createdAt).toBe(true);
  });
});

describe("renderToBucket — refuses legacy pre-0.3 layout", () => {
  it("throws LegacyExportLayoutError when manifest.json has no bucketVersion + has top-level workstream", () => {
    const outDir = join(tmpDir, "legacy");
    mkdirSync(outDir);
    // Pre-0.3 single-source manifest shape.
    writeFileSync(
      join(outDir, "manifest.json"),
      JSON.stringify(
        {
          workstream: "auth",
          exportedAt: "2025-01-01T00:00:00.000Z",
          muVersion: "0.2.0",
          eventsSeqAtExport: 1,
          tasks: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => exportWorkstream(db, { workstream: "auth", outDir })).toThrow(
      LegacyExportLayoutError,
    );
  });
});

describe("exportArchive — bucket per (archive_id, source_workstream)", () => {
  it("renders one source-ws subdir per archive source", () => {
    seed("auth", ["design", "build"]);
    seed("ui", ["mockup"]);
    addNote(db, "design", "DECISION: JWT", { workstream: "auth" });

    createArchive(db, "release-v1");
    addToArchive(db, "release-v1", "auth");
    addToArchive(db, "release-v1", "ui");

    const outDir = join(tmpDir, "archive-bucket");
    const result = exportArchive(db, { label: "release-v1", outDir });

    expect(result.sourceCount).toBe(2);
    expect(listFiles(outDir)).toEqual([
      "INDEX.md",
      "README.md",
      "auth/INDEX.md",
      "auth/README.md",
      "auth/tasks/build.md",
      "auth/tasks/design.md",
      "manifest.json",
      "ui/INDEX.md",
      "ui/README.md",
      "ui/tasks/mockup.md",
    ]);
    const manifest = readManifest(outDir);
    expect(manifest.bucketVersion).toBe(2);
    expect(manifest.bucketLabel).toBe("release-v1");
    expect(Object.keys(manifest.sources).sort()).toEqual(["auth", "ui"]);

    // Notes survive the archive → bucket round trip.
    const designMd = readFileSync(join(outDir, "auth/tasks/design.md"), "utf8");
    expect(designMd).toMatch(/DECISION: JWT/);
  });

  it("re-export of the same archive is idempotent at the file level", async () => {
    seed("auth", ["design"]);
    createArchive(db, "release-v2");
    addToArchive(db, "release-v2", "auth");

    const outDir = join(tmpDir, "archive-bucket");
    exportArchive(db, { label: "release-v2", outDir });
    const beforeMtime = statSync(join(outDir, "auth/tasks/design.md")).mtimeMs;
    await new Promise((r) => setTimeout(r, 25));

    const second = exportArchive(db, { label: "release-v2", outDir });
    expect(second.written).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(statSync(join(outDir, "auth/tasks/design.md")).mtimeMs).toBe(beforeMtime);
  });
});

describe("destroyWorkstream auto-export", () => {
  it("destroy --yes path produces a bucket-shape export at the auto-export dir", async () => {
    seed("auth", ["design"]);
    addNote(db, "design", "FILES: src/auth.rs", { workstream: "auth" });

    // Replicate the CLI's autoExportDir contract: <state>/exports/<ws>-<ts>/.
    // We exercise it directly via exportWorkstream then destroy, since
    // the CLI's cmdDestroy path calls exportWorkstream with that dir.
    const exportDir = join(tmpDir, "exports", "auth-2026-stub");
    exportWorkstream(db, { workstream: "auth", outDir: exportDir });

    // Now destroy. The renderer's output should remain untouched and
    // still be readable as a v0.3 bucket.
    await destroyWorkstream(db, { workstream: "auth" });

    expect(existsSync(join(exportDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(exportDir, "auth/tasks/design.md"))).toBe(true);
    const manifest = readManifest(exportDir);
    expect(manifest.bucketVersion).toBe(2);
    expect(Object.keys(manifest.sources)).toEqual(["auth"]);

    const designMd = readFileSync(join(exportDir, "auth/tasks/design.md"), "utf8");
    expect(designMd).toMatch(/FILES: src\/auth.rs/);
  });
});
