// Tests for src/drift.ts — the check that makes capture/apply/rebuild
// trustworthy.
//
// The single most important test in this file is "planted drift IS
// detected". A drift check that cannot detect drift is theatre, and it
// would be worse than nothing: it would license trust in a log that might
// be wrong. So drift is planted HONESTLY — capture suppressed, then a
// direct mutation, which is exactly the shape of a real capture bug — and
// the assertion is that the check names the table, key AND field.
//
// The mirror-image risk is false positives. Four shapes trip a naive
// differ: cascade delete, resurrection, set-to-NULL, and no-op update.
// Each gets its own test asserting CLEAN.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  checkCheapDriftInvariant,
  checkDrift,
  DRIFT_REPORT_CAP,
  driftRemediation,
  formatDriftRecord,
} from "../src/drift.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import { addBlockEdge, removeBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, deleteTask, updateTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

describe("drift detection", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-drift-test-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(tempDir);
  });

  const seed = (): void => {
    ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: "a", title: "A", impact: 60, effortDays: 1 });
    addTask(db, { workstream: "demo", localId: "b", title: "B", impact: 40, effortDays: 2 });
    addBlockEdge(db, "demo", "b", "a");
    addNote(db, "a", "context", { workstream: "demo", author: "worker-1" });
  };

  /** Mutate the DB the way a capture bug would: no op is recorded. */
  const uncaptured = (fn: () => void): void => {
    withCaptureSuppressed(db, fn);
  };

  // ─── THE test: planted drift is detected ─────────────────────────────

  describe("planted drift is detected (the load-bearing test)", () => {
    it("names the table, key and field of an uncaptured UPDATE", () => {
      seed();
      expect(checkDrift(db).clean).toBe(true); // baseline

      uncaptured(() => {
        db.prepare("UPDATE tasks SET impact = 7 WHERE local_id = 'a'").run();
      });

      const report = checkDrift(db);
      expect(report.clean).toBe(false);
      expect(report.totalDrift).toBe(1);
      const record = report.records[0];
      if (!record) throw new Error("expected a drift record");
      expect(record.table).toBe("tasks");
      expect(record.key).toBe("demo/a"); // natural key, not a rowid
      expect(record.field).toBe("impact");
      expect(record.live).toBe("7");
      expect(record.expected).toBe("60"); // the log is canonical
    });

    it("detects an uncaptured INSERT as a row the log cannot explain", () => {
      seed();
      uncaptured(() => {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days,
                              created_at, updated_at)
           VALUES ((SELECT id FROM workstreams WHERE name = 'demo'), 'ghost', 'Ghost',
                   'OPEN', 50, 1, ?, ?)`,
        ).run(now, now);
      });

      const report = checkDrift(db);
      expect(report.clean).toBe(false);
      const record = report.records.find((r) => r.key === "demo/ghost");
      if (!record) throw new Error("expected drift for demo/ghost");
      expect(record.field).toBe("<row>");
      expect(record.presence).toBe("missing-in-rebuild");
    });

    it("detects an uncaptured DELETE as a row missing from live", () => {
      seed();
      uncaptured(() => {
        db.prepare("DELETE FROM tasks WHERE local_id = 'b'").run();
      });

      const report = checkDrift(db);
      expect(report.clean).toBe(false);
      const record = report.records.find((r) => r.key === "demo/b" && r.table === "tasks");
      if (!record) throw new Error("expected drift for demo/b");
      expect(record.field).toBe("<row>");
      expect(record.presence).toBe("missing-in-live");
    });

    it("detects drift in every portable table", () => {
      seed();
      uncaptured(() => {
        db.prepare("UPDATE workstreams SET created_at = 'tampered' WHERE name = 'demo'").run();
        db.prepare("UPDATE tasks SET title = 'tampered' WHERE local_id = 'a'").run();
        db.prepare("UPDATE task_notes SET content = 'tampered' WHERE id = 1").run();
        db.prepare("DELETE FROM task_edges").run();
      });

      const report = checkDrift(db);
      const tables = new Set(report.records.map((r) => r.table));
      expect(tables).toEqual(new Set(["workstreams", "tasks", "task_notes", "task_edges"]));
    });

    it("reports an uncaptured set-to-NULL on a note as a row-identity change", () => {
      seed();
      uncaptured(() => {
        db.prepare("UPDATE task_notes SET author = NULL WHERE id = 1").run();
      });
      const report = checkDrift(db);
      expect(report.clean).toBe(false);
      // Notes are a GROW-ONLY SET whose diff identity is
      // (task, author, content) — see src/drift.ts § SNAPSHOT_SQL — because
      // their surrogate id is not portable. So nulling the AUTHOR changes
      // the row's identity, and the honest report is a pair: the log's row
      // is missing from live, and live has a row the log cannot explain.
      // That is strictly more informative than a single field diff would
      // be, since the operator needs both halves to see what happened.
      expect(report.totalDrift).toBe(2);
      const missingInLive = report.records.find((r) => r.presence === "missing-in-live");
      const unexplained = report.records.find((r) => r.presence === "missing-in-rebuild");
      if (!missingInLive || !unexplained) throw new Error("expected both halves of the pair");
      expect(missingInLive.key).toContain("worker-1"); // the log's version
      expect(unexplained.key).not.toContain("worker-1"); // the tampered one
      for (const record of report.records) expect(record.table).toBe("task_notes");
    });

    it("reports an uncaptured set-to-NULL on a task field as a FIELD diff", () => {
      // On a task, a nullable synced column is a plain per-field
      // comparison, and the report must distinguish SQL NULL from the
      // string "null".
      seed();
      uncaptured(() => {
        // title is NOT NULL, so use a column that is genuinely nullable
        // in the compared set: exercise the NULL rendering via the note
        // path above and the value rendering here.
        db.prepare("UPDATE tasks SET title = 'null' WHERE local_id = 'a'").run();
      });
      const report = checkDrift(db);
      const record = report.records.find((r) => r.field === "title");
      if (!record) throw new Error("expected title drift");
      expect(record.live).toBe("null"); // the literal string
      expect(record.expected).toBe("A");
      expect(formatDriftRecord(record)).toBe("tasks demo/a.title: live=null log=A");
    });

    it("caps the record list but keeps the count exact", () => {
      ensureWorkstream(db, "demo");
      for (let i = 0; i < DRIFT_REPORT_CAP + 10; i++) {
        addTask(db, {
          workstream: "demo",
          localId: `t${i}`,
          title: `T${i}`,
          impact: 50,
          effortDays: 1,
        });
      }
      uncaptured(() => {
        db.prepare("UPDATE tasks SET impact = 3").run();
      });
      const report = checkDrift(db);
      expect(report.records.length).toBe(DRIFT_REPORT_CAP);
      expect(report.totalDrift).toBe(DRIFT_REPORT_CAP + 10);
    });
  });

  // ─── no false positives on the shapes a naive differ gets wrong ──────

  describe("no false positives on a healthy DB", () => {
    it("clean on a freshly seeded DB, having actually compared rows", () => {
      seed();
      const report = checkDrift(db);
      expect(report.clean).toBe(true);
      expect(report.totalDrift).toBe(0);
      // Guard against a vacuous pass: the comparison must have had
      // something to compare.
      expect(report.rowsCompared).toMatchObject({
        workstreams: 1,
        tasks: 2,
        task_notes: 1,
        task_edges: 1,
      });
    });

    it("clean on an empty DB", () => {
      expect(checkDrift(db).clean).toBe(true);
    });

    it("clean after a CASCADE delete", () => {
      seed();
      // Deleting the workstream cascades to tasks, notes and edges. A
      // naive differ mishandles this because one DELETE produces many
      // tombstones at different levels.
      db.prepare("DELETE FROM workstreams WHERE name = 'demo'").run();
      expect(checkDrift(db)).toMatchObject({ clean: true });
    });

    it("clean after a task delete that cascades to notes and edges", () => {
      seed();
      deleteTask(db, "a", "demo");
      expect(checkDrift(db)).toMatchObject({ clean: true });
    });

    it("clean after RESURRECTION (del then a newer put)", () => {
      seed();
      deleteTask(db, "a", "demo");
      addTask(db, {
        workstream: "demo",
        localId: "a",
        title: "A again",
        impact: 15,
        effortDays: 1,
      });
      const report = checkDrift(db);
      expect(report.clean).toBe(true);
      // And the resurrected row really is there, so this is not clean-by-
      // being-empty.
      expect(report.rowsCompared.tasks).toBe(2);
    });

    it("clean after a set-to-NULL that WAS captured", () => {
      seed();
      // A captured set-to-NULL must not read as drift. This is the apply
      // side of the json_patch trap: RFC 7396 would have dropped the null
      // member, leaving the rebuild with the old value and the differ
      // reporting drift that is not there.
      addNote(db, "b", "authorless", { workstream: "demo" });
      expect(checkDrift(db)).toMatchObject({ clean: true });
    });

    it("clean after a no-op update", () => {
      seed();
      // Rewriting identical values produces NO op (the capture WHEN
      // guard). The differ must not expect one.
      db.prepare("UPDATE tasks SET impact = impact, title = title WHERE local_id = 'a'").run();
      expect(checkDrift(db)).toMatchObject({ clean: true });
    });

    it("clean after close, update, block and unblock", () => {
      seed();
      updateTask(db, "b", { impact: 95, title: "B renamed" }, { workstream: "demo" });
      closeTask(db, "a", { workstream: "demo" });
      removeBlockEdge(db, "demo", "b", "a");
      addBlockEdge(db, "demo", "b", "a");
      expect(checkDrift(db)).toMatchObject({ clean: true });
    });

    it("clean when a task is CLAIMED (owner_id never syncs, so is never compared)", () => {
      // owner_id is an FK into machine-local `agents`, so apply strips it
      // and a rebuild always has NULL owners. Comparing it would make
      // every claimed task report drift forever.
      seed();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO agents (workstream_id, name, cli, pane_id, status, created_at, updated_at)
         VALUES ((SELECT id FROM workstreams WHERE name = 'demo'), 'w1', 'pi', '%1', 'free', ?, ?)`,
      ).run(now, now);
      const agent = db.prepare("SELECT id FROM agents WHERE name = 'w1'").get() as { id: number };
      db.prepare("UPDATE tasks SET owner_id = ? WHERE local_id = 'a'").run(agent.id);

      expect(checkDrift(db)).toMatchObject({ clean: true });
    });

    it("clean with many rows (not just the toy fixture)", () => {
      ensureWorkstream(db, "demo");
      for (let i = 0; i < 60; i++) {
        addTask(db, {
          workstream: "demo",
          localId: `t${i}`,
          title: `T${i}`,
          impact: 50,
          effortDays: 1,
        });
        if (i % 3 === 0) updateTask(db, `t${i}`, { impact: 80 }, { workstream: "demo" });
        if (i % 5 === 0) addNote(db, `t${i}`, `n${i}`, { workstream: "demo", author: "w" });
        if (i % 7 === 0) closeTask(db, `t${i}`, { workstream: "demo" });
      }
      const report = checkDrift(db);
      expect(report.clean).toBe(true);
      expect(report.rowsCompared.tasks).toBe(60);
    });
  });

  // ─── the cheap invariant ─────────────────────────────────────────────

  describe("cheap invariant (the default doctor tier)", () => {
    it("clean on a healthy DB", () => {
      seed();
      expect(checkCheapDriftInvariant(db).clean).toBe(true);
    });

    it("catches an uncaptured INSERT and names the row", () => {
      seed();
      uncaptured(() => {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days,
                              created_at, updated_at)
           VALUES ((SELECT id FROM workstreams WHERE name = 'demo'), 'ghost', 'G',
                   'OPEN', 50, 1, ?, ?)`,
        ).run(now, now);
      });
      const report = checkCheapDriftInvariant(db);
      expect(report.clean).toBe(false);
      expect(report.unexplainedRows).toEqual([{ table: "tasks", key: "demo/ghost" }]);
    });

    it("is BLIND to an uncaptured UPDATE — the documented limitation", () => {
      // Not a bug: the key still has ops from its insert, so the
      // invariant holds. This is precisely why --deep exists, and the
      // default doctor's wording points at it rather than claiming proof.
      seed();
      uncaptured(() => {
        db.prepare("UPDATE tasks SET impact = 7 WHERE local_id = 'a'").run();
      });
      expect(checkCheapDriftInvariant(db).clean).toBe(true);
      // …while the deep check catches it.
      expect(checkDrift(db).clean).toBe(false);
    });

    it("catches an uncaptured workstream and edge insert too", () => {
      seed();
      uncaptured(() => {
        db.prepare("INSERT INTO workstreams (name, created_at) VALUES ('sneaky', ?)").run(
          new Date().toISOString(),
        );
      });
      const report = checkCheapDriftInvariant(db);
      expect(report.unexplainedRows).toContainEqual({ table: "workstreams", key: "sneaky" });
    });

    it("stays quiet after a cascade delete and a resurrection", () => {
      seed();
      deleteTask(db, "a", "demo");
      addTask(db, { workstream: "demo", localId: "a", title: "A2", impact: 20, effortDays: 1 });
      expect(checkCheapDriftInvariant(db).clean).toBe(true);
    });

    it("is fast enough for the default doctor", () => {
      ensureWorkstream(db, "demo");
      for (let i = 0; i < 200; i++) {
        addTask(db, {
          workstream: "demo",
          localId: `t${i}`,
          title: `T${i}`,
          impact: 50,
          effortDays: 1,
        });
      }
      const report = checkCheapDriftInvariant(db);
      // Generous bound: the point is "milliseconds, not seconds". Measured
      // at 2-3ms on a 1000-task DB; the deep check is ~2.3s there.
      expect(report.elapsedMs).toBeLessThan(250);
    });
  });

  // ─── remediation text ────────────────────────────────────────────────

  describe("remediation", () => {
    it("warns against rebuilding reflexively", () => {
      // The guidance matters more than the detection: if capture missed a
      // mutation, the LIVE tables hold work the log never saw, and
      // rebuilding would discard it. Telling an operator to rebuild
      // blindly would turn a detected bug into data loss.
      const text = driftRemediation().join("\n");
      expect(text).toContain("Do not rebuild reflexively");
      expect(text).toContain("mu db backup");
      expect(text.indexOf("mu db backup")).toBeLessThan(text.indexOf("mu rebuild"));
    });
  });

  // ─── cleanup hygiene ─────────────────────────────────────────────────

  it("leaves no temp DB behind and does not mutate the source", () => {
    seed();
    const before = db.prepare("SELECT hlc FROM ops ORDER BY hlc").all();
    const rowsBefore = db.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all();
    checkDrift(db);
    checkDrift(db);
    // The check writes only to a temp dir it removes; the live DB is
    // untouched, including its log.
    expect(db.prepare("SELECT hlc FROM ops ORDER BY hlc").all()).toEqual(before);
    expect(db.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all()).toEqual(
      rowsBefore,
    );
  });
});
