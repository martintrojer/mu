// Tests for src/capture.ts + src/op-context.ts — the trigger-based op
// capture that everything downstream (undo, sync, history)
// projects from.
//
// Adversarial by design. The failure mode that matters most here is not
// a crash: it is capture that looks right on one machine and silently
// loses concurrent edits on merge. So the payload-shape tests below
// assert key COUNTS, not just contents — a whole-row payload passes a
// "contains status" assertion and still destroys the design.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { nextHlc, parseHlc } from "../src/hlc.js";
import { currentOpContext, withCaptureSuppressed, withOpContext } from "../src/op-context.js";
import { addBlockEdge, removeBlockEdge, reparentTask } from "../src/tasks/edges.js";
import { addNote, addTask, deleteTask, updateTask } from "../src/tasks/edit.js";
import { closeTask, openTask, setTaskStatus } from "../src/tasks/lifecycle.js";
import { ensureWorkstream, teardownWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

interface OpRow {
  seq: number;
  hlc: string;
  machine_id: string;
  group_id: string;
  actor: string | null;
  intent: string | null;
  entity: string;
  key: string;
  op: string;
  payload: string;
  created_at: string;
}

describe("op capture (triggers)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-capture-test-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    rmFixtureDir(tempDir);
  });

  /** Ops for the row-mutation entities only. Excludes `event` /
   *  `message` rows, which src/logs.ts writes by hand — those are log
   *  lines, not captured mutations, and would drown the assertions. */
  const ops = (entity?: string): OpRow[] => {
    const rows = db
      .prepare(
        `SELECT * FROM ops
          WHERE entity IN ('workstream','task','note','edge')
          ORDER BY seq`,
      )
      .all() as OpRow[];
    return entity === undefined ? rows : rows.filter((r) => r.entity === entity);
  };

  const clearOps = (): void => {
    // Deleting from `ops` fires nothing: ops is machine-local and has
    // no capture trigger on it (capture would be infinitely recursive).
    db.prepare("DELETE FROM ops").run();
  };

  const payloadOf = (row: OpRow): Record<string, unknown> =>
    JSON.parse(row.payload) as Record<string, unknown>;

  const seedTask = (localId = "t1"): void => {
    addTask(db, {
      workstream: "demo",
      localId,
      title: `title ${localId}`,
      impact: 50,
      effortDays: 1,
    });
  };

  // ─── op shapes: INSERT / UPDATE / DELETE ─────────────────────────────

  describe("op shape per mutation kind", () => {
    it("INSERT on workstreams produces one put op keyed by name", () => {
      ensureWorkstream(db, "demo");
      const rows = ops("workstream");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("unreachable");
      expect(row.op).toBe("put");
      expect(row.key).toBe("demo");
      expect(row.intent).toBe("workstream.init");
      expect(payloadOf(row)).toEqual({
        name: "demo",
        created_at: expect.any(String) as unknown as string,
      });
    });

    it("INSERT on tasks keys the op by <workstream>/<local_id>, never a surrogate id", () => {
      ensureWorkstream(db, "demo");
      clearOps();
      seedTask("fix-auth");
      const rows = ops("task");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("unreachable");
      expect(row.key).toBe("demo/fix-auth");
      expect(row.op).toBe("put");
      // The surrogate rowid must not leak into the payload: a peer's
      // tasks.id means nothing here.
      expect(payloadOf(row)).not.toHaveProperty("id");
      expect(payloadOf(row)).not.toHaveProperty("workstream_id");
    });

    it("DELETE produces a del op with an empty payload and a resolved key", () => {
      ensureWorkstream(db, "demo");
      seedTask("t1");
      clearOps();
      deleteTask(db, "t1", "demo");
      const del = ops("task").filter((r) => r.op === "del");
      expect(del).toHaveLength(1);
      const row = del[0];
      if (!row) throw new Error("unreachable");
      expect(row.key).toBe("demo/t1");
      expect(payloadOf(row)).toEqual({});
      expect(row.intent).toBe("task.delete");
    });

    it("notes key as <task-key>#<id> and edges as <blocker>-><blocked>", () => {
      ensureWorkstream(db, "demo");
      seedTask("a");
      seedTask("b");
      clearOps();
      addNote(db, "a", "hello", { workstream: "demo", author: "worker-1" });
      addBlockEdge(db, "demo", "b", "a");

      const note = ops("note");
      expect(note).toHaveLength(1);
      const noteRow = note[0];
      if (!noteRow) throw new Error("unreachable");
      expect(noteRow.key).toMatch(/^demo\/a#\d+$/);
      expect(noteRow.actor).toBe("worker-1");

      const edge = ops("edge");
      expect(edge).toHaveLength(1);
      const edgeRow = edge[0];
      if (!edgeRow) throw new Error("unreachable");
      expect(edgeRow.key).toBe("demo/a->demo/b");
      expect(edgeRow.intent).toBe("task.block");
    });

    it("every captured op carries a parseable HLC and this machine's id", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      updateTask(db, "t1", { impact: 80 }, { workstream: "demo" });
      const machine = db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as {
        machine_id: string;
      };
      const rows = ops();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // parseHlc REJECTS the old `<iso>|<uuid>` placeholder, so this
        // doubles as the tripwire that no placeholder survives.
        const hlc = parseHlc(row.hlc);
        expect(hlc.machineId).toBe(machine.machine_id);
        expect(row.machine_id).toBe(machine.machine_id);
        expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });

    it("HLCs are strictly increasing in seq order, and unique", () => {
      ensureWorkstream(db, "demo");
      for (let i = 0; i < 25; i++) seedTask(`t${i}`);
      const hlcs = ops().map((r) => r.hlc);
      expect(new Set(hlcs).size).toBe(hlcs.length);
      expect([...hlcs].sort()).toEqual(hlcs);
    });

    it("SQL-minted and JS-minted HLCs interleave monotonically (one clock)", () => {
      // Guards the reimplementation-in-SQL of nextHlc: if the two
      // drifted, ops and hand-written log rows would interleave wrongly.
      ensureWorkstream(db, "demo");
      clearOps();
      seedTask("x"); // trigger-minted (SQL)
      const mid = nextHlc(db); // JS-minted
      seedTask("y"); // trigger-minted again
      const captured = ops("task").map((r) => r.hlc);
      const first = captured[0];
      const second = captured[1];
      if (first === undefined || second === undefined) throw new Error("unreachable");
      expect(first < mid).toBe(true);
      expect(mid < second).toBe(true);
    });
  });

  // ─── THE test that catches a row-level regression ────────────────────

  describe("semantic partial updates — only changed columns", () => {
    it("an UPDATE touching 1 of 8 captured columns produces a 1-key payload", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      // Set impact only. `updateTask` also bumps updated_at, so the
      // payload is impact + updated_at — and CRUCIALLY not title,
      // status, effort_days, owner_id, local_id or created_at.
      updateTask(db, "t1", { impact: 80 }, { workstream: "demo" });
      const rows = ops("task");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("unreachable");
      const payload = payloadOf(row);
      expect(payload.impact).toBe(80);
      // The assertions that actually catch a whole-row dump. `updated_at`
      // may or may not be present: updateTask rewrites it with an ISO
      // string, which is byte-identical when the update lands in the same
      // millisecond as the insert — and an unchanged value is correctly
      // NOT captured. So the payload is impact, optionally +updated_at,
      // and never the other six columns.
      expect(Object.keys(payload).sort().join(",")).toMatch(/^impact(,updated_at)?$/);
      for (const absent of [
        "title",
        "status",
        "effort_days",
        "owner_id",
        "local_id",
        "created_at",
      ]) {
        expect(payload, `${absent} must not appear in a partial payload`).not.toHaveProperty(
          absent,
        );
      }
    });

    it("task.close carries {status} (+updated_at), not the whole row", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      closeTask(db, "t1", { workstream: "demo" });
      const rows = ops("task");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("unreachable");
      const payload = payloadOf(row);
      expect(payload.status).toBe("CLOSED");
      expect(Object.keys(payload).sort().join(",")).toMatch(/^status(,updated_at)?$/);
      expect(payload).not.toHaveProperty("impact");
      expect(payload).not.toHaveProperty("title");
    });

    it("a no-op UPDATE produces NO op at all", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      // Rewrite every column with its current value.
      db.prepare(
        `UPDATE tasks SET title = title, status = status, impact = impact,
                          effort_days = effort_days, owner_id = owner_id,
                          updated_at = updated_at
          WHERE local_id = 't1'`,
      ).run();
      expect(ops()).toHaveLength(0);
    });

    it("an idempotent re-close (already CLOSED) produces no op", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      closeTask(db, "t1", { workstream: "demo" });
      clearOps();
      closeTask(db, "t1", { workstream: "demo" });
      expect(ops()).toHaveLength(0);
    });

    it("captures a transition INTO NULL and OUT OF NULL (the IS NOT trap)", () => {
      // `NEW.col <> OLD.col` is NULL when either side is NULL, so a
      // `<>` comparison would silently drop both of these. Releasing a
      // claim is exactly owner_id -> NULL.
      ensureWorkstream(db, "demo");
      seedTask();
      db.prepare(
        `INSERT INTO agents (workstream_id, name, cli, pane_id, status, created_at, updated_at)
         VALUES ((SELECT id FROM workstreams WHERE name='demo'), 'w1', 'pi', '%1', 'free', ?, ?)`,
      ).run(new Date().toISOString(), new Date().toISOString());
      const agent = db.prepare("SELECT id FROM agents WHERE name='w1'").get() as { id: number };

      clearOps();
      db.prepare("UPDATE tasks SET owner_id = ? WHERE local_id = 't1'").run(agent.id);
      const intoValue = ops("task");
      expect(intoValue).toHaveLength(1);
      const a = intoValue[0];
      if (!a) throw new Error("unreachable");
      expect(payloadOf(a)).toEqual({ owner_id: agent.id });

      clearOps();
      db.prepare("UPDATE tasks SET owner_id = NULL WHERE local_id = 't1'").run();
      const intoNull = ops("task");
      expect(intoNull).toHaveLength(1);
      const b = intoNull[0];
      if (!b) throw new Error("unreachable");
      expect(payloadOf(b)).toEqual({ owner_id: null });
      expect(Object.keys(payloadOf(b))).toHaveLength(1);
    });
  });

  // ─── REQUIRED: field-level convergence, both orders ──────────────────

  describe("field-level convergence (the merge-rules requirement)", () => {
    /** Apply ops to a fresh DB in the given order, the way v2-sync
     *  will: per-field, last-writer-wins by HLC, capture suppressed so
     *  applying does not echo. Returns the converged task row. */
    const applyOpsInOrder = (
      opRows: readonly OpRow[],
    ): { title: string; impact: number; status: string } => {
      const target = openDb({ path: join(tempDir, `converge-${Math.random()}.db`) });
      try {
        ensureWorkstream(target, "demo");
        addTask(target, {
          workstream: "demo",
          localId: "t1",
          title: "original",
          impact: 50,
          effortDays: 1,
        });
        withCaptureSuppressed(target, () => {
          for (const row of opRows) {
            const payload = JSON.parse(row.payload) as Record<string, unknown>;
            for (const [col, value] of Object.entries(payload)) {
              if (col === "updated_at" || col === "created_at" || col === "local_id") continue;
              // Field-level LWW: the column is set only if this op's
              // HLC is the newest one seen for THAT column. Applying in
              // HLC order makes "newest wins" automatic, which is the
              // whole point — no version vectors needed.
              target
                .prepare(`UPDATE tasks SET ${col} = ? WHERE local_id = 't1'`)
                .run(value as string | number | null);
            }
          }
        });
        const row = target
          .prepare("SELECT title, impact, status FROM tasks WHERE local_id='t1'")
          .get() as {
          title: string;
          impact: number;
          status: string;
        };
        return row;
      } finally {
        target.close();
      }
    };

    it("two ops on DIFFERENT fields of one row converge with BOTH changes, in either order", () => {
      // Model the real mu scenario: a devserver agent crew closes a
      // task while the operator edits that same task's impact on a
      // laptop. Concurrent multi-machine writing BY CONSTRUCTION.
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();

      // Machine A: close it. Machine B: re-price it.
      closeTask(db, "t1", { workstream: "demo" });
      const closeOp = ops("task").at(-1);
      clearOps();
      updateTask(db, "t1", { impact: 91 }, { workstream: "demo" });
      const impactOp = ops("task").at(-1);
      if (!closeOp || !impactOp) throw new Error("unreachable");

      // Each op must be a partial update, or this test proves nothing.
      expect(Object.keys(JSON.parse(closeOp.payload))).not.toContain("impact");
      expect(Object.keys(JSON.parse(impactOp.payload))).not.toContain("status");

      const forward = applyOpsInOrder([closeOp, impactOp]);
      const reverse = applyOpsInOrder([impactOp, closeOp]);

      // BOTH changes present, and order does not matter.
      // title is untouched by either op, so the target's own value stands;
      // impact from one machine and status from the other BOTH survive.
      expect(forward).toEqual({ title: "original", impact: 91, status: "CLOSED" });
      expect(reverse).toEqual(forward);
    });

    it("two ops on the SAME field resolve by HLC order, not arrival order", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      updateTask(db, "t1", { impact: 60 }, { workstream: "demo" });
      updateTask(db, "t1", { impact: 70 }, { workstream: "demo" });
      const rows = ops("task");
      expect(rows).toHaveLength(2);
      const older = rows[0];
      const newer = rows[1];
      if (!older || !newer) throw new Error("unreachable");
      expect(older.hlc < newer.hlc).toBe(true);
      // Sorting by HLC (what ingest does) always yields 70 last.
      const sorted = [newer, older].sort((x, y) => (x.hlc < y.hlc ? -1 : 1));
      expect(applyOpsInOrder(sorted).impact).toBe(70);
    });
  });

  // ─── echo suppression ───────────────────────────────────────────────

  describe("echo suppression", () => {
    it("mutations inside withCaptureSuppressed produce NO ops", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      withCaptureSuppressed(db, () => {
        updateTask(db, "t1", { impact: 80, title: "changed" }, { workstream: "demo" });
        addTask(db, {
          workstream: "demo",
          localId: "t2",
          title: "second",
          impact: 10,
          effortDays: 1,
        });
        deleteTask(db, "t2", "demo");
      });
      expect(ops()).toHaveLength(0);
      // …but the row change itself DID happen. Suppression must skip
      // capture, not the mutation.
      const row = db.prepare("SELECT impact, title FROM tasks WHERE local_id='t1'").get() as {
        impact: number;
        title: string;
      };
      expect(row).toEqual({ impact: 80, title: "changed" });
    });

    it("capture resumes after the suppressed scope, even if it threw", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      expect(() =>
        withCaptureSuppressed(db, () => {
          throw new Error("ingest blew up");
        }),
      ).toThrow("ingest blew up");
      // The worst possible failure mode would be capture staying off.
      expect(currentOpContext(db).applying).toBe(false);
      updateTask(db, "t1", { impact: 80 }, { workstream: "demo" });
      expect(ops("task")).toHaveLength(1);
    });
  });

  // ─── grouping ───────────────────────────────────────────────────────

  describe("group_id", () => {
    it("a close puts its ops under ONE group", () => {
      ensureWorkstream(db, "demo");
      seedTask("root");
      clearOps();

      const result = closeTask(db, "root", { workstream: "demo" });
      expect(result.changed).toBe(true);

      const rows = ops("task");
      expect(rows.length).toBe(1);
      const groups = new Set(rows.map((r) => r.group_id));
      expect(groups.size).toBe(1);
      for (const row of rows) expect(row.intent).toBe("task.close");
    });

    it("a workstream teardown groups the whole cascade as one unit", async () => {
      ensureWorkstream(db, "demo");
      seedTask("a");
      seedTask("b");
      addBlockEdge(db, "demo", "b", "a");
      addNote(db, "a", "note text", { workstream: "demo" });
      clearOps();

      await teardownWorkstream(db, { workstream: "demo", muxSession: "mu-capture-test-absent" });

      const rows = ops();
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
      for (const row of rows) expect(row.intent).toBe("workstream.teardown");
    });

    it("two separate operator actions get DIFFERENT groups", () => {
      ensureWorkstream(db, "demo");
      seedTask("a");
      seedTask("b");
      const groups = new Set(ops("task").map((r) => r.group_id));
      expect(groups.size).toBe(2);
    });

    it("a reparent's DELETE + INSERT edge ops share one group", () => {
      ensureWorkstream(db, "demo");
      seedTask("a");
      seedTask("b");
      seedTask("c");
      addBlockEdge(db, "demo", "c", "a");
      clearOps();
      reparentTask(db, "c", ["b"], { workstream: "demo" });
      const rows = ops("edge");
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.some((r) => r.op === "del")).toBe(true);
      expect(rows.some((r) => r.op === "put")).toBe(true);
      expect(new Set(rows.map((r) => r.group_id)).size).toBe(1);
      for (const row of rows) expect(row.intent).toBe("task.reparent");
    });
  });

  // ─── FK CASCADE (verified empirically, per the task brief) ───────────

  describe("FK CASCADE deletes", () => {
    it("cascaded child rows DO produce their own del ops with resolvable keys", async () => {
      ensureWorkstream(db, "demo");
      seedTask("a");
      seedTask("b");
      addBlockEdge(db, "demo", "b", "a");
      addNote(db, "a", "keep me", { workstream: "demo" });
      clearOps();

      await teardownWorkstream(db, { workstream: "demo", muxSession: "mu-capture-test-absent" });

      const byEntity = (e: string) => ops(e).filter((r) => r.op === "del");
      // One tombstone per row, at every level of the cascade.
      expect(byEntity("workstream").map((r) => r.key)).toEqual(["demo"]);
      expect(
        byEntity("task")
          .map((r) => r.key)
          .sort(),
      ).toEqual(["demo/a", "demo/b"]);
      expect(byEntity("edge").map((r) => r.key)).toEqual(["demo/a->demo/b"]);
      expect(byEntity("note")).toHaveLength(1);

      // THE point of the dying-ancestor stash: no key degraded to the
      // unresolved sentinel even though the parents were deleted first.
      for (const row of ops()) expect(row.key).not.toContain("<unresolved>");
    });

    it("deleting a task cascades to its notes and edges with resolved keys", () => {
      ensureWorkstream(db, "demo");
      seedTask("a");
      seedTask("b");
      addBlockEdge(db, "demo", "b", "a");
      addNote(db, "a", "note", { workstream: "demo" });
      clearOps();

      deleteTask(db, "a", "demo");

      const dels = ops().filter((r) => r.op === "del");
      const noteOp = dels.find((r) => r.entity === "note");
      const edgeOp = dels.find((r) => r.entity === "edge");
      if (!noteOp || !edgeOp) throw new Error("expected cascaded note + edge ops");
      expect(noteOp.key).toMatch(/^demo\/a#\d+$/);
      expect(edgeOp.key).toBe("demo/a->demo/b");
      for (const row of dels) expect(row.key).not.toContain("<unresolved>");
    });
  });

  // ─── the fail-safe default row ──────────────────────────────────────

  describe("default op context (fail safe, never fail silent)", () => {
    it("a raw mutation with no SDK context is still captured, with a null intent", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      // Bypass the SDK entirely — exactly the "someone added a new
      // mutation path and forgot" case that triggers exist to survive.
      db.prepare("UPDATE tasks SET title = 'raw sql' WHERE local_id = 't1'").run();

      const rows = ops("task");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("unreachable");
      expect(payloadOf(row)).toEqual({ title: "raw sql" });
      expect(row.intent).toBeNull();
      expect(row.actor).toBeNull();
      // group_id is NEVER null: an ungrouped op is its own group of one.
      expect(row.group_id).toEqual(expect.any(String));
      expect(row.group_id.length).toBeGreaterThan(0);
    });

    it("the seeded context row exists and is inert on a fresh open", () => {
      expect(currentOpContext(db)).toEqual({
        groupId: null,
        actor: null,
        intent: null,
        applying: false,
      });
    });
  });

  // ─── withOpContext semantics ─────────────────────────────────────────

  describe("withOpContext", () => {
    it("restores the previous context after the scope, including on throw", () => {
      withOpContext(db, { intent: "outer.verb", actor: "a1" }, () => {
        expect(currentOpContext(db).intent).toBe("outer.verb");
        expect(() =>
          withOpContext(db, { intent: "inner.verb" }, () => {
            expect(currentOpContext(db).intent).toBe("inner.verb");
            throw new Error("boom");
          }),
        ).toThrow("boom");
        // A leaked intent would mislabel every later op as inner.verb.
        expect(currentOpContext(db).intent).toBe("outer.verb");
        expect(currentOpContext(db).actor).toBe("a1");
      });
      expect(currentOpContext(db).intent).toBeNull();
    });

    it("nested scopes inherit the outer group unless group:'new'", () => {
      ensureWorkstream(db, "demo");
      clearOps();
      withOpContext(db, { intent: "batch", group: "new" }, () => {
        const outerGroup = currentOpContext(db).groupId;
        withOpContext(db, { intent: "inner" }, () => {
          expect(currentOpContext(db).groupId).toBe(outerGroup);
        });
        withOpContext(db, { intent: "inner", group: "new" }, () => {
          expect(currentOpContext(db).groupId).not.toBe(outerGroup);
        });
      });
    });

    it("intentIfUnset yields to an enclosing intent but labels a bare call", () => {
      withOpContext(db, { intent: "outer.verb", group: "new" }, () => {
        withOpContext(db, { intentIfUnset: "inner.fallback" }, () => {
          expect(currentOpContext(db).intent).toBe("outer.verb");
        });
      });
      withOpContext(db, { intentIfUnset: "inner.fallback" }, () => {
        expect(currentOpContext(db).intent).toBe("inner.fallback");
      });
    });

    it("actor set by a scope lands on the ops captured inside it", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      withOpContext(db, { intent: "custom.verb", actor: "worker-7", group: "new" }, () => {
        updateTask(db, "t1", { impact: 33 }, { workstream: "demo" });
      });
      const row = ops("task")[0];
      if (!row) throw new Error("unreachable");
      // updateTask sets its own intent, but the actor is inherited from
      // the enclosing scope since updateTask does not set one.
      expect(row.actor).toBe("worker-7");
    });
  });

  // ─── durability of capture across the SDK surface ────────────────────

  describe("SDK coverage", () => {
    it("every mutating task verb captures at least one op with a non-null intent", () => {
      ensureWorkstream(db, "demo");
      seedTask("a");
      seedTask("b");

      const cases: Array<[string, () => void]> = [
        ["task.add", () => seedTask("fresh")],
        ["task.update", () => updateTask(db, "a", { impact: 77 }, { workstream: "demo" })],
        ["task.note", () => addNote(db, "a", "n", { workstream: "demo" })],
        ["task.block", () => addBlockEdge(db, "demo", "b", "a")],
        ["task.unblock", () => removeBlockEdge(db, "demo", "b", "a")],
        ["task.close", () => closeTask(db, "a", { workstream: "demo" })],
        ["task.open", () => openTask(db, "a", { workstream: "demo" })],
        ["task.delete", () => deleteTask(db, "fresh", "demo")],
      ];

      for (const [expectedIntent, run] of cases) {
        clearOps();
        run();
        const rows = ops();
        expect(rows.length, `${expectedIntent} produced no op`).toBeGreaterThan(0);
        expect(
          rows.map((r) => r.intent),
          expectedIntent,
        ).toContain(expectedIntent);
      }
    });

    it("a direct setTaskStatus labels itself when not nested", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      setTaskStatus(db, "t1", "IN_PROGRESS", { workstream: "demo" });
      const row = ops("task")[0];
      if (!row) throw new Error("unreachable");
      expect(row.intent).toBe("task.set-in_progress");
    });
  });

  // ─── per-connection isolation ────────────────────────────────────────

  describe("per-connection temp schema", () => {
    it("a second connection captures independently with its own context", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      clearOps();
      const other = openDb({ path: dbPath });
      try {
        // Suppressing on `db` must not suppress on `other` — temp
        // tables are per-connection, which is what makes this safe
        // across mu's one-process-per-invocation model.
        withCaptureSuppressed(db, () => {
          withOpContext(other, { intent: "other.conn", group: "new" }, () => {
            // Raw SQL, not updateTask: updateTask sets its own intent,
            // which would hide whether `other`'s ambient context was the
            // one actually consulted by the trigger.
            other.prepare("UPDATE tasks SET impact = 42 WHERE local_id = 't1'").run();
          });
        });
      } finally {
        other.close();
      }
      const rows = ops("task");
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("unreachable");
      expect(row.intent).toBe("other.conn");
    });

    it("capture survives a close/reopen (triggers are reinstalled per open)", () => {
      ensureWorkstream(db, "demo");
      seedTask();
      db.close();
      db = openDb({ path: dbPath });
      clearOps();
      updateTask(db, "t1", { impact: 65 }, { workstream: "demo" });
      expect(ops("task")).toHaveLength(1);
    });
  });
});
