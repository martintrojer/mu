// Tests for src/snapshots.ts and the destructive-verb hooks.
//
// snap_design (note #293) §SHIP-LIST §5 names five test classes:
//   1. capture round-trip
//   2. restore version-mismatch reject
//   3. restore-then-list shows the pre-restore snapshot
//   4. GC honours both caps
//   5. whole-DB integrity
// All of them live here. The hook tests live alongside (one per
// destructive verb) so future drift in the verb set surfaces here.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAgent, getAgent, insertAgent } from "../src/agents.js";
import { CURRENT_SCHEMA_VERSION, type Db, openDb } from "../src/db.js";
import { reconcile } from "../src/reconcile.js";
import {
  SnapshotFileMissingError,
  SnapshotNotFoundError,
  SnapshotVersionMismatchError,
  captureSnapshot,
  gcSnapshots,
  isStaleVersion,
  listSnapshots,
  restoreSnapshot,
  snapshotsDir,
} from "../src/snapshots.js";
import {
  addNote,
  addTask,
  closeTask,
  deferTask,
  deleteTask,
  rejectTask,
  releaseTask,
} from "../src/tasks.js";
import {
  type TmuxExecResult,
  type TmuxExecutor,
  resetTmuxExecutor,
  setTmuxExecutor,
} from "../src/tmux.js";
import { destroyWorkstream, ensureWorkstream } from "../src/workstream.js";

// ─── Fixture: per-test state-dir + DB ──────────────────────────────

let stateDir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mu-snap-"));
  process.env.MU_STATE_DIR = stateDir;
  dbPath = join(stateDir, "mu.db");
  db = openDb({ path: dbPath });
});

