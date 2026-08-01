// Tests for src/rebuild.ts — replaying the ops log into a fresh DB.
//
// The disaster-recovery path, so the bar is "the rebuilt DB is
// indistinguishable from the source for every portable table". Row-by-row
// comparison throughout: a count-only assertion would pass on a garbage
// rebuild that produced the right number of wrong rows.

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  RebuildTargetExistsError,
  RebuildTargetIsSourceError,
  rebuildInto,
} from "../src/rebuild.js";
import { emitEvent } from "../src/logs.js";
import { addBlockEdge, removeBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, deleteTask, updateTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

describe("rebuildInto", () => {
  let tempDir: string;
  let sourcePath: string;
  let db: Db;
  let counter = 0;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-rebuild-test-"));
    sourcePath = join(tempDir, "source.db");
    db = openDb({ path: sourcePath });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(tempDir);
  });

  const targetPath = (): string => join(tempDir, `rebuilt-${++counter}.db`);

  /** Build a representative source DB using the REAL verbs, so the ops
   *  being replayed are exactly what capture produces in production. */
  const seedRealisticSource = (): void => {
    ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: "a", title: "A", impact: 60, effortDays: 1 });
    addTask(db, { workstream: "demo", localId: "b", title: "B", impact: 40, effortDays: 2 });
    addTask(db, { workstream: "demo", localId: "c", title: "C", impact: 20, effortDays: 3 });
    addBlockEdge(db, "demo", "b", "a");
    addNote(db, "a", "context note", { workstream: "demo", author: "worker-1" });
    addNote(db, "b", "second note", { workstream: "demo" });
    updateTask(db, "c", { impact: 95, title: "C renamed" }, { workstream: "demo" });
    closeTask(db, "a", { workstream: "demo" });
    // Log-only ops: agent lifecycle mutates NO portable table, so no
    // trigger can capture it and applyOp refuses the entity. They are
    // still this machine's own history, so a rebuild must keep them.
    // (v2 R7 retired the old entity='event' rows these tests used to
    // seed; agent.* is the surviving log-only shape.)
    emitEvent(db, "demo", "agent.spawn", "agent spawn worker-1", "system");
    emitEvent(db, "demo", "agent.close", "agent close worker-1", "system");
  };

  /** Portable-table snapshots, joined to natural keys so the comparison
   *  does not depend on surrogate id assignment order. */
  const portableSnapshot = (conn: Db) => ({
    workstreams: conn.prepare("SELECT name, created_at FROM workstreams ORDER BY name").all(),
    tasks: conn
      .prepare(
        `SELECT w.name AS ws, t.local_id, t.title, t.status, t.impact, t.effort_days,
                t.owner_id, t.created_at, t.updated_at
           FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
          ORDER BY w.name, t.local_id`,
      )
      .all(),
    notes: conn
      .prepare(
        `SELECT w.name AS ws, t.local_id, n.author, n.content, n.created_at
           FROM task_notes n
           JOIN tasks t ON t.id = n.task_id
           JOIN workstreams w ON w.id = t.workstream_id
          ORDER BY w.name, t.local_id, n.content`,
      )
      .all(),
    edges: conn
      .prepare(
        `SELECT wf.name AS from_ws, f.local_id AS from_id,
                wt.name AS to_ws,   t.local_id AS to_id, e.created_at
           FROM task_edges e
           JOIN tasks f ON f.id = e.from_task_id
           JOIN tasks t ON t.id = e.to_task_id
           JOIN workstreams wf ON wf.id = f.workstream_id
           JOIN workstreams wt ON wt.id = t.workstream_id
          ORDER BY from_ws, from_id, to_ws, to_id`,
      )
      .all(),
  });

  const withTarget = <T>(path: string, fn: (conn: Db) => T): T => {
    const conn = openDb({ path });
    try {
      return fn(conn);
    } finally {
      conn.close();
    }
  };

  // ─── the round trip ──────────────────────────────────────────────────

  describe("round trip", () => {
    it("reproduces every portable table row-for-row", () => {
      seedRealisticSource();
      const path = targetPath();
      rebuildInto(db, { targetPath: path });

      const before = portableSnapshot(db);
      const after = withTarget(path, portableSnapshot);

      // Row-by-row on every portable table, not counts.
      expect(after.workstreams).toEqual(before.workstreams);
      expect(after.tasks).toEqual(before.tasks);
      expect(after.notes).toEqual(before.notes);
      expect(after.edges).toEqual(before.edges);
      // Sanity: the fixture is actually non-trivial, so the assertions
      // above are not vacuously comparing empty arrays.
      expect(before.tasks.length).toBe(3);
      expect(before.notes.length).toBe(2);
      expect(before.edges.length).toBe(1);
    });

    it("carries an updated field's final value, not its first", () => {
      // Guards replay ORDER: the update op must land after the insert.
      seedRealisticSource();
      const path = targetPath();
      rebuildInto(db, { targetPath: path });
      const row = withTarget(path, (conn) =>
        conn.prepare("SELECT title, impact FROM tasks WHERE local_id = 'c'").get(),
      );
      expect(row).toMatchObject({ title: "C renamed", impact: 95 });
    });

    it("carries a closed status", () => {
      seedRealisticSource();
      const path = targetPath();
      rebuildInto(db, { targetPath: path });
      const row = withTarget(path, (conn) =>
        conn.prepare("SELECT status FROM tasks WHERE local_id = 'a'").get(),
      );
      expect(row).toMatchObject({ status: "CLOSED" });
    });

    it("rebuilds an empty DB without error", () => {
      const path = targetPath();
      const report = rebuildInto(db, { targetPath: path });
      expect(report.opsCopied).toBe(0);
      expect(report.rebuiltRows.tasks).toBe(0);
    });
  });

  // ─── tombstones survive the rebuild ──────────────────────────────────

  describe("tombstones", () => {
    it("a deleted row STAYS deleted after rebuild", () => {
      seedRealisticSource();
      deleteTask(db, "c", "demo");
      const path = targetPath();
      const report = rebuildInto(db, { targetPath: path });

      const ids = withTarget(path, (conn) =>
        (
          conn.prepare("SELECT local_id FROM tasks ORDER BY local_id").all() as {
            local_id: string;
          }[]
        ).map((r) => r.local_id),
      );
      expect(ids).toEqual(["a", "b"]);
      expect(report.rebuiltRows.tasks).toBe(2);
    });

    it("a deleted-then-re-added row (resurrection) ends up PRESENT", () => {
      seedRealisticSource();
      deleteTask(db, "c", "demo");
      // Re-add under the same natural key. The new insert's HLC is newer
      // than the tombstone, so replay must resurrect it.
      addTask(db, {
        workstream: "demo",
        localId: "c",
        title: "C again",
        impact: 33,
        effortDays: 1,
      });

      const path = targetPath();
      rebuildInto(db, { targetPath: path });
      const row = withTarget(path, (conn) =>
        conn.prepare("SELECT title, impact FROM tasks WHERE local_id = 'c'").get(),
      );
      expect(row).toMatchObject({ title: "C again", impact: 33 });
    });

    it("a removed edge stays removed", () => {
      seedRealisticSource();
      removeBlockEdge(db, "demo", "b", "a");
      const path = targetPath();
      rebuildInto(db, { targetPath: path });
      const n = withTarget(
        path,
        (conn) => (conn.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n,
      );
      expect(n).toBe(0);
    });

    it("a destroyed workstream's whole subtree stays gone", () => {
      seedRealisticSource();
      // Delete through the FK cascade, as `workstream destroy` does.
      db.prepare("DELETE FROM workstreams WHERE name = 'demo'").run();
      const path = targetPath();
      const report = rebuildInto(db, { targetPath: path });
      expect(report.rebuiltRows).toMatchObject({
        workstreams: 0,
        tasks: 0,
        task_edges: 0,
        task_notes: 0,
      });
    });
  });

  // ─── idempotence ─────────────────────────────────────────────────────

  describe("idempotence", () => {
    it("rebuilding twice from the same log gives row-identical results", () => {
      seedRealisticSource();
      const first = targetPath();
      const second = targetPath();
      rebuildInto(db, { targetPath: first });
      rebuildInto(db, { targetPath: second });

      const a = withTarget(first, portableSnapshot);
      const b = withTarget(second, portableSnapshot);
      expect(b).toEqual(a);
    });

    it("re-replaying into an existing rebuild with --force is stable", () => {
      seedRealisticSource();
      const path = targetPath();
      const first = rebuildInto(db, { targetPath: path });
      const snapshot = withTarget(path, portableSnapshot);

      const again = rebuildInto(db, { targetPath: path, force: true });
      expect(withTarget(path, portableSnapshot)).toEqual(snapshot);
      // Op count must not grow: INSERT OR IGNORE on (machine_id, hlc).
      expect(again.opsCopied).toBe(first.opsCopied);
    });
  });

  // ─── capture suppression ─────────────────────────────────────────────

  describe("capture suppression", () => {
    it("produces NO ops in the target beyond the replayed ones", () => {
      // Without suppression, applying each op would fire the capture
      // triggers and mint a SECOND op per row, roughly doubling the log
      // and filling it with ops carrying fresh HLCs that never happened.
      seedRealisticSource();
      const sourceOps = (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
      const path = targetPath();
      const report = rebuildInto(db, { targetPath: path });

      const targetOps = withTarget(
        path,
        (conn) => (conn.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n,
      );
      expect(targetOps).toBe(sourceOps);
      expect(report.opsCopied).toBe(sourceOps);
    });

    it("the target's ops are byte-identical to the source's", () => {
      // Stronger than counting: proves no op was rewritten with a new
      // HLC, group_id or payload during replay.
      seedRealisticSource();
      const cols = `SELECT hlc, machine_id, group_id, actor, intent, entity, key, op, payload
                      FROM ops ORDER BY hlc`;
      const before = db.prepare(cols).all();
      const path = targetPath();
      rebuildInto(db, { targetPath: path });
      expect(withTarget(path, (conn) => conn.prepare(cols).all())).toEqual(before);
    });
  });

  // ─── rebuild is NOT ingest ───────────────────────────────────────────

  describe("rebuild replays machine-local ops too (rebuild != ingest)", () => {
    it("copies log-only entities that ingest would refuse", () => {
      // 'agent' is not in SYNCED_ENTITIES, so applyOp REJECTS it and a
      // peer must never send one. But it is this machine's own log
      // history, so a local recovery has to keep it — otherwise `mu log`
      // comes back empty after a rebuild.
      seedRealisticSource();
      const sourceEvents = (
        db.prepare("SELECT COUNT(*) AS n FROM ops WHERE entity = 'agent'").get() as { n: number }
      ).n;
      expect(sourceEvents).toBeGreaterThan(0);

      const path = targetPath();
      const report = rebuildInto(db, { targetPath: path });

      const targetEvents = withTarget(
        path,
        (conn) =>
          (
            conn.prepare("SELECT COUNT(*) AS n FROM ops WHERE entity = 'agent'").get() as {
              n: number;
            }
          ).n,
      );
      expect(targetEvents).toBe(sourceEvents);
      expect(report.logOnlyByEntity.agent).toBe(sourceEvents);
      // …and they were copied WITHOUT being passed to applyOp, which
      // would have thrown OpEntityNotSyncedError.
      expect(report.opsProjected).toBeLessThan(report.opsCopied);
    });

    it("`mu log`'s rows survive a rebuild", () => {
      seedRealisticSource();
      const path = targetPath();
      rebuildInto(db, { targetPath: path });
      const payloads = withTarget(path, (conn) =>
        (
          conn.prepare("SELECT payload FROM ops WHERE entity = 'agent' ORDER BY hlc").all() as {
            payload: string;
          }[]
        ).map((r) => r.payload),
      );
      expect(payloads.length).toBeGreaterThan(0);
      expect(payloads.some((p) => p.includes("agent spawn worker-1"))).toBe(true);
    });

    it("preserves sync_peers watermarks", () => {
      seedRealisticSource();
      db.prepare(
        "INSERT INTO sync_peers (machine_id, last_applied_seq, last_seen_at) VALUES (?, ?, ?)",
      ).run("peer-aaa", 42, "2026-01-01T00:00:00.000Z");
      const path = targetPath();
      rebuildInto(db, { targetPath: path });
      const row = withTarget(path, (conn) =>
        conn.prepare("SELECT machine_id, last_applied_seq FROM sync_peers").get(),
      );
      expect(row).toMatchObject({ machine_id: "peer-aaa", last_applied_seq: 42 });
    });
  });

  // ─── machine identity must be preserved ──────────────────────────────

  describe("machine identity", () => {
    it("carries the machine_id across, so the rebuild is the SAME peer", () => {
      // A fresh openDb seeds a NEW uuid. If the rebuild kept that, the
      // recovered DB would be a DIFFERENT peer: its own historical ops
      // would look foreign, and peers tracking watermarks against the
      // old id would treat it as unknown.
      seedRealisticSource();
      const sourceId = (
        db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as {
          machine_id: string;
        }
      ).machine_id;

      const path = targetPath();
      const report = rebuildInto(db, { targetPath: path });
      expect(report.machineId).toBe(sourceId);

      const targetId = withTarget(
        path,
        (conn) =>
          (
            conn.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as {
              machine_id: string;
            }
          ).machine_id,
      );
      expect(targetId).toBe(sourceId);
    });

    it("carries the HLC clock, so new edits sort AFTER replayed history", () => {
      // If last_wall reset to 0, the next local edit would mint an HLC
      // below every op already in the log, so a brand-new change would
      // sort as older than history and lose every LWW comparison.
      seedRealisticSource();
      const path = targetPath();
      rebuildInto(db, { targetPath: path });

      withTarget(path, (conn) => {
        const clock = conn
          .prepare("SELECT last_wall, last_counter FROM machine_identity WHERE id = 1")
          .get() as { last_wall: number; last_counter: number };
        expect(clock.last_wall).toBeGreaterThan(0);

        // Concretely: a new op minted in the rebuilt DB must sort above
        // every replayed op.
        const newest = (conn.prepare("SELECT MAX(hlc) AS hlc FROM ops").get() as { hlc: string })
          .hlc;
        addTask(conn, {
          workstream: "demo",
          localId: "brand-new",
          title: "N",
          impact: 5,
          effortDays: 1,
        });
        const minted = (
          conn.prepare("SELECT MAX(hlc) AS hlc FROM ops WHERE key = 'demo/brand-new'").get() as {
            hlc: string;
          }
        ).hlc;
        expect(minted > newest).toBe(true);
      });
    });
  });

  // ─── machine-local tables are lost, and SAID to be lost ──────────────

  describe("machine-local tables", () => {
    const seedAgent = (): void => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO agents (workstream_id, name, cli, pane_id, status, created_at, updated_at)
         VALUES ((SELECT id FROM workstreams WHERE name = 'demo'), 'w1', 'pi', '%17', 'free', ?, ?)`,
      ).run(now, now);
    };

    it("agents/vcs_workspaces are EMPTY in the rebuilt DB", () => {
      seedRealisticSource();
      seedAgent();
      const path = targetPath();
      rebuildInto(db, { targetPath: path });

      withTarget(path, (conn) => {
        for (const table of ["agents", "vcs_workspaces"]) {
          const n = (conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
          expect(n, `${table} should be empty after rebuild`).toBe(0);
        }
      });
    });

    it("the report SAYS SO, with per-table row counts", () => {
      // Never silent: an operator whose agent registry vanished without
      // a word will wonder why `mu agent list` is blank.
      seedRealisticSource();
      seedAgent();
      const report = rebuildInto(db, { targetPath: targetPath() });
      expect(report.machineLocalLost).toEqual([{ table: "agents", rows: 1 }]);
    });

    it("reports nothing lost when there was nothing to lose", () => {
      seedRealisticSource();
      const report = rebuildInto(db, { targetPath: targetPath() });
      expect(report.machineLocalLost).toEqual([]);
    });

    it("counts vcs_workspaces too", () => {
      seedRealisticSource();
      seedAgent();
      const agent = db.prepare("SELECT id FROM agents WHERE name = 'w1'").get() as { id: number };
      db.prepare(
        `INSERT INTO vcs_workspaces (agent_id, workstream_id, path, backend, created_at)
         VALUES (?, (SELECT id FROM workstreams WHERE name = 'demo'), '/tmp/ws', 'git', ?)`,
      ).run(agent.id, new Date().toISOString());

      const report = rebuildInto(db, { targetPath: targetPath() });
      expect(report.machineLocalLost).toEqual([
        { table: "agents", rows: 1 },
        { table: "vcs_workspaces", rows: 1 },
      ]);
    });
  });

  // ─── safety guards ───────────────────────────────────────────────────

  describe("safety", () => {
    it("refuses an existing target unless --force", () => {
      const path = targetPath();
      writeFileSync(path, "not a db");
      expect(() => rebuildInto(db, { targetPath: path })).toThrow(RebuildTargetExistsError);
    });

    it("refuses to rebuild onto the source DB", () => {
      expect(() => rebuildInto(db, { targetPath: sourcePath })).toThrow(RebuildTargetIsSourceError);
      // …even with force, since that would truncate the log being read.
      expect(() => rebuildInto(db, { targetPath: sourcePath, force: true })).toThrow(
        RebuildTargetIsSourceError,
      );
    });

    it("leaves the source DB untouched", () => {
      seedRealisticSource();
      const before = portableSnapshot(db);
      const opsBefore = db.prepare("SELECT hlc FROM ops ORDER BY hlc").all();
      rebuildInto(db, { targetPath: targetPath() });
      expect(portableSnapshot(db)).toEqual(before);
      expect(db.prepare("SELECT hlc FROM ops ORDER BY hlc").all()).toEqual(opsBefore);
    });

    it("creates parent directories for the target", () => {
      seedRealisticSource();
      const nested = join(tempDir, "deep", "deeper", "out.db");
      rebuildInto(db, { targetPath: nested });
      expect(existsSync(nested)).toBe(true);
    });
  });

  // ─── the drift-check seam ────────────────────────────────────────────

  describe("seam for the doctor drift check", () => {
    it("returns a report and prints nothing, so a caller can diff", () => {
      // v2-doctor-drift rebuilds into a temp DB and compares. The SDK
      // must therefore take the target as a parameter and keep all
      // human-facing output in the CLI layer.
      seedRealisticSource();
      const path = targetPath();
      const report = rebuildInto(db, { targetPath: path });

      expect(report.targetPath).toBe(path);
      expect(report.opsCopied).toBeGreaterThan(0);
      expect(report.opsProjected).toBeGreaterThan(0);
      expect(Object.keys(report.rebuiltRows).sort()).toEqual([
        "ops",
        "task_edges",
        "task_notes",
        "tasks",
        "workstreams",
      ]);

      // A drift check would diff exactly like this, and find nothing.
      expect(withTarget(path, portableSnapshot)).toEqual(portableSnapshot(db));
    });

    it("a drift check WOULD detect a tampered projection", () => {
      // Proves the diff has teeth: corrupt the source's projection
      // without touching its log, and the rebuild disagrees.
      seedRealisticSource();
      db.prepare("UPDATE tasks SET impact = 7 WHERE local_id = 'a'").run();
      // Remove the op that mutation just captured, simulating a
      // projection that drifted from the log.
      db.prepare(
        "DELETE FROM ops WHERE entity = 'task' AND key = 'demo/a' AND payload LIKE '%\"impact\":7%'",
      ).run();

      const path = targetPath();
      rebuildInto(db, { targetPath: path });
      const rebuilt = withTarget(path, (conn) =>
        conn.prepare("SELECT impact FROM tasks WHERE local_id = 'a'").get(),
      );
      expect(rebuilt).toMatchObject({ impact: 60 }); // the log's value
      expect(portableSnapshot(db)).not.toEqual(withTarget(path, portableSnapshot));
    });
  });
});
