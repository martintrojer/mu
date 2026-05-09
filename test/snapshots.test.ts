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
import { addApproval, denyApproval, grantApproval } from "../src/approvals.js";
import { CURRENT_SCHEMA_VERSION, type Db, defaultStateDir, openDb } from "../src/db.js";
import { reconcile } from "../src/reconcile.js";
import {
  CaptureSnapshotResult,
  SnapshotFileMissingError,
  SnapshotNotFoundError,
  SnapshotVersionMismatchError,
  captureSnapshot,
  gcSnapshots,
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
  addNote(db, "design", "DECISION: JWT");
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
    expect(row.workstream).toBe("auth");
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
    expect(row.workstream).toBeNull();
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
      expect(e.errorNextSteps().length).toBeGreaterThan(0);
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

// ─── (4) GC honours both caps ──────────────────────────────────────

describe("gcSnapshots — count cap AND age cap", () => {
  it("keeps everything when under both caps", () => {
    seedAuth();
    for (let i = 0; i < 5; i++) captureSnapshot(db, `s${i}`, "auth");
    const before = listSnapshots(db).length;
    const gc = gcSnapshots(db);
    expect(gc.deletedRows).toBe(0);
    expect(listSnapshots(db).length).toBe(before);
  });

  it("count cap (>100): only the 100 newest survive once they're also >14d old", () => {
    seedAuth();
    // Insert 105 rows directly with old created_at so the age cap
    // approves them as victims; only count-cap keeps the top 100.
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 105; i++) {
      stmt.run("auth", `old-${i}`, `/nope/${i}.db`, CURRENT_SCHEMA_VERSION, oldDate);
    }
    expect(listSnapshots(db).length).toBe(105);
    const gc = gcSnapshots(db);
    // 105 - 100 (count-protected) = 5 victims. (deletedFiles is 0
    // because we never wrote real .db files for these synthetic rows.)
    expect(gc.deletedRows).toBe(5);
    expect(listSnapshots(db).length).toBe(100);
  });

  it("age cap: rows <14d old survive even when there are >100", () => {
    seedAuth();
    // Insertion order matters — GC's count-cap protection is the top
    // 100 by id DESC. We insert OLD first (low ids), then FRESH
    // (high ids), so the count cap protects 100 of the most-recent
    // (60 fresh + 40 of the older). The remaining 10 OLD are NOT
    // count-protected; they are age-victims.
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 50; i++) {
      stmt.run("auth", `old-${i}`, `/x/o${i}.db`, CURRENT_SCHEMA_VERSION, old);
    }
    for (let i = 0; i < 60; i++) {
      stmt.run("auth", `fresh-${i}`, `/x/${i}.db`, CURRENT_SCHEMA_VERSION, fresh);
    }
    expect(listSnapshots(db).length).toBe(110);
    gcSnapshots(db);
    const after = listSnapshots(db);
    // All 60 fresh survived (age-protected); 40 most-recent of the
    // OLD set are also count-protected (within top 100 by id), the
    // bottom 10 OLD got reaped.
    expect(after.filter((r) => r.label.startsWith("fresh-")).length).toBe(60);
    expect(after.length).toBe(100);
  });

  it("captureSnapshot triggers GC opportunistically", () => {
    seedAuth();
    // Pre-populate with 105 ancient snapshot rows so the count+age
    // cap intersection has victims.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(
      "INSERT INTO snapshots (workstream, label, db_path, schema_version, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 105; i++) {
      stmt.run("auth", `seed-${i}`, `/x/${i}.db`, CURRENT_SCHEMA_VERSION, old);
    }
    expect(listSnapshots(db).length).toBe(105);
    captureSnapshot(db, "this triggers gc", "auth");
    // Now 100 (count cap honoured).
    expect(listSnapshots(db).length).toBe(100);
  });
});

// ─── Destructive-verb hooks (one test per verb) ───────────────────