afterEach(() => {
  try {
    db.close();
  } catch {}
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {}
  resetTmuxExecutor();
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

function ok(stdout = ""): TmuxExecResult {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr = ""): TmuxExecResult {
  return { exitCode: 1, stdout: "", stderr };
}
/** Minimal tmux mock for verbs that touch the substrate (closeAgent,
 *  destroyWorkstream). All sessions/panes are pretend-alive. */
function mockTmuxAlive(): void {
  const exec: TmuxExecutor = async (args) => {
    const verb = args[0];
    if (verb === "has-session") return ok();
    if (verb === "kill-session") return ok();
    if (verb === "kill-pane") return ok();
    if (verb === "list-sessions") return ok("");
    if (verb === "list-panes") return ok("");
    if (verb === "list-windows") return ok("");
    if (verb === "select-pane") return ok();
    if (verb === "set-window-option") return ok();
    if (verb === "display-message") return ok("");
    return fail(`unmocked tmux call: ${args.join(" ")}`);
  };
  setTmuxExecutor(exec);
}

function seedAuth(): void {
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  addTask(db, {
    localId: "design",
    workstream: "auth",
    title: "Design",
    impact: 80,
    effortDays: 2,
  });
  addTask(db, {
    localId: "build",
    workstream: "auth",
    title: "Build",
    impact: 80,
    effortDays: 5,
    blockedBy: ["design"],
  });
  addNote(db, "design", "DECISION: JWT", { workstream: "auth" });
}

// ─── (5) Whole-DB integrity ────────────────────────────────────────

describe("captureSnapshot — round-trip + integrity", () => {
  it("creates a flat <state-dir>/snapshots/<id>.db file", () => {
    seedAuth();
    const r = captureSnapshot(db, "task close design", "auth");
    expect(r.id).toBeGreaterThan(0);
    expect(r.dbPath).toBe(join(snapshotsDir(db), `${r.id}.db`));
    expect(existsSync(r.dbPath)).toBe(true);
    // No subdir under <state-dir>/snapshots/ — the layout is flat.
    expect(readdirSync(snapshotsDir(db)).every((f) => f.endsWith(".db"))).toBe(true);
  });

  it("appends a `snapshots` row with workstream + label + schema_version", () => {
    seedAuth();
    captureSnapshot(db, "task close design", "auth");
    const rows = listSnapshots(db);
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (!row) throw new Error("unreachable: rows.length checked above");
    expect(row.workstreamName).toBe("auth");
    expect(row.label).toBe("task close design");
    expect(row.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(row.dbPath).toMatch(/\/snapshots\/\d+\.db$/);
  });

  it("captures the live DB shape — opening the snapshot yields the same rows", () => {
    seedAuth();
    const r = captureSnapshot(db, "snap1", "auth");
    const snap = new Database(r.dbPath, { readonly: true });
    try {
      const tasks = snap.prepare("SELECT local_id, title FROM tasks ORDER BY local_id").all();
      expect(tasks).toEqual([
        { local_id: "build", title: "Build" },
        { local_id: "design", title: "Design" },
      ]);
      const notes = snap.prepare("SELECT content FROM task_notes ORDER BY id").all();
      expect(notes).toEqual([{ content: "DECISION: JWT" }]);
    } finally {
      snap.close();
    }
  });

  it("snapshot is independent of subsequent live-DB writes", () => {
    seedAuth();
    const r = captureSnapshot(db, "before-mutation", "auth");
    // Mutate the live DB.
    db.prepare("DELETE FROM tasks WHERE local_id = 'design'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    // Snapshot still has both tasks.
    const snap = new Database(r.dbPath, { readonly: true });
    try {
      expect(snap.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 });
    } finally {
      snap.close();
    }
  });

  it("nullable workstream — workstream-destroy snapshots use NULL", () => {
    seedAuth();
    captureSnapshot(db, "workstream destroy auth", null);
    const row = listSnapshots(db)[0];
    if (!row) throw new Error("unreachable: snapshot was just inserted");
    expect(row.workstreamName).toBeNull();
  });

  it("rolls back the row when VACUUM INTO fails (target dir is a file)", () => {
    seedAuth();
    // Replace the snapshots dir with a regular file so VACUUM INTO
    // fails when SQLite tries to mkdir-via-write.
    const dir = snapshotsDir(db);
    rmSync(dir, { recursive: true, force: true });
    require("node:fs").writeFileSync(dir, "not a dir\n");
    expect(() => captureSnapshot(db, "should fail", "auth")).toThrow();
    // Row was rolled back: no snapshots persisted.
    expect(listSnapshots(db)).toEqual([]);
  });
});

// ─── (1) capture round-trip — already covered above; here: list filters ─

describe("listSnapshots — filtering", () => {
  it("workstream filter returns matching rows AND null-workstream rows", () => {
    seedAuth();
    captureSnapshot(db, "destroy", null);
    captureSnapshot(db, "task close design", "auth");
    captureSnapshot(db, "task close other", "other-ws");
    const auth = listSnapshots(db, { workstream: "auth" }).map((r) => r.label);
    expect(auth).toContain("destroy");
    expect(auth).toContain("task close design");
    expect(auth).not.toContain("task close other");
  });

  it("limit caps the result count", () => {
    seedAuth();
    for (let i = 0; i < 5; i++) captureSnapshot(db, `s${i}`, "auth");
    expect(listSnapshots(db, { limit: 3 }).length).toBe(3);
  });

  it("orders newest first (id DESC)", () => {
    seedAuth();
    const ids = [
      captureSnapshot(db, "a", "auth").id,
      captureSnapshot(db, "b", "auth").id,
      captureSnapshot(db, "c", "auth").id,
    ];
    const listed = listSnapshots(db).map((r) => r.id);
    expect(listed).toEqual([...ids].reverse());
  });
});

// ─── (2) restore version-mismatch reject ───────────────────────────

describe("restoreSnapshot — version checks + errors", () => {
  it("throws SnapshotNotFoundError for missing id", () => {
    expect(() => restoreSnapshot(db, 9999)).toThrow(SnapshotNotFoundError);
  });

  it("throws SnapshotFileMissingError when the .db file was deleted", () => {
    seedAuth();
    const r = captureSnapshot(db, "snap", "auth");
    rmSync(r.dbPath);
    expect(() => restoreSnapshot(db, r.id)).toThrow(SnapshotFileMissingError);
  });

  it("throws SnapshotVersionMismatchError when schema_version doesn't match", () => {
    seedAuth();
    const r = captureSnapshot(db, "snap", "auth");
    // Mutate the row's schema_version to simulate an older snapshot
    // captured at a prior schema. Simulates: snapshot at v3, current
    // DB at v4. Same shape as the real cross-version path.
    db.prepare("UPDATE snapshots SET schema_version = ? WHERE id = ?").run(
      CURRENT_SCHEMA_VERSION - 1,
      r.id,
    );
    expect(() => restoreSnapshot(db, r.id)).toThrow(SnapshotVersionMismatchError);
  });

  it("error includes a NextStep suggesting newer snapshots", () => {
    seedAuth();
    const r = captureSnapshot(db, "snap", "auth");
    db.prepare("UPDATE snapshots SET schema_version = ? WHERE id = ?").run(
      CURRENT_SCHEMA_VERSION - 1,
      r.id,
    );
    try {
      restoreSnapshot(db, r.id);
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotVersionMismatchError);
      const e = err as SnapshotVersionMismatchError;
      expect(e.snapshotVersion).toBe(CURRENT_SCHEMA_VERSION - 1);
      expect(e.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
      const steps = e.errorNextSteps();
      expect(steps.length).toBeGreaterThan(0);
      // Regression: the inspect-snapshot hint must not reference a `--db`
      // flag — `mu sql` doesn't accept one and commander would exit 1.
      // The forensic snapshot is inspected via raw sqlite3 instead.
      for (const step of steps) {
        expect(step.command).not.toMatch(/mu sql\s+--db\b/);
      }
    }
  });
});

// ─── (3) restore-then-list shows the pre-restore snapshot ─────────

describe("restoreSnapshot — actual file swap + redo path", () => {
  it("restores DB rows from the snapshot; pre-restore snapshot is recorded", () => {
    seedAuth();
    // Capture, mutate, restore.
    const snap = captureSnapshot(db, "before deletion", "auth");
    db.prepare("DELETE FROM tasks WHERE local_id = 'design'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });

    const result = restoreSnapshot(db, snap.id);
    expect(result.id).toBe(snap.id);
    expect(result.restoredTo).toBe(dbPath);

    // Re-open and verify the restored state.
    db = openDb({ path: dbPath });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 });

    // The pre-restore snapshot of the post-mutation state is recorded
    // (snap_design §EDGE CASES > snapshot-of-snapshot — undo of undo).
    const all = listSnapshots(db);
    const labels = all.map((r) => r.label);
    expect(labels).toContain(`pre-restore of snapshot ${snap.id}`);
  });

  it("restoring removes -wal / -shm sidecars from the prior live DB", () => {
    seedAuth();
    // Force a checkpoint so the WAL file exists.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.prepare(
      `INSERT INTO task_notes (task_id, content, created_at)
         VALUES ((SELECT id FROM tasks WHERE local_id='design' LIMIT 1),'x',datetime('now'))`,
    ).run();
    const snap = captureSnapshot(db, "snap", "auth");
    const result = restoreSnapshot(db, snap.id);
    expect(existsSync(`${result.restoredTo}-wal`)).toBe(false);
    expect(existsSync(`${result.restoredTo}-shm`)).toBe(false);
  });
});

// ─── (4) GC honours both caps (count OR age, whichever fires) ─────────
//
// snapshot_gc_caps_too_lax_no_cleanup_verb: the prior implementation
// used the AND of the two caps (delete only if BOTH old AND past the
// count cap), which let the count cap effectively die under bursty use
// — the dogfood report observed 458 snapshots / 731MB after one day's
// mutation, none ever GC'd. The fix flips to OR: a row is deleted if
// it's past the count cap OR past the age cap, whichever fires first.
// Equivalently: keep a row only if it's BOTH within the top-N by id
// AND younger than the age cap.

describe("gcSnapshots — count cap OR age cap", () => {
  it("keeps everything when under both caps", () => {
    seedAuth();
    for (let i = 0; i < 5; i++) captureSnapshot(db, `s${i}`, "auth");
    const before = listSnapshots(db).length;
    const gc = gcSnapshots(db);
    expect(gc.deletedRows).toBe(0);
    expect(listSnapshots(db).length).toBe(before);
  });

  it("count-cap regression (snapshot_gc_caps_too_lax_no_cleanup_verb): >GC_MAX_COUNT" +
    " rows all <GC_MAX_AGE_DAYS old still trigger the count cap", () => {
    // The bug-report scenario: heavy dogfooding produces hundreds of
    // snapshots, all younger than the 14-day age cap. Pre-fix, the
    // age filter spared everything regardless of row count and the
    // 100-row cap NEVER fired. With the OR fix it does.
    seedAuth();
    const fresh = new Date().toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 105; i++) {
      stmt.run("auth", `fresh-${i}`, `/x/${i}.db`, CURRENT_SCHEMA_VERSION, fresh);
    }
    expect(listSnapshots(db).length).toBe(105);
    const gc = gcSnapshots(db);
    // 105 - 100 (top-100 count-protected) = 5 victims. The age cap
    // didn't fire (all rows fresh) — the count cap alone reaped them.
    expect(gc.deletedRows).toBe(5);
    expect(listSnapshots(db).length).toBe(100);
  });

  it("all rows old + over the count cap: every row is deleted (both caps fire)", () => {
    seedAuth();
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 105; i++) {
      stmt.run("auth", `old-${i}`, `/nope/${i}.db`, CURRENT_SCHEMA_VERSION, oldDate);
    }
    expect(listSnapshots(db).length).toBe(105);
    const gc = gcSnapshots(db);
    // All 105 rows are age-victims (>14d old). OR semantics: all
    // deleted (the docstring intent: keep top-N AND younger-than-D;
    // delete the rest). Under the prior AND impl this would have
    // been 5 — the AND-vs-OR bug.
    expect(gc.deletedRows).toBe(105);
    expect(listSnapshots(db).length).toBe(0);
  });

  it("age cap reaps old rows even when under the count cap", () => {
    seedAuth();
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 10; i++) {
      stmt.run("auth", `old-${i}`, `/x/o${i}.db`, CURRENT_SCHEMA_VERSION, old);
    }
    for (let i = 0; i < 5; i++) {
      stmt.run("auth", `fresh-${i}`, `/x/${i}.db`, CURRENT_SCHEMA_VERSION, fresh);
    }
    // Total 15 rows, way under the 100-row count cap.
    gcSnapshots(db);
    const after = listSnapshots(db);
    expect(after.filter((r) => r.label.startsWith("fresh-")).length).toBe(5);
    // All 10 old rows got reaped (age-victims); the 5 fresh survive.
    expect(after.length).toBe(5);
  });

  it("captureSnapshot triggers GC opportunistically", () => {
    seedAuth();
    // Pre-populate with 105 ancient snapshot rows. captureSnapshot
    // writes one fresh row, then GC reaps every old row (age-victims).
    // Only the fresh capture survives.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 105; i++) {
      stmt.run("auth", `seed-${i}`, `/x/${i}.db`, CURRENT_SCHEMA_VERSION, old);
    }
    expect(listSnapshots(db).length).toBe(105);
    captureSnapshot(db, "this triggers gc", "auth");
    expect(listSnapshots(db).length).toBe(1);
  });

  it("env override: MU_SNAPSHOT_KEEP_LAST narrows the count cap", () => {
    seedAuth();
    const key = "MU_SNAPSHOT_KEEP_LAST";
    process.env[key] = "3";
    try {
      const stmt = db.prepare(
        "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      const fresh = new Date().toISOString();
      for (let i = 0; i < 5; i++) {
        stmt.run("auth", `s${i}`, `/x/${i}.db`, CURRENT_SCHEMA_VERSION, fresh);
      }
      const gc = gcSnapshots(db);
      expect(gc.deletedRows).toBe(2);
      expect(listSnapshots(db).length).toBe(3);
    } finally {
      delete process.env[key];
    }
  });

  it("env override: MU_SNAPSHOT_MAX_AGE_DAYS narrows the age cap", () => {
    seedAuth();
    const key = "MU_SNAPSHOT_MAX_AGE_DAYS";
    // 0 days = anything older than now is a victim.
    process.env[key] = "0";
    try {
      const stmt = db.prepare(
        "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 3; i++) {
        stmt.run("auth", `s${i}`, `/x/${i}.db`, CURRENT_SCHEMA_VERSION, yesterday);
      }
      const gc = gcSnapshots(db);
      expect(gc.deletedRows).toBe(3);
      expect(listSnapshots(db).length).toBe(0);
    } finally {
      delete process.env[key];
    }
  });

  it("env override: bad input falls back to default (no throw)", () => {
    // Mirrors the MU_SPAWN_LIVENESS_MS / MU_IDLE_THRESHOLD_MS pattern
    // — a typo'd env var should not crash auto-GC inside a destructive
    // verb's hot path.
    const k1 = "MU_SNAPSHOT_KEEP_LAST";
    const k2 = "MU_SNAPSHOT_MAX_AGE_DAYS";
    process.env[k1] = "not-a-number";
    process.env[k2] = "-7";
    try {
      seedAuth();
      // Under defaults (100/14), 5 fresh rows + 0 victims is fine.
      for (let i = 0; i < 5; i++) captureSnapshot(db, `s${i}`, "auth");
      const gc = gcSnapshots(db);
      expect(gc.deletedRows).toBe(0);
    } finally {
      delete process.env[k1];
      delete process.env[k2];
    }
  });
});

