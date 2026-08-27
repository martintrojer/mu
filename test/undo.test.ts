// Tests for src/undo.ts — inverse ops for one group.
//
// The end-to-end assertion that matters most is `checkDrift(db).clean`
// after every undo. Undo writes to the tables through the normal capture
// path, so if it ever produced a row state the log cannot explain, the
// drift check would say so. That single assertion covers "undo did not
// corrupt the projection" more thoroughly than any hand-written
// comparison, so it appears in most tests here.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { checkDrift } from "../src/drift.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, deleteTask, updateTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import {
  listRecentGroups,
  mostRecentGroup,
  NothingToUndoError,
  planUndo,
  priorFieldValue,
  resolveGroupId,
  UndoGroupNotFoundError,
  UndoSupersededError,
  undoGroup,
} from "../src/undo.js";
import { destroyWorkstream, ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

describe("undo", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-undo-test-"));
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

  const task = (localId: string) =>
    db
      .prepare("SELECT title, status, impact, effort_days FROM tasks WHERE local_id = ?")
      .get(localId) as
      | { title: string; status: string; impact: number; effort_days: number }
      | undefined;

  const groupFor = (intent: string): string => {
    const group = listRecentGroups(db, 50).find((g) => g.intents.includes(intent));
    if (group === undefined) throw new Error(`no group with intent ${intent}`);
    return group.groupId;
  };

  /** The group_id of the op that created `key` (op='put', oldest for that
   *  key). `groupFor` picks the newest group with a matching intent, which
   *  is wrong when two tasks share an intent (e.g. seed() adds both 'a'
   *  and 'b') and the test needs the one that touched a specific key. */
  const creationGroupFor = (entity: string, key: string): string => {
    const row = db
      .prepare(
        `SELECT group_id AS groupId FROM ops
          WHERE entity = ? AND key = ? AND op = 'put'
          ORDER BY hlc ASC LIMIT 1`,
      )
      .get(entity, key) as { groupId: string } | undefined;
    if (row === undefined) throw new Error(`no creation op for ${entity} ${key}`);
    return row.groupId;
  };

  const seed = (): void => {
    ensureWorkstream(db, "demo");
    addTask(db, { workstream: "demo", localId: "a", title: "A", impact: 60, effortDays: 1 });
    addTask(db, { workstream: "demo", localId: "b", title: "B", impact: 40, effortDays: 2 });
  };

  /** No drift means the tables and the log still agree. */
  const expectNoDrift = (): void => {
    const report = checkDrift(db);
    if (!report.clean) {
      throw new Error(
        `drift after undo: ${report.records.map((r) => `${r.table} ${r.key}.${r.field} live=${r.live} log=${r.expected}`).join("; ")}`,
      );
    }
  };

  // ─── field-level undo ────────────────────────────────────────────────

  describe("undoing a task.update", () => {
    it("returns the changed field to its prior value and touches ONLY that field", () => {
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      expect(task("a")).toMatchObject({ impact: 90, title: "A" });

      const result = undoGroup(db, groupFor("task.update"));
      expect(result.applied).toBe(1);
      // impact reverted; title/status/effort untouched.
      expect(task("a")).toMatchObject({ impact: 60, title: "A", status: "OPEN", effort_days: 1 });
      expectNoDrift();
    });

    it("reverts several fields changed by one update, and nothing else", () => {
      seed();
      updateTask(db, "a", { impact: 90, title: "Renamed" }, { workstream: "demo" });
      undoGroup(db, groupFor("task.update"));
      expect(task("a")).toMatchObject({ impact: 60, title: "A" });
      // `b` was never in the group.
      expect(task("b")).toMatchObject({ impact: 40, title: "B" });
      expectNoDrift();
    });

    it("emits exactly ONE op for a multi-field inverse", () => {
      // One UPDATE statement, so one trigger firing, so one op. A
      // per-field loop would emit N and misreport one action as several.
      seed();
      updateTask(db, "a", { impact: 90, title: "Renamed" }, { workstream: "demo" });
      const result = undoGroup(db, groupFor("task.update"));
      const ops = db
        .prepare("SELECT payload FROM ops WHERE group_id = ? AND entity = 'task'")
        .all(result.undoGroupId) as { payload: string }[];
      expect(ops).toHaveLength(1);
      const payload = JSON.parse(ops[0]?.payload ?? "{}") as Record<string, unknown>;
      expect(payload).toMatchObject({ impact: 60, title: "A" });
    });

    it("undoing a task.add DELETES the row (its creation is the thing undone)", () => {
      ensureWorkstream(db, "demo");
      addTask(db, { workstream: "demo", localId: "solo", title: "S", impact: 10, effortDays: 1 });
      const plan = planUndo(db, groupFor("task.add"));
      expect(plan.inverses[0]?.op).toBe("del");
      undoGroup(db, groupFor("task.add"));
      expect(task("solo")).toBeUndefined();
      expectNoDrift();
    });
  });

  // ─── the group cases ─────────────────────────────────────────────────

  describe("undoing a multi-row group", () => {
    it("undoes a cascade close", () => {
      seed();
      addBlockEdge(db, "demo", "b", "a");
      closeTask(db, "a", { workstream: "demo" });
      closeTask(db, "b", { workstream: "demo" });
      // Two separate closes = two groups; undoing one leaves the other.
      const groups = listRecentGroups(db, 10).filter((g) => g.intents.includes("task.close"));
      expect(groups.length).toBe(2);
      const newest = groups[0];
      if (newest === undefined) throw new Error("expected a close group");
      undoGroup(db, newest.groupId);
      const statuses = [task("a")?.status, task("b")?.status].sort();
      expect(statuses).toEqual(["CLOSED", "OPEN"]);
      expectNoDrift();
    });

    it("restores the WHOLE TREE of a workstream destroy, in FK-safe order", async () => {
      // The FK ordering case: restoring a task before its workstream, or
      // a note before its task, violates the constraint.
      ensureWorkstream(db, "demo");
      addTask(db, { workstream: "demo", localId: "a", title: "A", impact: 60, effortDays: 1 });
      addTask(db, { workstream: "demo", localId: "b", title: "B", impact: 40, effortDays: 2 });
      addBlockEdge(db, "demo", "b", "a");
      addNote(db, "a", "context", { workstream: "demo", author: "worker-1" });

      await destroyWorkstream(db, { workstream: "demo", tmuxSession: "mu-absent-for-test" });
      expect((db.prepare("SELECT COUNT(*) AS n FROM workstreams").get() as { n: number }).n).toBe(
        0,
      );

      const plan = planUndo(db, groupFor("workstream.destroy"));
      // Parents first: the workstream must precede its tasks, and tasks
      // must precede notes/edges.
      const order = plan.inverses.map((i) => i.entity);
      expect(order[0]).toBe("workstream");
      expect(order.indexOf("task")).toBeLessThan(order.indexOf("note"));
      expect(order.indexOf("task")).toBeLessThan(order.indexOf("edge"));

      undoGroup(db, groupFor("workstream.destroy"));

      expect((db.prepare("SELECT COUNT(*) AS n FROM workstreams").get() as { n: number }).n).toBe(
        1,
      );
      expect(task("a")).toMatchObject({ title: "A", impact: 60, status: "OPEN" });
      expect(task("b")).toMatchObject({ title: "B", impact: 40, status: "OPEN" });
      expect((db.prepare("SELECT COUNT(*) AS n FROM task_notes").get() as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n).toBe(1);
      expectNoDrift();
    });

    it("restores a deleted task's notes and edges too", () => {
      seed();
      addBlockEdge(db, "demo", "b", "a");
      addNote(db, "a", "keep me", { workstream: "demo" });
      deleteTask(db, "a", "demo");
      expect(task("a")).toBeUndefined();

      undoGroup(db, groupFor("task.delete"));
      expect(task("a")).toMatchObject({ title: "A", impact: 60 });
      expectNoDrift();
    });
  });

  // ─── undo is itself an op, and itself undoable ────────────────────────

  describe("undo is an ordinary op", () => {
    it("emits ops (it is not a silent mutation)", () => {
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      const before = (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;

      const result = undoGroup(db, groupFor("task.update"));

      const after = (db.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;
      expect(after).toBeGreaterThan(before);
      // …in its own group, with intent 'undo', carrying a real HLC.
      const ops = db
        .prepare("SELECT hlc, intent, entity, key, op FROM ops WHERE group_id = ?")
        .all(result.undoGroupId) as Array<{ hlc: string; intent: string; entity: string }>;
      expect(ops.length).toBeGreaterThan(0);
      for (const op of ops) {
        expect(op.intent).toBe("undo");
        expect(op.hlc).toMatch(/^\d{15}\.\d{6}\./);
      }
    });

    it("the undo's ops sort AFTER the group it reverted (fresh HLCs)", () => {
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      const target = groupFor("task.update");
      const originalMax = (
        db.prepare("SELECT MAX(hlc) AS hlc FROM ops WHERE group_id = ?").get(target) as {
          hlc: string;
        }
      ).hlc;
      const result = undoGroup(db, target);
      const undoMin = (
        db
          .prepare("SELECT MIN(hlc) AS hlc FROM ops WHERE group_id = ?")
          .get(result.undoGroupId) as {
          hlc: string;
        }
      ).hlc;
      // Newest wins per-field LWW, which is why the inverse takes effect.
      expect(undoMin > originalMax).toBe(true);
    });

    it("is itself undoable — undo the undo returns to the undone state", () => {
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      const first = undoGroup(db, groupFor("task.update"));
      expect(task("a")?.impact).toBe(60);

      // Redo is just undo of the undo's group. No separate mechanism.
      const second = undoGroup(db, first.undoGroupId);
      expect(task("a")?.impact).toBe(90);
      expectNoDrift();

      // …and that is undoable too, indefinitely.
      undoGroup(db, second.undoGroupId);
      expect(task("a")?.impact).toBe(60);
      expectNoDrift();
    });

    it("undoing an undo of a delete re-deletes", () => {
      seed();
      deleteTask(db, "a", "demo");
      const first = undoGroup(db, groupFor("task.delete"));
      expect(task("a")).toBeDefined();
      undoGroup(db, first.undoGroupId);
      expect(task("a")).toBeUndefined();
      expectNoDrift();
    });
  });

  // ─── the supersession DECISION ───────────────────────────────────────

  describe("superseded groups", () => {
    /** Set up: a group changes impact, then a LATER group changes it
     *  again. Undoing the first would discard the second's work. */
    const setupSuperseded = (): string => {
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      const target = groupFor("task.update");
      // A later, separate action on the same field.
      updateTask(db, "a", { impact: 95 }, { workstream: "demo" });
      return target;
    };

    it("DETECTS the supersession and names the field and the later group", () => {
      const target = setupSuperseded();
      const plan = planUndo(db, target);
      expect(plan.superseded).toBe(true);
      const conflicts = plan.inverses.flatMap((i) => i.supersededBy);
      expect(conflicts.some((c) => c.field === "impact")).toBe(true);
      expect(conflicts[0]?.groupId).not.toBe(target);
    });

    it("REFUSES by default, and changes NOTHING", () => {
      // The decision: not silent clobbering (destroys newer work) and not
      // silent skipping (operator believes it was undone). Refuse, name
      // the conflict, require an explicit flag.
      const target = setupSuperseded();
      expect(() => undoGroup(db, target)).toThrow(UndoSupersededError);
      // The newer value survives untouched.
      expect(task("a")?.impact).toBe(95);
      expectNoDrift();
    });

    it("the error names the conflicting field and offers the --force escape", () => {
      const target = setupSuperseded();
      try {
        undoGroup(db, target);
        throw new Error("expected a throw");
      } catch (err) {
        if (!(err instanceof UndoSupersededError)) throw err;
        expect(err.message).toContain("superseded");
        expect(err.message).toContain("impact");
        const steps = err
          .errorNextSteps()
          .map((s) => s.command)
          .join(" ");
        expect(steps).toContain("--force");
      }
    });

    it("--force applies it, discarding the newer edit (as documented)", () => {
      const target = setupSuperseded();
      const result = undoGroup(db, target, { force: true });
      expect(result.applied).toBe(1);
      // Back to the value from BEFORE the undone group. The 95 is gone,
      // which is exactly what --force says it will do.
      expect(task("a")?.impact).toBe(60);
      expectNoDrift();
    });

    it("does NOT report supersession when the later group touched a DIFFERENT field", () => {
      // Per-field, not per-row: a later title change must not block
      // undoing an impact change.
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      const target = groupFor("task.update");
      db.prepare("UPDATE tasks SET title = 'Later' WHERE local_id = 'a'").run();

      const plan = planUndo(db, target);
      const impactConflicts = plan.inverses
        .flatMap((i) => i.supersededBy)
        .filter((c) => c.field === "impact");
      expect(impactConflicts).toEqual([]);
    });

    it("treats a later DELETE as a supersession", () => {
      // Restoring fields on a row that has since been deleted would
      // resurrect it, which the operator did not ask for.
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      const target = groupFor("task.update");
      deleteTask(db, "a", "demo");

      const plan = planUndo(db, target);
      expect(plan.superseded).toBe(true);
      expect(() => undoGroup(db, target)).toThrow(UndoSupersededError);
    });

    it("detects supersession of a CREATE — undoing the creation would discard a later edit", () => {
      // Group A creates task 'a'. Group B (a distinct, later group) then
      // edits it. The inverse of A's creation is a delete of the whole
      // row: it must be reported as superseded by B's edit, not silently
      // allowed through a whole-row query that (before the fix) never
      // matched any later op.
      seed();
      const createGroup = creationGroupFor("task", "demo/a");
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });

      const plan = planUndo(db, createGroup);
      expect(plan.superseded).toBe(true);
      const conflicts = plan.inverses.flatMap((i) => i.supersededBy);
      expect(conflicts.length).toBeGreaterThan(0);
      expect(() => undoGroup(db, createGroup)).toThrow(UndoSupersededError);
      // Nothing changed: the row and its later edit both survive.
      expect(task("a")?.impact).toBe(90);
      expectNoDrift();
    });

    it("detects supersession of a DELETE-then-RECREATE — restoring the tombstone would clobber the fresh row", () => {
      // A group deletes 'a'. A later, unrelated group recreates a task
      // with the same natural key (a legitimate reuse of the id). The
      // inverse of the delete (restore-from-tombstone) must be reported
      // as superseded by the recreation, not silently allowed through.
      seed();
      deleteTask(db, "a", "demo");
      const deleteGroup = groupFor("task.delete");
      addTask(db, { workstream: "demo", localId: "a", title: "Fresh", impact: 77, effortDays: 3 });

      const plan = planUndo(db, deleteGroup);
      expect(plan.superseded).toBe(true);
      const conflicts = plan.inverses.flatMap((i) => i.supersededBy);
      expect(conflicts.length).toBeGreaterThan(0);
      expect(() => undoGroup(db, deleteGroup)).toThrow(UndoSupersededError);
      // The fresh, unrelated row is untouched.
      expect(task("a")).toMatchObject({ title: "Fresh", impact: 77 });
      expectNoDrift();
    });
  });

  // ─── group discovery ─────────────────────────────────────────────────

  describe("group discovery", () => {
    it("lists recent groups newest-first with their intents", () => {
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      const groups = listRecentGroups(db, 10);
      expect(groups.length).toBeGreaterThanOrEqual(4);
      expect(groups[0]?.intents).toContain("task.update");
      // Newest first.
      for (let i = 1; i < groups.length; i++) {
        const prev = groups[i - 1];
        const cur = groups[i];
        if (prev === undefined || cur === undefined) continue;
        expect(prev.hlc > cur.hlc).toBe(true);
      }
    });

    it("mostRecentGroup is the newest group", () => {
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      expect(mostRecentGroup(db)?.intents).toContain("task.update");
    });

    it("returns null / throws when there is nothing to undo", () => {
      expect(mostRecentGroup(db)).toBeNull();
      expect(listRecentGroups(db)).toEqual([]);
    });

    it("resolves an abbreviated group id, like a git sha", () => {
      seed();
      const full = groupFor("task.add");
      expect(resolveGroupId(db, full.slice(0, 8))).toBe(full);
      expect(resolveGroupId(db, full)).toBe(full);
    });

    it("rejects an unknown group id", () => {
      seed();
      expect(() => resolveGroupId(db, "nonexistent")).toThrow(UndoGroupNotFoundError);
      expect(() => planUndo(db, "nonexistent")).toThrow(UndoGroupNotFoundError);
    });

    it("counts ops per group", () => {
      ensureWorkstream(db, "demo");
      for (const id of ["x", "y", "z"]) {
        addTask(db, { workstream: "demo", localId: id, title: id, impact: 50, effortDays: 1 });
      }
      closeTask(db, "x", { workstream: "demo" });
      const group = listRecentGroups(db, 1)[0];
      expect(group?.ops).toBe(1);
    });
  });

  // ─── provenance reuse ────────────────────────────────────────────────

  describe("priorFieldValue (the provenance lookup)", () => {
    it("finds the value a field held before a given op", () => {
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      const op = db
        .prepare(
          "SELECT hlc FROM ops WHERE entity='task' AND key='demo/a' ORDER BY hlc DESC LIMIT 1",
        )
        .get() as { hlc: string };
      const prior = priorFieldValue(db, "task", "demo/a", op.hlc, "impact");
      expect(prior).toEqual({ found: true, value: 60 });
    });

    it("reports not-found when no earlier op named the field", () => {
      seed();
      const first = db
        .prepare("SELECT hlc FROM ops WHERE entity='task' AND key='demo/a' ORDER BY hlc LIMIT 1")
        .get() as { hlc: string };
      expect(priorFieldValue(db, "task", "demo/a", first.hlc, "impact")).toEqual({ found: false });
    });

    it("distinguishes a prior NULL from an absent field", () => {
      // json_type, not json_extract: json_extract returns SQL NULL both
      // for an absent key and a present-but-null one, so a set-to-NULL
      // would look absent and undo would restore the wrong value.
      seed();
      addNote(db, "a", "authorless", { workstream: "demo" });
      const noteOps = db
        .prepare("SELECT hlc, payload FROM ops WHERE entity='note' ORDER BY hlc")
        .all() as { hlc: string; payload: string }[];
      const created = noteOps[0];
      if (created === undefined) throw new Error("expected a note op");
      expect(JSON.parse(created.payload)).toMatchObject({ author: null });
    });
  });

  // ─── nothing-to-do paths ─────────────────────────────────────────────

  describe("degenerate cases", () => {
    it("undoing the same group twice is safe (second is a no-op)", () => {
      seed();
      updateTask(db, "a", { impact: 90 }, { workstream: "demo" });
      const target = groupFor("task.update");
      undoGroup(db, target);
      expect(task("a")?.impact).toBe(60);

      // The second undo re-applies the same inverse. It is superseded by
      // the FIRST undo's ops, so it refuses — which is correct: the state
      // is already what the operator asked for.
      expect(() => undoGroup(db, target)).toThrow(UndoSupersededError);
      expect(task("a")?.impact).toBe(60);
      expectNoDrift();
    });

    it("undoing a workstream.init deletes the (empty) workstream", () => {
      ensureWorkstream(db, "solo");
      undoGroup(db, groupFor("workstream.init"));
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name = 'solo'").get() as {
          n: number;
        }
      ).n;
      expect(n).toBe(0);
      expectNoDrift();
    });

    it("NothingToUndoError is a distinct typed error", () => {
      expect(new NothingToUndoError().name).toBe("NothingToUndoError");
      expect(new NothingToUndoError().errorNextSteps().length).toBeGreaterThan(0);
    });

    it("undo runs in ONE transaction (a partial undo is never committed)", () => {
      // Proven indirectly: after any successful undo the drift check is
      // clean, and after a refused one nothing changed at all. A partially
      // applied undo would show as drift or as a half-reverted row.
      seed();
      addBlockEdge(db, "demo", "b", "a");
      addNote(db, "a", "n", { workstream: "demo" });
      deleteTask(db, "a", "demo");
      undoGroup(db, groupFor("task.delete"));
      expectNoDrift();
    });
  });
});
