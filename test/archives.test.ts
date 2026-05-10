// Tests for src/archives.ts — Phase 1 SDK + the v5→v6 in-place
// schema migration. Real SQLite in a temp dir; no tmux needed
// (archives operate purely on DB state).
//
// Coverage map (mirrors the 11-case checklist in
// archive_phase1_schema_sdk task notes):
//
//   Round-trip:
//     1.  Create workstreams A and B with tasks (A: 3 tasks with
//         edges; B: 2 tasks).
//     2.  createArchive('w'); addToArchive('w', 'A'); addToArchive('w', 'B').
//     3.  Verify archived_tasks count = 5; edges preserved; cross-source
//         distinguishable via source_workstream column.
//     4.  Re-run addToArchive('w', 'A') — verify zero new rows
//         (idempotency).
//     5.  Add a new task to A; re-run — verify the new task is added.
//     6.  removeFromArchive('w', 'A') — only A's rows gone; B intact.
//     7.  deleteArchive('w') — cascade cleans every archived_* row.
//     8.  addToArchive against a destroyed workstream → throws
//         WorkstreamNotFoundError.
//     9.  createArchive with a duplicate label → throws
//         ArchiveAlreadyExistsError.
//
//   Migration:
//     10. Open a DB with schema_version=5 (no archived_* tables); call
//         openDb. Verify the v5→v6 in-place migration: tables exist,
//         schema_version=6, no other tables touched, workstreams +
//         tasks intact.
//     11. Pre-v5 DB still throws SchemaTooOldError (the floor stays v5).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArchiveAlreadyExistsError,
  ArchiveLabelInvalidError,
  ArchiveNotFoundError,
  addToArchive,
  createArchive,
  deleteArchive,
  getArchive,
  isValidArchiveLabel,
  listArchivedTasks,
  listArchives,
  removeFromArchive,
  searchArchives,
} from "../src/archives.js";
import { CURRENT_SCHEMA_VERSION, type Db, SchemaTooOldError, openDb } from "../src/db.js";
import { addNote, addTask } from "../src/tasks.js";
import { destroyWorkstream, ensureWorkstream } from "../src/workstream.js";