// ─── (6) gcMaxCount / gcMaxAgeDays env readers ─────────────────────────

describe("gcMaxCount / gcMaxAgeDays — env tunables", () => {
  it("defaults to 100 / 14 when env unset", async () => {
    const m = await import("../src/snapshots.js");
    const k1 = "MU_SNAPSHOT_KEEP_LAST";
    const k2 = "MU_SNAPSHOT_MAX_AGE_DAYS";
    delete process.env[k1];
    delete process.env[k2];
    expect(m.gcMaxCount()).toBe(100);
    expect(m.gcMaxAgeDays()).toBe(14);
  });

  it("empty string falls back to default (typo'd `KEY=` line)", async () => {
    const m = await import("../src/snapshots.js");
    const k1 = "MU_SNAPSHOT_KEEP_LAST";
    process.env[k1] = "";
    try {
      expect(m.gcMaxCount()).toBe(100);
    } finally {
      delete process.env[k1];
    }
  });

  it("valid override is read back", async () => {
    const m = await import("../src/snapshots.js");
    const k1 = "MU_SNAPSHOT_KEEP_LAST";
    const k2 = "MU_SNAPSHOT_MAX_AGE_DAYS";
    process.env[k1] = "42";
    process.env[k2] = "3";
    try {
      expect(m.gcMaxCount()).toBe(42);
      expect(m.gcMaxAgeDays()).toBe(3);
    } finally {
      delete process.env[k1];
      delete process.env[k2];
    }
  });
});