describe("destructive verbs: snapshot is captured before mutation", () => {
  it("closeTask snapshots before the status flip", () => {
    seedAuth();
    expect(listSnapshots(db).length).toBe(0);
    closeTask(db, "design");
    const labels = listSnapshots(db).map((r) => r.label);
    expect(labels).toContain("task close design");
  });

  it("closeTask is a snapshot-no-op when the task is already CLOSED", () => {
    seedAuth();
    closeTask(db, "design");
    const beforeRetry = listSnapshots(db).length;
    closeTask(db, "design");
    expect(listSnapshots(db).length).toBe(beforeRetry);
  });

  it("rejectTask snapshots once even with --cascade across N children", () => {
    seedAuth();
    // design -> build (one dependent). cascade should snapshot once.
    rejectTask(db, "design", { cascade: true });
    const rejectSnaps = listSnapshots(db).filter((r) => r.label === "task reject design");
    expect(rejectSnaps.length).toBe(1);
  });

  it("deferTask snapshots before the status flip", () => {
    seedAuth();
    deferTask(db, "design", { cascade: true });
    expect(listSnapshots(db).map((r) => r.label)).toContain("task defer design");
  });

  it("releaseTask snapshots when ownership is non-trivial", () => {
    seedAuth();
    db.prepare(
      `UPDATE tasks SET owner_id = (SELECT id FROM agents WHERE name = 'worker-1')
        WHERE local_id = 'design'`,
    ).run();
    releaseTask(db, "design");
    expect(listSnapshots(db).map((r) => r.label)).toContain("task release design");
  });

  it("releaseTask is a snapshot-no-op when nothing changes", () => {
    seedAuth();
    // No owner, no --reopen → idempotent.
    releaseTask(db, "design");
    expect(listSnapshots(db).length).toBe(0);
  });

  it("deleteTask snapshots before the cascade", () => {
    seedAuth();
    deleteTask(db, "design");
    expect(listSnapshots(db).map((r) => r.label)).toContain("task delete design");
  });

  it("deleteTask is a snapshot-no-op for a missing task (idempotent)", () => {
    deleteTask(db, "nonexistent");
    expect(listSnapshots(db).length).toBe(0);
  });

  it("freeWorkspace path is exercised via destroyWorkstream below; here we test grantApproval", () => {
    seedAuth();
    addApproval(db, {
      slug: "deploy",
      reason: "ship to prod",
      requestedBy: "worker-1",
      workstream: "auth",
    });
    grantApproval(db, "deploy", { decidedBy: "user" });
    expect(listSnapshots(db).map((r) => r.label)).toContain("approval granted deploy");
  });

  it("denyApproval snapshots before the decision lands", () => {
    seedAuth();
    addApproval(db, {
      slug: "deploy2",
      reason: "ship to prod",
      requestedBy: "worker-1",
      workstream: "auth",
    });
    denyApproval(db, "deploy2", { decidedBy: "user" });
    expect(listSnapshots(db).map((r) => r.label)).toContain("approval denied deploy2");
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
    expect(destroyRow.workstream).toBeNull();
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
    await closeAgent(db, "worker-1");
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
    expect(getAgent(db, "dog-1")).toBeUndefined();
    expect(countWorkspacesForAgent(db, "dog-1")).toBe(0);

    // Restore. restoreSnapshot CLOSES the live db handle, so we re-open.
    restoreSnapshot(db, snap.id);
    db = openDb({ path: dbPath });

    // Sanity: the rows came back from the snapshot file.
    expect(getAgent(db, "dog-1")).toBeDefined();
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
    expect(getAgent(db, "dog-1")).toBeDefined();
    expect(getAgent(db, "worker-1")).toBeDefined();
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
    expect(getAgent(db, "dog-1")).toBeDefined(); // restored

    // mode:"full" is the OLD (mutating) behaviour. Documents what
    // the bug looked like before the report-only mode existed.
    mockTmuxAlive();
    await reconcile(db, { workstream: "auth", mode: "full" });

    // The recovered agent row is GONE again — the bug.
    expect(getAgent(db, "dog-1")).toBeUndefined();
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