describe("archives SDK", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-archives-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── Label validation ──────────────────────────────────────────────

  it("isValidArchiveLabel accepts canonical shapes and rejects junk", () => {
    expect(isValidArchiveLabel("w")).toBe(true);
    expect(isValidArchiveLabel("auth-2026-q1")).toBe(true);
    expect(isValidArchiveLabel("rewrite_postmortem")).toBe(true);
    expect(isValidArchiveLabel("")).toBe(false);
    expect(isValidArchiveLabel("Has-Capitals")).toBe(false);
    expect(isValidArchiveLabel("1starts-with-digit")).toBe(false);
    expect(isValidArchiveLabel("has space")).toBe(false);
    expect(isValidArchiveLabel(`${"x".repeat(65)}`)).toBe(false);
  });

  it("createArchive rejects an invalid label with ArchiveLabelInvalidError", () => {
    expect(() => createArchive(db, "Bad Label!")).toThrow(ArchiveLabelInvalidError);
  });

  // ─── Round-trip cases 1–7 ─────────────────────────────────────────

  it("end-to-end round-trip: two workstreams under one archive (cases 1–7)", () => {
    // Case 1: workstreams A (3 tasks + 2 edges) and B (2 tasks + 1 edge).
    ensureWorkstream(db, "alpha");
    addTask(db, { localId: "a1", workstream: "alpha", title: "A1", impact: 80, effortDays: 1 });
    addTask(db, { localId: "a2", workstream: "alpha", title: "A2", impact: 50, effortDays: 1 });
    addTask(db, {
      localId: "a3",
      workstream: "alpha",
      title: "A3",
      impact: 60,
      effortDays: 2,
      blockedBy: ["a1", "a2"],
    });
    addNote(db, "a1", "first note", { workstream: "alpha", author: "worker-1" });
    addNote(db, "a3", "second note", { workstream: "alpha", author: "user" });

    ensureWorkstream(db, "beta");
    addTask(db, { localId: "b1", workstream: "beta", title: "B1", impact: 70, effortDays: 1 });
    addTask(db, {
      localId: "b2",
      workstream: "beta",
      title: "B2",
      impact: 40,
      effortDays: 1,
      blockedBy: ["b1"],
    });

    // Case 2: create the archive and add both workstreams.
    const archive = createArchive(db, "w", "round-trip test");
    expect(archive.label).toBe("w");
    expect(archive.description).toBe("round-trip test");

    const addA = addToArchive(db, "w", "alpha");
    expect(addA).toMatchObject({
      addedTasks: 3,
      skippedTasks: 0,
      addedEdges: 2,
      addedNotes: 2,
    });
    expect(addA.addedEvents).toBeGreaterThan(0);

    const addB = addToArchive(db, "w", "beta");
    expect(addB).toMatchObject({
      addedTasks: 2,
      skippedTasks: 0,
      addedEdges: 1,
      addedNotes: 0,
    });
    expect(addB.addedEvents).toBeGreaterThan(0);

    // Case 3: archived_tasks count = 5; cross-source distinguishable.
    const allRows = listArchivedTasks(db, "w");
    expect(allRows).toHaveLength(5);
    const sources = new Set(allRows.map((r) => r.sourceWorkstream));
    expect(sources).toEqual(new Set(["alpha", "beta"]));

    const alphaRows = listArchivedTasks(db, "w", { sourceWorkstream: "alpha" });
    expect(alphaRows.map((r) => r.originalLocalId).sort()).toEqual(["a1", "a2", "a3"]);
    const betaRows = listArchivedTasks(db, "w", { sourceWorkstream: "beta" });
    expect(betaRows.map((r) => r.originalLocalId).sort()).toEqual(["b1", "b2"]);

    // archived_at_status is pinned at archive time.
    expect(alphaRows.every((r) => r.archivedAtStatus === r.status)).toBe(true);
    // archived_edges round-trip: 3 total (2 from alpha, 1 from beta).
    const totalEdges = (
      db.prepare("SELECT COUNT(*) AS n FROM archived_edges").get() as {
        n: number;
      }
    ).n;
    expect(totalEdges).toBe(3);

    // Summary view groups per source workstream.
    const summary = getArchive(db, "w");
    expect(summary.totalTasks).toBe(5);
    expect(summary.sourceWorkstreams.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(summary.sourceWorkstreams.find((s) => s.name === "alpha")?.taskCount).toBe(3);
    expect(summary.sourceWorkstreams.find((s) => s.name === "beta")?.taskCount).toBe(2);

    // Case 4: re-running on alpha is a true no-op (idempotency).
    const reAddA = addToArchive(db, "w", "alpha");
    expect(reAddA).toEqual({
      addedTasks: 0,
      skippedTasks: 3,
      addedEdges: 0,
      addedNotes: 0,
      addedEvents: 0,
    });
    expect(listArchivedTasks(db, "w")).toHaveLength(5);

    // Case 5: add a new task to alpha; re-run picks it up.
    addTask(db, { localId: "a4", workstream: "alpha", title: "A4", impact: 30, effortDays: 1 });
    addNote(db, "a4", "fresh note", { workstream: "alpha", author: "worker-1" });
    const incremental = addToArchive(db, "w", "alpha");
    expect(incremental.addedTasks).toBe(1);
    expect(incremental.skippedTasks).toBe(3);
    expect(incremental.addedNotes).toBe(1);
    expect(listArchivedTasks(db, "w")).toHaveLength(6);

    // Case 6: removeFromArchive('w', 'alpha') strips alpha; beta intact.
    const removed = removeFromArchive(db, "w", "alpha");
    expect(removed.removedTasks).toBe(4);
    const after = listArchivedTasks(db, "w");
    expect(after.map((r) => r.sourceWorkstream)).toEqual(["beta", "beta"]);

    // Case 7: deleteArchive cascades through every archived_* table.
    deleteArchive(db, "w");
    expect(listArchives(db)).toHaveLength(0);
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM archived_tasks)  AS t,
           (SELECT COUNT(*) FROM archived_edges)  AS e,
           (SELECT COUNT(*) FROM archived_notes)  AS n,
           (SELECT COUNT(*) FROM archived_events) AS v`,
      )
      .get() as { t: number; e: number; n: number; v: number };
    expect(counts).toEqual({ t: 0, e: 0, n: 0, v: 0 });
  });

  // ─── Case 8: archive against destroyed workstream ─────────────────

  it("addToArchive against a destroyed workstream throws WorkstreamNotFoundError", async () => {
    ensureWorkstream(db, "doomed");
    addTask(db, {
      localId: "x1",
      workstream: "doomed",
      title: "X1",
      impact: 50,
      effortDays: 1,
    });
    createArchive(db, "post-mortem");
    // Destroy without archiving first; the workstream row is gone.
    // destroyWorkstream needs a tmuxSession override to be silent
    // about the unrelated tmux side; but it tolerates a missing
    // session anyway — pass our own to be explicit.
    await destroyWorkstream(db, { workstream: "doomed", tmuxSession: "mu-doomed-test-noexist" });

    // resolveWorkstreamId throws WorkstreamNotFoundError; we just
    // assert the name (cross-realm-safe duck-type).
    let caught: unknown;
    try {
      addToArchive(db, "post-mortem", "doomed");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe("WorkstreamNotFoundError");
  });

  // ─── Case 9: duplicate label rejection ────────────────────────────

  it("createArchive with a duplicate label throws ArchiveAlreadyExistsError", () => {
    createArchive(db, "dup");
    expect(() => createArchive(db, "dup")).toThrow(ArchiveAlreadyExistsError);
  });

  // ─── Read-side typed errors ───────────────────────────────────────

  it("getArchive on missing label throws ArchiveNotFoundError", () => {
    expect(() => getArchive(db, "ghost")).toThrow(ArchiveNotFoundError);
  });

  // ─── searchArchives ──────────────────────────────────────

  describe("searchArchives", () => {
    function seedTwoArchives(): void {
      ensureWorkstream(db, "alpha");
      addTask(db, {
        localId: "oauth",
        workstream: "alpha",
        title: "Implement OAuth flow",
        impact: 80,
        effortDays: 1,
      });
      addTask(db, {
        localId: "login",
        workstream: "alpha",
        title: "Wire login form",
        impact: 50,
        effortDays: 1,
      });
      addNote(db, "login", "reminder: refresh tokens still TODO", {
        workstream: "alpha",
        author: "user",
      });
      ensureWorkstream(db, "beta");
      addTask(db, {
        localId: "design",
        workstream: "beta",
        title: "Design dashboard",
        impact: 70,
        effortDays: 1,
      });
      createArchive(db, "wave-a");
      addToArchive(db, "wave-a", "alpha");
      createArchive(db, "wave-b");
      addToArchive(db, "wave-b", "beta");
    }

    it("matches by title only and returns matchKind='title' with a snippet", () => {
      seedTwoArchives();
      const hits = searchArchives(db, { pattern: "OAuth" });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.archiveLabel).toBe("wave-a");
      expect(hits[0]?.originalLocalId).toBe("oauth");
      expect(hits[0]?.matchKind).toBe("title");
      expect(hits[0]?.matchSnippet).toContain("OAuth");
    });

    it("matches by note content and surfaces the note snippet", () => {
      seedTwoArchives();
      const hits = searchArchives(db, { pattern: "refresh tokens" });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.matchKind).toBe("note");
      expect(hits[0]?.originalLocalId).toBe("login");
      expect(hits[0]?.matchSnippet).toContain("refresh tokens");
    });

    it("--label scopes the search to a single archive", () => {
      seedTwoArchives();
      // Without --label, both 'oauth' (wave-a) and 'design' (wave-b)
      // share no common pattern — use a substring that hits both.
      const all = searchArchives(db, { pattern: "e" });
      const labelsAcross = new Set(all.map((h) => h.archiveLabel));
      expect(labelsAcross.size).toBeGreaterThan(1);
      const onlyA = searchArchives(db, { pattern: "e", label: "wave-a" });
      expect(onlyA.every((h) => h.archiveLabel === "wave-a")).toBe(true);
      expect(onlyA.length).toBeGreaterThan(0);
    });

    it("--label nonexistent throws ArchiveNotFoundError", () => {
      seedTwoArchives();
      expect(() => searchArchives(db, { pattern: "x", label: "ghost" })).toThrow(
        ArchiveNotFoundError,
      );
    });

    it("--limit truncates the result set", () => {
      ensureWorkstream(db, "big");
      for (let i = 0; i < 8; i++) {
        addTask(db, {
          localId: `t${i}`,
          workstream: "big",
          title: `Match candidate ${i}`,
          impact: 50,
          effortDays: 1,
        });
      }
      createArchive(db, "big");
      addToArchive(db, "big", "big");
      const hits = searchArchives(db, { pattern: "Match", limit: 3 });
      expect(hits).toHaveLength(3);
    });

    it("empty pattern throws (defensive guard for direct callers)", () => {
      createArchive(db, "wave");
      expect(() => searchArchives(db, { pattern: "" })).toThrow();
      expect(() => searchArchives(db, { pattern: "   " })).toThrow();
    });

    it("SQL injection attempt does NOT drop archives table", () => {
      seedTwoArchives();
      const before = listArchives(db)
        .map((a) => a.label)
        .sort();
      // Pattern crafted to look dangerous if it were string-concatted
      // into the SQL. Bound as a parameter, so it just becomes a
      // literal LIKE needle that matches nothing.
      const malicious = "'); DROP TABLE archives; --";
      const hits = searchArchives(db, { pattern: malicious });
      expect(hits).toEqual([]);
      const after = listArchives(db)
        .map((a) => a.label)
        .sort();
      expect(after).toEqual(before);
      // Sanity: archives table still exists and is queryable.
      const tableRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='archives'")
        .get();
      expect(tableRow).toBeDefined();
    });

    it("prefers title over note when the same task matches both", () => {
      ensureWorkstream(db, "both");
      addTask(db, {
        localId: "x",
        workstream: "both",
        title: "alpha-keyword title",
        impact: 50,
        effortDays: 1,
      });
      addNote(db, "x", "also mentions alpha-keyword in the body", {
        workstream: "both",
        author: "user",
      });
      createArchive(db, "dup");
      addToArchive(db, "dup", "both");
      const hits = searchArchives(db, { pattern: "alpha-keyword" });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.matchKind).toBe("title");
    });
  });

  it("removeFromArchive on a workstream that never contributed is a no-op (zero counts)", () => {
    createArchive(db, "empty");
    const result = removeFromArchive(db, "empty", "nothing");
    expect(result).toEqual({
      removedTasks: 0,
      removedEdges: 0,
      removedNotes: 0,
      removedEvents: 0,
    });
  });
});

// ─── Schema migration cases 10–11 ─────────────────────────────────

describe("schema v5 → v6 in-place migration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-archive-mig-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("opens a v5-stamped DB and bumps it to current (v7) in-place; existing data intact (case 10)", () => {
    // Build a minimally v5-shaped DB with version=5 and one workstream
    // + one task. We don't replicate the full v5 schema — just enough
    // for openDb's pre-flight detector to read schema_version=5 (the
    // detector accepts any version it sees; the floor check is `<5`).
    {
      const raw = new Database(dbPath);
      raw.exec(
        `CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
         CREATE TABLE workstreams (
           id          INTEGER PRIMARY KEY AUTOINCREMENT,
           name        TEXT UNIQUE NOT NULL,
           created_at  TEXT NOT NULL
         );
         INSERT INTO schema_version (id, version) VALUES (1, 5);
         INSERT INTO workstreams (name, created_at) VALUES ('legacy', '2026-01-01T00:00:00Z');`,
      );
      raw.close();
    }

    // Open via mu — the v5→v6→v7 migrations run as part of applySchema.
    const db = openDb({ path: dbPath });
    try {
      const version = (
        db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
          version: number;
        }
      ).version;
      expect(version).toBe(CURRENT_SCHEMA_VERSION);

      // archive_* tables now exist.
      const tables = (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'archived_%' OR name='archives' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(tables).toEqual([
        "archived_edges",
        "archived_events",
        "archived_notes",
        "archived_tasks",
        "archives",
      ]);

      // Existing workstream data preserved.
      const ws = db.prepare("SELECT name FROM workstreams").all() as { name: string }[];
      expect(ws.map((r) => r.name)).toEqual(["legacy"]);

      // Re-opening is a no-op (version stays at the current schema, not bumped further).
      db.close();
      const db2 = openDb({ path: dbPath });
      try {
        const v2 = (
          db2.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
            version: number;
          }
        ).version;
        expect(v2).toBe(CURRENT_SCHEMA_VERSION);
      } finally {
        db2.close();
      }
    } finally {
      try {
        db.close();
      } catch {
        // already closed above on the re-open path
      }
    }
  });

  it("a pre-v5 DB still throws SchemaTooOldError (the floor stays v5; case 11)", () => {
    {
      const raw = new Database(dbPath);
      raw.exec(
        `CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
         INSERT INTO schema_version (id, version) VALUES (1, 4);`,
      );
      raw.close();
    }
    expect(() => openDb({ path: dbPath })).toThrow(SchemaTooOldError);
  });
});