// ─── Destructive-verb hooks (one test per verb) ───────────────────

describe("destructive verbs: snapshot is captured before mutation", () => {
  it("closeTask snapshots before the status flip", () => {
    seedAuth();
    expect(listSnapshots(db).length).toBe(0);
    closeTask(db, "design", { workstream: "auth" });
    const labels = listSnapshots(db).map((r) => r.label);
    expect(labels).toContain("task close design");
  });

  it("closeTask is a snapshot-no-op when the task is already CLOSED", () => {
    seedAuth();
    closeTask(db, "design", { workstream: "auth" });
    const beforeRetry = listSnapshots(db).length;
    closeTask(db, "design", { workstream: "auth" });
    expect(listSnapshots(db).length).toBe(beforeRetry);
  });

  it("rejectTask snapshots once even with --cascade across N children", () => {
    seedAuth();
    // design -> build (one dependent). cascade should snapshot once.
    rejectTask(db, "design", { cascade: true, workstream: "auth" });
    const rejectSnaps = listSnapshots(db).filter((r) => r.label === "task reject design");
    expect(rejectSnaps.length).toBe(1);
  });

  it("deferTask snapshots before the status flip", () => {
    seedAuth();
    deferTask(db, "design", { cascade: true, workstream: "auth" });
    expect(listSnapshots(db).map((r) => r.label)).toContain("task defer design");
  });

  it("releaseTask snapshots when ownership is non-trivial", () => {
    seedAuth();
    db.prepare(
      `UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'worker-1')
        WHERE local_id = 'design'`,
    ).run();
    releaseTask(db, "design", { workstream: "auth" });
    expect(listSnapshots(db).map((r) => r.label)).toContain("task release design");
  });

  it("releaseTask is a snapshot-no-op when nothing changes", () => {
    seedAuth();
    // No owner, no --reopen → idempotent.
    releaseTask(db, "design", { workstream: "auth" });
    expect(listSnapshots(db).length).toBe(0);
  });

  it("deleteTask snapshots before the cascade", () => {
    seedAuth();
    deleteTask(db, "design", "auth");
    expect(listSnapshots(db).map((r) => r.label)).toContain("task delete design");
  });

  it("deleteTask is a snapshot-no-op for a missing task (idempotent)", () => {
    deleteTask(db, "nonexistent", "auth");
    expect(listSnapshots(db).length).toBe(0);
  });

  it("destroyWorkstream snapshots whole-DB (workstream=null) before the FK cascade", async () => {
    mockTmuxAlive();
    seedAuth();
    await destroyWorkstream(db, { workstream: "auth" });
    const destroyRow = listSnapshots(db).find((r) => r.label === "workstream destroy auth");
    if (!destroyRow) throw new Error("expected destroy snapshot to be present");
    // Critical: the snapshot row survives the FK cascade because
    // there's deliberately no FK on snapshots.workstream
    // (snap_design note #293).
    expect(destroyRow.workstreamName).toBeNull();
    // And the snapshot file contains the pre-destroy state of the
    // workstream's tasks.
    const snap = new Database(destroyRow.dbPath, { readonly: true });
    try {
      const n = snap
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks t
             JOIN workstreams ws ON ws.id = t.workstream_id
            WHERE ws.name = 'auth'`,
        )
        .get() as { n: number };
      expect(n.n).toBe(2);
    } finally {
      snap.close();
    }
  });

  it("closeAgent snapshots before the row delete + workspace ripple", async () => {
    mockTmuxAlive();
    seedAuth();
    await closeAgent(db, "worker-1", { workstream: "auth" });
    expect(listSnapshots(db).map((r) => r.label)).toContain("agent close worker-1");
  });
});

// ─── Migration: v3 -> v4 adds the table ──────────────────────────

describe("migration v3 -> v4: snapshots table", () => {
  it("fresh DB has the snapshots table at CURRENT_SCHEMA_VERSION", () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual(["snapshots"]);
    const ver = db.prepare("SELECT version FROM schema_version").get() as { version: number };
    expect(ver.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("the snapshots table has NO foreign key on workstream (by design)", () => {
    const fks = db.prepare("SELECT * FROM pragma_foreign_key_list('snapshots')").all();
    expect(fks).toEqual([]);
  });
});

// ─── snap_undo_reconcile_destroys_recovered_agents (snap_dogfood Finding 2) ──
//
// End-to-end regression test for the contract `mu undo` advertises:
// the restore brings back the snapshot's rows verbatim, and the
// post-restore reconcile pass MUST NOT mutate them.
//
// Pre-fix behaviour (what dogfood-snap caught):
//   1. Insert agent + vcs_workspaces row.
//   2. Take a snapshot ("workstream destroy auth").
//   3. Delete the agent (simulating destroy + FK cascade).
//   4. restoreSnapshot brings back the agent + vcs_workspaces rows.
//   5. A FRESH reconcile pass with dryRun=false would prune the
//      agent (its pane is dead in the mocked tmux) and FK CASCADE
//      would silently drop the vcs_workspaces row too.
//
// Post-fix:
//   - reconcile(db, { mode: "report-only" }) reports the
//     would-be-prune COUNT but doesn't delete and doesn't write to
//     the DB or to tmux titles. The agent + workspace rows survive
//     the entire restore-and-reconcile cycle.

describe("snap_undo_reconcile_destroys_recovered_agents (regression)", () => {
  it("restore + report-only reconcile preserves the agent row whose pane is dead", async () => {
    seedAuth();
    insertAgent(db, { name: "dog-1", workstream: "auth", paneId: "%2919", status: "needs_input" });
    insertVcsWorkspaceRowSnap(db, {
      agent: "dog-1",
      workstream: "auth",
      backend: "git",
      path: "/tmp/dogfood-test/dog-1",
    });

    // Snapshot now (mirrors a pre-destroy snapshot).
    const snap = captureSnapshot(db, "workstream destroy auth", null);

    // Simulate destroy + cascade: drop the agent (which CASCADEs
    // the vcs_workspaces row away).
    db.prepare("DELETE FROM agents WHERE name = 'dog-1'").run();
    expect(getAgent(db, "dog-1", "auth")).toBeUndefined();
    expect(countWorkspacesForAgent(db, "dog-1")).toBe(0);

    // Restore. restoreSnapshot CLOSES the live db handle, so we re-open.
    restoreSnapshot(db, snap.id);
    db = openDb({ path: dbPath });

    // Sanity: the rows came back from the snapshot file.
    expect(getAgent(db, "dog-1", "auth")).toBeDefined();
    expect(countWorkspacesForAgent(db, "dog-1")).toBe(1);

    // Now run the post-restore reconcile pass that `mu undo` runs.
    // tmux is empty (the destroy killed the pane). mode:"report-only"
    // is load-bearing: without it, dog-1's row would be pruned (pane
    // is dead) and the workspace would FK-CASCADE away.
    mockTmuxAlive();
    const report = await reconcile(db, { workstream: "auth", mode: "report-only" });

    expect(report.mode).toBe("report-only");
    // seedAuth() inserts worker-1 (pane %1, also dead in mock) AND we
    // inserted dog-1 (pane %2919). Both are reported as would-be-pruned
    // but neither is actually deleted.
    expect(report.prunedGhosts).toBe(2);
    expect(getAgent(db, "dog-1", "auth")).toBeDefined();
    expect(getAgent(db, "worker-1", "auth")).toBeDefined();
    expect(countWorkspacesForAgent(db, "dog-1")).toBe(1);
  });

  it("counter-test: same scenario in mode:'full' loses the rows (proves the fix is load-bearing)", async () => {
    seedAuth();
    insertAgent(db, { name: "dog-1", workstream: "auth", paneId: "%2919", status: "needs_input" });
    insertVcsWorkspaceRowSnap(db, {
      agent: "dog-1",
      workstream: "auth",
      backend: "git",
      path: "/tmp/dogfood-test2/dog-1",
    });
    const snap = captureSnapshot(db, "workstream destroy auth", null);
    db.prepare("DELETE FROM agents WHERE name = 'dog-1'").run();

    restoreSnapshot(db, snap.id);
    db = openDb({ path: dbPath });
    expect(getAgent(db, "dog-1", "auth")).toBeDefined(); // restored

    // mode:"full" is the OLD (mutating) behaviour. Documents what
    // the bug looked like before the report-only mode existed.
    mockTmuxAlive();
    await reconcile(db, { workstream: "auth", mode: "full" });

    // The recovered agent row is GONE again — the bug.
    expect(getAgent(db, "dog-1", "auth")).toBeUndefined();
    // And FK CASCADE took the workspace too.
    expect(countWorkspacesForAgent(db, "dog-1")).toBe(0);
  });

  // v5 helpers used by the two regression tests above.
  function insertVcsWorkspaceRowSnap(
    db: Db,
    args: { agent: string; workstream: string; backend: string; path: string },
  ): void {
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name = ?").get(args.workstream) as {
        id: number;
      }
    ).id;
    const agId = (
      db
        .prepare("SELECT id FROM agents WHERE name = ? AND workstream_id = ?")
        .get(args.agent, wsId) as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(agId, wsId, args.backend, args.path);
  }

  function countWorkspacesForAgent(db: Db, agent: string): number {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM vcs_workspaces v
           JOIN agents a ON a.id = v.agent_id
          WHERE a.name = ?`,
      )
      .get(agent) as { n: number };
    return row.n;
  }
});

// ─── snapshot_gc_caps_too_lax_no_cleanup_verb: prune + delete SDK ──
//
// pruneSnapshots() and deleteSnapshot() are the manual cleanup verbs
// the dogfood report named (the auto-GC alone left 458 rows on disk
// because of the AND-vs-OR bug). isStaleVersion() backs the dimmed
// row in `mu snapshot list` and the --stale-version mode of prune.

describe("isStaleVersion — schema_version != current", () => {
  it("returns false on a freshly captured snapshot", () => {
    seedAuth();
    const r = captureSnapshot(db, "snap", "auth");
    const rows = listSnapshots(db);
    const row = rows.find((x) => x.id === r.id);
    if (!row) throw new Error("unreachable");
    expect(isStaleVersion(row)).toBe(false);
  });
  it("returns true when a row's schema_version is bumped down", () => {
    seedAuth();
    const r = captureSnapshot(db, "snap", "auth");
    db.prepare("UPDATE snapshots SET schema_version = ? WHERE id = ?").run(
      CURRENT_SCHEMA_VERSION - 1,
      r.id,
    );
    const rows = listSnapshots(db);
    const row = rows.find((x) => x.id === r.id);
    if (!row) throw new Error("unreachable");
    expect(isStaleVersion(row)).toBe(true);
  });
});

describe("pruneSnapshots — bulk policy-driven cleanup", () => {
  it("mode='gc' is equivalent to gcSnapshots() + a structured result", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    const fresh = new Date().toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 105; i++) {
      stmt.run("auth", `s${i}`, `/x/${i}.db`, CURRENT_SCHEMA_VERSION, fresh);
    }
    const r = m.pruneSnapshots(db, { mode: "gc" });
    expect(r.deletedRows).toBe(5);
    expect(r.victims.length).toBe(5);
  });

  it("mode='keep-last' keeps only the N newest", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    for (let i = 0; i < 8; i++) captureSnapshot(db, `s${i}`, "auth");
    const before = listSnapshots(db).length;
    expect(before).toBe(8);
    const r = m.pruneSnapshots(db, { mode: "keep-last", keepLast: 3 });
    expect(r.deletedRows).toBe(5);
    expect(listSnapshots(db).length).toBe(3);
  });

  it("mode='keep-last' rejects invalid keepLast", async () => {
    const m = await import("../src/snapshots.js");
    expect(() => m.pruneSnapshots(db, { mode: "keep-last" })).toThrow(m.PruneOptionsInvalidError);
    expect(() => m.pruneSnapshots(db, { mode: "keep-last", keepLast: -1 })).toThrow(
      m.PruneOptionsInvalidError,
    );
  });

  it("mode='older-than' keeps fresh rows; reaps old", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 4; i++)
      stmt.run("auth", `old-${i}`, `/x/o${i}.db`, CURRENT_SCHEMA_VERSION, old);
    for (let i = 0; i < 3; i++)
      stmt.run("auth", `f-${i}`, `/x/f${i}.db`, CURRENT_SCHEMA_VERSION, fresh);
    const r = m.pruneSnapshots(db, { mode: "older-than", olderThanDays: 7 });
    expect(r.deletedRows).toBe(4);
    expect(
      listSnapshots(db)
        .map((x) => x.label)
        .every((l) => l.startsWith("f-")),
    ).toBe(true);
  });

  it("mode='older-than' rejects invalid days", async () => {
    const m = await import("../src/snapshots.js");
    expect(() => m.pruneSnapshots(db, { mode: "older-than" })).toThrow(m.PruneOptionsInvalidError);
    expect(() => m.pruneSnapshots(db, { mode: "older-than", olderThanDays: -1 })).toThrow(
      m.PruneOptionsInvalidError,
    );
  });

  it("mode='stale-version' drops rows with schema_version != current", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    const a = captureSnapshot(db, "fresh-1", "auth");
    const b = captureSnapshot(db, "fresh-2", "auth");
    const c = captureSnapshot(db, "stale", "auth");
    // Bump c's row down to simulate stale version.
    db.prepare("UPDATE snapshots SET schema_version = ? WHERE id = ?").run(
      CURRENT_SCHEMA_VERSION - 1,
      c.id,
    );
    const r = m.pruneSnapshots(db, { mode: "stale-version" });
    expect(r.deletedRows).toBe(1);
    expect(r.victims.map((v) => v.id)).toEqual([c.id]);
    const remaining = listSnapshots(db).map((x) => x.id);
    expect(remaining).toContain(a.id);
    expect(remaining).toContain(b.id);
    expect(remaining).not.toContain(c.id);
  });

  it("mode='all' captures a safety-net snapshot first; safety-net survives", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    captureSnapshot(db, "a", "auth");
    captureSnapshot(db, "b", "auth");
    captureSnapshot(db, "c", "auth");
    const before = listSnapshots(db);
    expect(before.length).toBe(3);
    const r = m.pruneSnapshots(db, { mode: "all" });
    // Three originals deleted; safety-net survives.
    const after = listSnapshots(db);
    expect(after.length).toBe(1);
    expect(r.safetyNetSnapshotId).toBeDefined();
    expect(after[0]?.id).toBe(r.safetyNetSnapshotId);
    expect(after[0]?.label).toMatch(/safety-net/);
    // The safety-net itself isn't in `victims` (captured AFTER the
    // victim selection).
    expect(r.victims.map((v) => v.id)).toEqual(before.map((x) => x.id));
    expect(r.deletedRows).toBe(3);
  });

  it("dryRun=true returns the would-delete shape without touching anything", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    for (let i = 0; i < 5; i++) captureSnapshot(db, `s${i}`, "auth");
    const before = listSnapshots(db).length;
    const r = m.pruneSnapshots(db, { mode: "keep-last", keepLast: 2, dryRun: true });
    expect(r.deletedRows).toBe(0);
    expect(r.deletedFiles).toBe(0);
    expect(r.victims.length).toBe(3);
    expect(r.freedBytes).toBeGreaterThan(0);
    // Nothing actually changed.
    expect(listSnapshots(db).length).toBe(before);
  });

  it("freedBytes counts bytes from on-disk files; orphan-row contributes 0", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    const a = captureSnapshot(db, "a", "auth");
    captureSnapshot(db, "b", "auth");
    // Delete a's file from disk to simulate an orphan row.
    const fs = await import("node:fs");
    fs.unlinkSync(a.dbPath);
    const r = m.pruneSnapshots(db, { mode: "all" });
    // Three deleted (a, b, then the safety-net captured before? no
    // — safety-net survives. So 2 victims).
    expect(r.victims.length).toBe(2);
    // freedBytes is from b's file only (a's was already gone).
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(r.deletedFiles).toBe(1);
  });
});

describe("deleteSnapshot — surgical removal", () => {
  it("removes the row + the on-disk .db file", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    const a = captureSnapshot(db, "a", "auth");
    expect(existsSync(a.dbPath)).toBe(true);
    const r = m.deleteSnapshot(db, a.id);
    expect(r.deleted).toBe(true);
    expect(r.deletedFiles).toBe(1);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(existsSync(a.dbPath)).toBe(false);
    expect(listSnapshots(db).find((x) => x.id === a.id)).toBeUndefined();
  });

  it("missing id throws SnapshotNotFoundError", async () => {
    const m = await import("../src/snapshots.js");
    expect(() => m.deleteSnapshot(db, 9999)).toThrow(SnapshotNotFoundError);
  });

  it("orphan-row (file gone) removes the row anyway; deletedFiles=0", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    const a = captureSnapshot(db, "a", "auth");
    rmSync(a.dbPath);
    const r = m.deleteSnapshot(db, a.id);
    expect(r.deleted).toBe(true);
    expect(r.deletedFiles).toBe(0);
    expect(r.freedBytes).toBe(0);
    expect(listSnapshots(db).find((x) => x.id === a.id)).toBeUndefined();
  });

  it("does NOT auto-snapshot before deleting (the point is to delete one row)", async () => {
    const m = await import("../src/snapshots.js");
    seedAuth();
    const a = captureSnapshot(db, "a", "auth");
    captureSnapshot(db, "b", "auth");
    const before = listSnapshots(db).length;
    expect(before).toBe(2);
    m.deleteSnapshot(db, a.id);
    const after = listSnapshots(db).length;
    // Was 2; deleted one; still 1 (no new auto-snapshot row).
    expect(after).toBe(1);
  });
});
