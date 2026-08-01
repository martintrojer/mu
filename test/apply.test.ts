// Tests for src/apply.ts — the apply path: merge rules, tombstone
// ordering, and idempotence.
//
// Adversarial by design. The failure mode that matters is not a crash:
// it is an apply that looks correct on one machine and silently drops a
// concurrent edit on merge. So the convergence tests assert on BOTH
// fields surviving and on order-independence, not merely on "no throw".
//
// HLCs are INJECTED throughout (see `peerHlc`) so ordering is exact and
// there are no sleeps.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Op,
  OpEntityNotSyncedError,
  OpKeyMalformedError,
  applyOp,
  applyOps,
} from "../src/apply.js";
import { type Db, openDb } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask } from "../src/tasks/edit.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

// ─── test-only op synthesis (kept out of src, per the brief) ──────────

/** A peer machine id, distinct from the local one. */
const PEER = "9f1c8a2e-0000-4000-8000-0000000000aa";
const PEER_B = "9f1c8a2e-0000-4000-8000-0000000000bb";

/**
 * Base for every synthesized HLC: far enough in the FUTURE that a peer
 * op always beats the HLCs the local capture triggers mint from the real
 * clock while seeding fixtures.
 *
 * This matters and is easy to get wrong. Locally-captured ops carry the
 * real wall clock (~1.78e12 ms), so a hand-written HLC at "wall 1000" is
 * ancient by comparison and loses every per-field comparison — the
 * fixture's own seed op wins and the test asserts nothing. Offsetting by
 * a fixed future base keeps the small readable numbers below while
 * guaranteeing peer ops are newer than the seed.
 */
const FUTURE_BASE = 2_000_000_000_000; // ~2033, comfortably ahead of now

/** Build an HLC at an exact logical time, so tests state ordering
 *  directly instead of relying on wall-clock timing. `wallMs` is an
 *  offset from FUTURE_BASE, so `peerHlc(1000) < peerHlc(2000)` reads as
 *  intended and both beat anything the local clock minted. */
function peerHlc(wallMs: number, counter = 0, machineId: string = PEER): string {
  return formatHlc({ wallMs: FUTURE_BASE + wallMs, counter, machineId });
}

let opSeq = 0;

/** Synthesize a peer op. `hlc` is the only ordering input that matters. */
function makeOp(partial: {
  hlc: string;
  entity: string;
  key: string;
  op?: "put" | "del";
  payload?: Record<string, unknown>;
  machineId?: string;
  intent?: string;
}): Op {
  return {
    hlc: partial.hlc,
    machineId: partial.machineId ?? PEER,
    groupId: `grp-${++opSeq}`,
    actor: "peer",
    intent: partial.intent ?? null,
    entity: partial.entity,
    key: partial.key,
    op: partial.op ?? "put",
    payload: JSON.stringify(partial.payload ?? {}),
  };
}

describe("applyOp", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-apply-test-"));
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

  /** Record an op in `ops` the way v2-sync will, WITHOUT firing capture.
   *  applyOp deliberately does not do this (the caller owns segment
   *  bookkeeping), so tests that exercise provenance must. */
  const record = (op: Op): void => {
    db.prepare(
      `INSERT OR IGNORE INTO ops
         (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
       VALUES (@hlc, @machineId, @groupId, @actor, @intent, @entity, @key, @op, @payload, @createdAt)`,
    ).run({
      hlc: op.hlc,
      machineId: op.machineId,
      groupId: op.groupId,
      actor: op.actor ?? null,
      intent: op.intent ?? null,
      entity: op.entity,
      key: op.key,
      op: op.op,
      payload: op.payload,
      createdAt: new Date().toISOString(),
    });
  };

  /** Ingest as v2-sync will: record the op, then apply it. */
  const ingest = (op: Op) => {
    record(op);
    return applyOp(db, op);
  };

  const task = (key: string) => {
    const slash = key.indexOf("/");
    const ws = key.slice(0, slash);
    const localId = key.slice(slash + 1);
    return db
      .prepare(
        `SELECT t.title, t.status, t.impact, t.effort_days, t.owner_id
           FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
          WHERE w.name = ? AND t.local_id = ?`,
      )
      .get(ws, localId) as
      | {
          title: string;
          status: string;
          impact: number;
          effort_days: number;
          owner_id: number | null;
        }
      | undefined;
  };

  const seedLocalTask = (localId: string, ws = "demo"): void => {
    ensureWorkstream(db, ws);
    addTask(db, { workstream: ws, localId, title: `title ${localId}`, impact: 50, effortDays: 1 });
  };

  // ─── REQUIRED: field-level convergence ───────────────────────────────

  describe("per-field LWW (tasks / workstreams)", () => {
    it("two ops on DIFFERENT fields converge with BOTH present, in either order", () => {
      // The real mu scenario: a devserver crew closes a task while the
      // operator re-prices it on a laptop. Concurrent by construction.
      const closeOp = makeOp({
        hlc: peerHlc(1000),
        entity: "task",
        key: "demo/t1",
        payload: { status: "CLOSED" },
        intent: "task.close",
      });
      const priceOp = makeOp({
        hlc: peerHlc(2000),
        entity: "task",
        key: "demo/t1",
        payload: { impact: 91 },
        machineId: PEER_B,
        intent: "task.update",
      });

      const run = (ops: readonly Op[]) => {
        db.close();
        db = openDb({ path: join(tempDir, `conv-${Math.random()}.db`) });
        seedLocalTask("t1");
        for (const op of ops) ingest(op);
        return task("demo/t1");
      };

      const forward = run([closeOp, priceOp]);
      const reverse = run([priceOp, closeOp]);

      // BOTH edits survive. Under row-level LWW one would be lost.
      expect(forward).toMatchObject({ status: "CLOSED", impact: 91 });
      expect(reverse).toMatchObject({ status: "CLOSED", impact: 91 });
      expect(reverse).toEqual(forward);
      // And the field neither op touched is untouched.
      expect(forward?.title).toBe("title t1");
    });

    it("same field from two machines: newer HLC wins, order-independently", () => {
      const older = makeOp({
        hlc: peerHlc(1000),
        entity: "task",
        key: "demo/t1",
        payload: { impact: 60 },
      });
      const newer = makeOp({
        hlc: peerHlc(2000),
        entity: "task",
        key: "demo/t1",
        payload: { impact: 70 },
        machineId: PEER_B,
      });

      const run = (ops: readonly Op[]) => {
        db.close();
        db = openDb({ path: join(tempDir, `same-${Math.random()}.db`) });
        seedLocalTask("t1");
        for (const op of ops) ingest(op);
        return task("demo/t1")?.impact;
      };

      expect(run([older, newer])).toBe(70);
      expect(run([newer, older])).toBe(70); // late older op must LOSE
    });

    it("an older op reports it changed nothing rather than throwing", () => {
      seedLocalTask("t1");
      ingest(
        makeOp({ hlc: peerHlc(5000), entity: "task", key: "demo/t1", payload: { impact: 90 } }),
      );
      const late = ingest(
        makeOp({ hlc: peerHlc(1000), entity: "task", key: "demo/t1", payload: { impact: 10 } }),
      );
      expect(late).toMatchObject({ changed: false, skipped: "older-than-current" });
      expect(task("demo/t1")?.impact).toBe(90);
    });

    it("one op can WIN on one field and LOSE on another in the same call", () => {
      // The precise thing row-level LWW cannot express.
      seedLocalTask("t1");
      ingest(
        makeOp({ hlc: peerHlc(9000), entity: "task", key: "demo/t1", payload: { impact: 99 } }),
      );
      const mixed = ingest(
        makeOp({
          hlc: peerHlc(5000),
          entity: "task",
          key: "demo/t1",
          payload: { impact: 11, status: "CLOSED" },
          machineId: PEER_B,
        }),
      );
      expect(mixed.appliedFields).toEqual(["status"]);
      expect(task("demo/t1")).toMatchObject({ impact: 99, status: "CLOSED" });
    });

    it("creates the row (and its workstream) when a task op arrives first", () => {
      const r = ingest(
        makeOp({
          hlc: peerHlc(1000),
          entity: "task",
          key: "fresh/t9",
          payload: { title: "from a peer", status: "OPEN", impact: 42, effort_days: 2 },
        }),
      );
      expect(r.changed).toBe(true);
      expect(task("fresh/t9")).toMatchObject({ title: "from a peer", impact: 42 });
    });

    it("per-field LWW applies to workstreams too", () => {
      ensureWorkstream(db, "demo");
      const r = ingest(
        makeOp({
          hlc: peerHlc(9_000_000),
          entity: "workstream",
          key: "demo",
          payload: { created_at: "2020-01-01T00:00:00.000Z" },
        }),
      );
      expect(r.changed).toBe(true);
      const row = db.prepare("SELECT created_at FROM workstreams WHERE name='demo'").get() as {
        created_at: string;
      };
      expect(row.created_at).toBe("2020-01-01T00:00:00.000Z");
    });
  });

  // ─── the json_patch trap ─────────────────────────────────────────────

  describe("set-to-NULL survives (the json_patch trap)", () => {
    it("a null-valued payload member reaches the row rather than being dropped", () => {
      // json_patch implements RFC 7396, where a null member means DELETE
      // THIS KEY: json_patch('{"author":"x"}','{"author":null}') === '{}'.
      // So if the apply path merged payloads with json_patch, every
      // set-to-NULL would silently vanish. Capture really does emit this
      // shape — an authorless note yields {"author":null,...} and a claim
      // release yields exactly {"owner_id":null}.
      //
      // `author` on task_notes is the nullable column that DOES cross
      // machines, so it is where the trap is observable end-to-end.
      seedLocalTask("t1");
      const r = ingest(
        makeOp({
          hlc: peerHlc(1000),
          entity: "note",
          key: "demo/t1#9",
          payload: { author: null, content: "authorless", created_at: "2026-01-01T00:00:00.000Z" },
        }),
      );
      expect(r.changed).toBe(true);
      const row = db
        .prepare("SELECT author, content FROM task_notes WHERE content = 'authorless'")
        .get() as { author: string | null; content: string } | undefined;
      // The member survived as a real NULL. Under json_patch the key
      // would have been dropped from the payload entirely.
      expect(row).toEqual({ author: null, content: "authorless" });
    });

    it("json_patch would have destroyed this payload — proof the trap is real", () => {
      // Pins the hazard itself, so nobody "simplifies" the apply path to
      // json_patch later and passes every other test in this file.
      const merged = db
        .prepare(`SELECT json_patch('{"owner_id":7}', @payload) AS v`)
        .get({ payload: JSON.stringify({ owner_id: null }) }) as { v: string };
      expect(JSON.parse(merged.v)).toEqual({}); // owner_id GONE
      // Whereas decoding member-by-member (what applyOp does) keeps it.
      const entries = Object.entries(JSON.parse('{"owner_id":null}') as Record<string, unknown>);
      expect(entries).toEqual([["owner_id", null]]);
    });

    it("a null-valued field establishes provenance, so an OLDER op cannot revive it", () => {
      // The subtle half of the trap, on the presence test rather than
      // the merge. If provenance used `json_extract(payload,'$.f') IS NOT
      // NULL`, a set-to-NULL would look absent (json_extract returns SQL
      // NULL for both an absent key and a null value), leaving the field
      // with no provenance so ANY older op could overwrite it. applyOp
      // uses json_type, which returns 'null' for a present-but-null
      // member and SQL NULL only when genuinely absent.
      seedLocalTask("t1");
      // Prove it directly on the two SQL functions, since the payloads
      // that carry nulls on `tasks` are all machine-local columns.
      const probe = db
        .prepare(
          `SELECT json_extract(@p, '$.owner_id') AS extracted,
                  json_type(@p, '$.owner_id')    AS typed,
                  json_type('{}', '$.owner_id')  AS absent`,
        )
        .get({ p: '{"owner_id":null}' }) as {
        extracted: unknown;
        typed: string | null;
        absent: string | null;
      };
      expect(probe.extracted).toBeNull(); // ambiguous
      expect(probe.typed).toBe("null"); // present-but-null: distinguishable
      expect(probe.absent).toBeNull(); // genuinely absent
    });
  });

  // ─── tombstones (v2-tombstones): all four orderings ──────────────────

  describe("tombstones are ordinary ops — all four orderings", () => {
    const put = (wall: number) =>
      makeOp({ hlc: peerHlc(wall), entity: "task", key: "demo/t1", payload: { impact: 77 } });
    const del = (wall: number) =>
      makeOp({ hlc: peerHlc(wall), entity: "task", key: "demo/t1", op: "del", machineId: PEER_B });

    it("put then NEWER del -> row deleted", () => {
      seedLocalTask("t1");
      ingest(put(1000));
      const r = ingest(del(2000));
      expect(r.changed).toBe(true);
      expect(task("demo/t1")).toBeUndefined();
    });

    it("put then OLDER del -> del LOSES, row stays alive", () => {
      seedLocalTask("t1");
      ingest(put(5000));
      const r = ingest(del(1000));
      expect(r).toMatchObject({ changed: false, skipped: "older-than-current" });
      expect(task("demo/t1")).toBeDefined();
      expect(task("demo/t1")?.impact).toBe(77);
    });

    it("del then OLDER put -> put LOSES, row stays deleted", () => {
      seedLocalTask("t1");
      ingest(del(5000));
      expect(task("demo/t1")).toBeUndefined();
      const r = ingest(put(1000));
      expect(r).toMatchObject({ changed: false, skipped: "older-than-tombstone" });
      expect(task("demo/t1")).toBeUndefined();
    });

    it("del then NEWER put -> RESURRECTION, row exists again", () => {
      // A legitimate re-add, not a bug. Distinguishing this from the
      // stale-put case above is the whole reason provenance must outlive
      // the row — and ops are never deleted, so it does.
      seedLocalTask("t1");
      ingest(del(1000));
      expect(task("demo/t1")).toBeUndefined();
      const r = ingest(put(5000));
      expect(r.changed).toBe(true);
      expect(task("demo/t1")).toBeDefined();
      expect(task("demo/t1")?.impact).toBe(77);
    });

    it("the four orderings converge to the SAME state regardless of arrival order", () => {
      // Same two ops, both arrival orders, for each of the two HLC
      // relationships. Arrival order must never matter.
      for (const [putWall, delWall, alive] of [
        [1000, 2000, false],
        [5000, 1000, true],
      ] as const) {
        const results: Array<boolean> = [];
        for (const order of [
          [put(putWall), del(delWall)],
          [del(delWall), put(putWall)],
        ]) {
          db.close();
          db = openDb({ path: join(tempDir, `tomb-${putWall}-${delWall}-${Math.random()}.db`) });
          seedLocalTask("t1");
          for (const op of order) ingest(op);
          results.push(task("demo/t1") !== undefined);
        }
        expect(results, `put@${putWall} del@${delWall}`).toEqual([alive, alive]);
      }
    });

    it("a workstream del cascades to its tasks", () => {
      seedLocalTask("t1");
      seedLocalTask("t2");
      const r = ingest(
        makeOp({ hlc: peerHlc(9_000_000), entity: "workstream", key: "demo", op: "del" }),
      );
      expect(r.changed).toBe(true);
      expect(task("demo/t1")).toBeUndefined();
      expect(task("demo/t2")).toBeUndefined();
    });
  });

  // ─── grow-only notes ─────────────────────────────────────────────────

  describe("notes are a grow-only set", () => {
    const noteOp = (wall: number, content = "hello") =>
      makeOp({
        hlc: peerHlc(wall),
        entity: "note",
        key: "demo/t1#7",
        payload: { author: "peer-agent", content, created_at: "2026-01-01T00:00:00.000Z" },
      });

    const noteCount = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM task_notes").get() as { n: number }).n;

    it("inserts a peer note", () => {
      seedLocalTask("t1");
      const before = noteCount();
      const r = ingest(noteOp(1000));
      expect(r.changed).toBe(true);
      expect(noteCount()).toBe(before + 1);
      const row = db
        .prepare("SELECT author, content FROM task_notes ORDER BY id DESC LIMIT 1")
        .get() as { author: string; content: string };
      expect(row).toEqual({ author: "peer-agent", content: "hello" });
    });

    it("applying the SAME note twice yields ONE row (idempotent)", () => {
      seedLocalTask("t1");
      ingest(noteOp(1000));
      const after = noteCount();
      const second = ingest(noteOp(1000));
      expect(second).toMatchObject({ changed: false, skipped: "already-present" });
      expect(noteCount()).toBe(after);
    });

    it("never updates: a later op with different content ADDS rather than overwrites", () => {
      seedLocalTask("t1");
      ingest(noteOp(1000, "first"));
      ingest(noteOp(2000, "second"));
      const contents = (
        db.prepare("SELECT content FROM task_notes ORDER BY id").all() as { content: string }[]
      ).map((r) => r.content);
      expect(contents).toEqual(["first", "second"]);
    });

    it("is skipped (not fatal) when the parent task is absent", () => {
      ensureWorkstream(db, "demo");
      const r = ingest(noteOp(1000));
      expect(r).toMatchObject({ changed: false, skipped: "absent" });
    });

    it("order of arrival does not matter for grow-only notes", () => {
      const runOrder = (ops: readonly Op[]) => {
        db.close();
        db = openDb({ path: join(tempDir, `note-${Math.random()}.db`) });
        seedLocalTask("t1");
        for (const op of ops) ingest(op);
        return (
          db.prepare("SELECT content FROM task_notes ORDER BY content").all() as {
            content: string;
          }[]
        ).map((r) => r.content);
      };
      const a = noteOp(1000, "alpha");
      const b = noteOp(2000, "beta");
      expect(runOrder([a, b])).toEqual(["alpha", "beta"]);
      expect(runOrder([b, a])).toEqual(["alpha", "beta"]);
    });
  });

  // ─── edges: LWW-element-set ──────────────────────────────────────────

  describe("edges are an LWW-element-set", () => {
    const edgeKey = "demo/a->demo/b";
    const add = (wall: number) =>
      makeOp({
        hlc: peerHlc(wall),
        entity: "edge",
        key: edgeKey,
        payload: { created_at: "2026-01-01T00:00:00.000Z" },
      });
    const remove = (wall: number) =>
      makeOp({ hlc: peerHlc(wall), entity: "edge", key: edgeKey, op: "del", machineId: PEER_B });

    const edgeExists = () => {
      const row = db
        .prepare(
          `SELECT 1 AS present FROM task_edges e
             JOIN tasks f ON f.id = e.from_task_id
             JOIN tasks t ON t.id = e.to_task_id
            WHERE f.local_id = 'a' AND t.local_id = 'b'`,
        )
        .get() as { present: number } | undefined;
      return row !== undefined;
    };

    const seedPair = () => {
      seedLocalTask("a");
      seedLocalTask("b");
    };

    it("add then NEWER remove -> absent; add then OLDER remove -> present", () => {
      db.close();
      db = openDb({ path: join(tempDir, "e1.db") });
      seedPair();
      ingest(add(1000));
      expect(edgeExists()).toBe(true);
      ingest(remove(2000));
      expect(edgeExists()).toBe(false);

      db.close();
      db = openDb({ path: join(tempDir, "e2.db") });
      seedPair();
      ingest(add(5000));
      ingest(remove(1000));
      expect(edgeExists()).toBe(true);
    });

    it("remove then NEWER add -> re-added (element resurrection)", () => {
      seedPair();
      ingest(remove(1000));
      const r = ingest(add(5000));
      expect(r.changed).toBe(true);
      expect(edgeExists()).toBe(true);
    });

    it("remove then OLDER add -> stays absent", () => {
      seedPair();
      ingest(add(1000)); // present locally first
      ingest(remove(5000));
      expect(edgeExists()).toBe(false);
      const late = ingest(
        makeOp({
          hlc: peerHlc(2000),
          entity: "edge",
          key: edgeKey,
          payload: { created_at: "x" },
          machineId: "9f1c8a2e-0000-4000-8000-0000000000cc",
        }),
      );
      expect(late).toMatchObject({ changed: false, skipped: "older-than-tombstone" });
      expect(edgeExists()).toBe(false);
    });

    it("converges to the same state in either arrival order", () => {
      for (const [addWall, delWall, present] of [
        [1000, 2000, false],
        [5000, 1000, true],
      ] as const) {
        const seen: boolean[] = [];
        for (const order of [
          [add(addWall), remove(delWall)],
          [remove(delWall), add(addWall)],
        ]) {
          db.close();
          db = openDb({ path: join(tempDir, `eo-${addWall}-${delWall}-${Math.random()}.db`) });
          seedPair();
          for (const op of order) ingest(op);
          seen.push(edgeExists());
        }
        expect(seen, `add@${addWall} del@${delWall}`).toEqual([present, present]);
      }
    });

    it("adding an existing edge twice is idempotent", () => {
      seedPair();
      ingest(add(1000));
      const second = ingest(add(1000));
      expect(second).toMatchObject({ changed: false, skipped: "already-present" });
      const n = (db.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }).n;
      expect(n).toBe(1);
    });

    it("parses an edge key whose blocker id ends in a hyphen", () => {
      // Task ids may end in '-', so 'demo/a-->demo/b' is blocker 'a-'.
      // A naive split('->') would produce three fragments.
      seedLocalTask("a-");
      seedLocalTask("b");
      const r = ingest(
        makeOp({
          hlc: peerHlc(1000),
          entity: "edge",
          key: "demo/a-->demo/b",
          payload: { created_at: "2026-01-01T00:00:00.000Z" },
        }),
      );
      expect(r.changed).toBe(true);
    });
  });

  // ─── ownership never syncs ───────────────────────────────────────────

  describe("machine-local fields are stripped", () => {
    it("a peer's owner_id is IGNORED (ownership does not sync)", () => {
      // owner_id is an FK into `agents`, which is machine-local, so a
      // peer's value would at best name an unrelated local agent and at
      // worst violate the FK ('FOREIGN KEY constraint failed').
      seedLocalTask("t1");
      const r = ingest(
        makeOp({
          hlc: peerHlc(9_000_000),
          entity: "task",
          key: "demo/t1",
          payload: { owner_id: 4242, status: "IN_PROGRESS" },
        }),
      );
      expect(r.appliedFields).toEqual(["status"]);
      expect(task("demo/t1")).toMatchObject({ status: "IN_PROGRESS", owner_id: null });
    });

    it("a payload cannot rename a row out from under its own key", () => {
      seedLocalTask("t1");
      ingest(
        makeOp({
          hlc: peerHlc(9_000_000),
          entity: "task",
          key: "demo/t1",
          payload: { local_id: "hijacked", title: "ok" },
        }),
      );
      expect(task("demo/t1")).toMatchObject({ title: "ok" });
      expect(task("demo/hijacked")).toBeUndefined();
    });

    it("unknown payload fields are ignored, not fatal", () => {
      // A peer on a newer mu may send fields we do not know yet.
      seedLocalTask("t1");
      const r = ingest(
        makeOp({
          hlc: peerHlc(9_000_000),
          entity: "task",
          key: "demo/t1",
          payload: { status: "CLOSED", some_future_column: "whatever" },
        }),
      );
      expect(r.appliedFields).toEqual(["status"]);
    });
  });

  // ─── non-synced entities are rejected loudly ─────────────────────────

  describe("non-synced entities", () => {
    it("throws OpEntityNotSyncedError for machine-local entities", () => {
      for (const entity of ["agent", "workspace", "machine_identity", "sync_peers", "nonsense"]) {
        expect(() => applyOp(db, makeOp({ hlc: peerHlc(1000), entity, key: "whatever" }))).toThrow(
          OpEntityNotSyncedError,
        );
      }
    });

    it("names the offending entity and the accepted set", () => {
      try {
        applyOp(db, makeOp({ hlc: peerHlc(1000), entity: "agent", key: "demo/w1" }));
        throw new Error("expected a throw");
      } catch (err) {
        if (!(err instanceof OpEntityNotSyncedError)) throw err;
        expect(err.entity).toBe("agent");
        expect(err.message).toContain("not synced");
        expect(err.message).toContain("task");
      }
    });

    it("rejects a malformed natural key", () => {
      expect(() =>
        applyOp(db, makeOp({ hlc: peerHlc(1000), entity: "task", key: "no-slash" })),
      ).toThrow(OpKeyMalformedError);
      expect(() =>
        applyOp(db, makeOp({ hlc: peerHlc(1000), entity: "edge", key: "demo/a" })),
      ).toThrow(OpKeyMalformedError);
      expect(() =>
        applyOp(db, makeOp({ hlc: peerHlc(1000), entity: "note", key: "demo/a" })),
      ).toThrow(OpKeyMalformedError);
    });
  });

  // ─── THE echo guard ──────────────────────────────────────────────────

  describe("echo suppression", () => {
    const capturedOps = () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM ops WHERE entity IN ('workstream','task','note','edge')`,
          )
          .get() as { n: number }
      ).n;

    it("applying ops produces NO new ops", () => {
      // Without this, writing a peer's op to `tasks` would fire the
      // capture trigger, mint a fresh local op, flush it back to the
      // peer, and loop forever.
      seedLocalTask("t1");
      seedLocalTask("t2");
      const before = capturedOps();

      // A representative op of every kind that touches a table.
      applyOp(
        db,
        makeOp({
          hlc: peerHlc(3000),
          entity: "workstream",
          key: "demo",
          payload: { created_at: "2026-01-01T00:00:00.000Z" },
        }),
      );
      applyOp(
        db,
        makeOp({
          hlc: peerHlc(3100),
          entity: "task",
          key: "demo/t1",
          payload: { status: "CLOSED" },
        }),
      );
      applyOp(
        db,
        makeOp({
          hlc: peerHlc(3200),
          entity: "task",
          key: "demo/fresh",
          payload: { title: "new" },
        }),
      );
      applyOp(
        db,
        makeOp({
          hlc: peerHlc(3300),
          entity: "note",
          key: "demo/t1#3",
          payload: { content: "n", author: "p" },
        }),
      );
      applyOp(
        db,
        makeOp({
          hlc: peerHlc(3400),
          entity: "edge",
          key: "demo/t1->demo/t2",
          payload: { created_at: "2026-01-01T00:00:00.000Z" },
        }),
      );
      applyOp(
        db,
        makeOp({ hlc: peerHlc(3500), entity: "edge", key: "demo/t1->demo/t2", op: "del" }),
      );
      applyOp(db, makeOp({ hlc: peerHlc(3600), entity: "task", key: "demo/t1", op: "del" }));

      expect(capturedOps()).toBe(before);
      // …and the writes really happened.
      expect(task("demo/t1")).toBeUndefined();
      expect(task("demo/fresh")).toBeDefined();
    });

    it("capture resumes after applyOp returns", () => {
      seedLocalTask("t1");
      applyOp(
        db,
        makeOp({
          hlc: peerHlc(3000),
          entity: "task",
          key: "demo/t1",
          payload: { status: "CLOSED" },
        }),
      );
      const before = capturedOps();
      // A normal local mutation must still be captured.
      addTask(db, { workstream: "demo", localId: "after", title: "x", impact: 5, effortDays: 1 });
      expect(capturedOps()).toBeGreaterThan(before);
    });

    it("capture resumes even when applyOp throws", () => {
      seedLocalTask("t1");
      expect(() =>
        applyOp(db, makeOp({ hlc: peerHlc(1000), entity: "task", key: "malformed" })),
      ).toThrow(OpKeyMalformedError);
      const before = capturedOps();
      addTask(db, { workstream: "demo", localId: "after2", title: "x", impact: 5, effortDays: 1 });
      expect(capturedOps()).toBeGreaterThan(before);
    });
  });

  // ─── idempotence: the universal repair property ──────────────────────

  describe("idempotence", () => {
    it("applying the same op twice changes nothing the second time", () => {
      seedLocalTask("t1");
      const op = makeOp({
        hlc: peerHlc(9_000_000),
        entity: "task",
        key: "demo/t1",
        payload: { status: "CLOSED", impact: 88 },
      });
      const first = ingest(op);
      expect(first.changed).toBe(true);
      const snapshot = task("demo/t1");

      const second = ingest(op);
      expect(second.changed).toBe(false);
      expect(task("demo/t1")).toEqual(snapshot);
    });

    it("re-applying a whole segment from zero is a no-op (mu sync --repair)", () => {
      // The property that lets 'repair' be nothing more than
      // "re-read that peer's segment from the beginning".
      seedLocalTask("t1");
      seedLocalTask("t2");
      const segment: Op[] = [
        makeOp({ hlc: peerHlc(1000), entity: "task", key: "demo/t1", payload: { impact: 61 } }),
        makeOp({
          hlc: peerHlc(1100),
          entity: "task",
          key: "demo/t1",
          payload: { status: "CLOSED" },
        }),
        makeOp({
          hlc: peerHlc(1200),
          entity: "note",
          key: "demo/t1#4",
          payload: { content: "c", author: "a" },
        }),
        makeOp({
          hlc: peerHlc(1300),
          entity: "edge",
          key: "demo/t1->demo/t2",
          payload: { created_at: "2026-01-01T00:00:00.000Z" },
        }),
        makeOp({
          hlc: peerHlc(1400),
          entity: "task",
          key: "demo/t2",
          payload: { title: "second" },
        }),
      ];

      for (const op of segment) ingest(op);
      const snapshot = {
        t1: task("demo/t1"),
        t2: task("demo/t2"),
        notes: db.prepare("SELECT COUNT(*) AS n FROM task_notes").get(),
        edges: db.prepare("SELECT COUNT(*) AS n FROM task_edges").get(),
      };

      // Replay the entire segment twice more.
      for (let round = 0; round < 2; round++) for (const op of segment) ingest(op);

      expect({
        t1: task("demo/t1"),
        t2: task("demo/t2"),
        notes: db.prepare("SELECT COUNT(*) AS n FROM task_notes").get(),
        edges: db.prepare("SELECT COUNT(*) AS n FROM task_edges").get(),
      }).toEqual(snapshot);
    });

    it("applyOp is safe on an op already recorded in ops (order-independent)", () => {
      // v2-sync may record-then-apply or apply-then-record. Provenance
      // excludes the op's own HLC so neither order changes the outcome.
      seedLocalTask("t1");
      const op = makeOp({
        hlc: peerHlc(9_000_000),
        entity: "task",
        key: "demo/t1",
        payload: { impact: 33 },
      });
      // apply BEFORE recording
      expect(applyOp(db, op).changed).toBe(true);
      expect(task("demo/t1")?.impact).toBe(33);
      record(op);
      // and again, now that it IS recorded
      expect(applyOp(db, op).changed).toBe(false);
      expect(task("demo/t1")?.impact).toBe(33);
    });
  });

  // ─── applyOps ordering ───────────────────────────────────────────────

  describe("applyOps", () => {
    it("sorts by HLC, so arrival order does not matter", () => {
      const ops = [
        makeOp({ hlc: peerHlc(3000), entity: "task", key: "demo/t1", payload: { impact: 30 } }),
        makeOp({ hlc: peerHlc(1000), entity: "task", key: "demo/t1", payload: { impact: 10 } }),
        makeOp({ hlc: peerHlc(2000), entity: "task", key: "demo/t1", payload: { impact: 20 } }),
      ];
      const run = (list: readonly Op[]) => {
        db.close();
        db = openDb({ path: join(tempDir, `ord-${Math.random()}.db`) });
        seedLocalTask("t1");
        for (const op of list) record(op);
        applyOps(db, list);
        return task("demo/t1")?.impact;
      };
      // Newest HLC (3000 -> impact 30) must win in every permutation.
      expect(run(ops)).toBe(30);
      expect(run([...ops].reverse())).toBe(30);
      expect(run([ops[1], ops[0], ops[2]].filter((o): o is Op => o !== undefined))).toBe(30);
    });

    it("returns one result per op", () => {
      seedLocalTask("t1");
      const ops = [
        makeOp({ hlc: peerHlc(1000), entity: "task", key: "demo/t1", payload: { impact: 10 } }),
        makeOp({
          hlc: peerHlc(2000),
          entity: "task",
          key: "demo/t1",
          payload: { status: "CLOSED" },
        }),
      ];
      for (const op of ops) record(op);
      expect(applyOps(db, ops)).toHaveLength(2);
    });
  });

  // ─── round-trip against real captured ops ────────────────────────────

  describe("round-trip with real capture output", () => {
    it("ops captured on one DB apply cleanly to another, converging", () => {
      // End-to-end: capture writes ops from real SDK calls, and those
      // exact ops replay onto a second DB. Guards the key formats and
      // payload shapes actually agreeing between the two modules.
      ensureWorkstream(db, "demo");
      addTask(db, { workstream: "demo", localId: "a", title: "A", impact: 50, effortDays: 1 });
      addTask(db, { workstream: "demo", localId: "b", title: "B", impact: 60, effortDays: 2 });
      addBlockEdge(db, "demo", "b", "a");
      addNote(db, "a", "a real note", { workstream: "demo", author: "worker-1" });
      db.prepare("UPDATE tasks SET status='CLOSED' WHERE local_id='a'").run();

      const captured = db
        .prepare(
          `SELECT hlc, machine_id, group_id, actor, intent, entity, key, op, payload
             FROM ops
            WHERE entity IN ('workstream','task','note','edge')
            ORDER BY hlc`,
        )
        .all() as Array<{
        hlc: string;
        machine_id: string;
        group_id: string;
        actor: string | null;
        intent: string | null;
        entity: string;
        key: string;
        op: "put" | "del";
        payload: string;
      }>;
      expect(captured.length).toBeGreaterThan(4);

      const target = openDb({ path: join(tempDir, "target.db") });
      try {
        const ops: Op[] = captured.map((r) => ({
          hlc: r.hlc,
          machineId: r.machine_id,
          groupId: r.group_id,
          actor: r.actor,
          intent: r.intent,
          entity: r.entity,
          key: r.key,
          op: r.op,
          payload: r.payload,
        }));
        for (const op of ops) {
          target
            .prepare(
              `INSERT OR IGNORE INTO ops
                 (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              op.hlc,
              op.machineId,
              op.groupId,
              op.actor ?? null,
              op.intent ?? null,
              op.entity,
              op.key,
              op.op,
              op.payload,
              new Date().toISOString(),
            );
        }
        applyOps(target, ops);

        const remote = target
          .prepare(
            `SELECT t.local_id, t.title, t.status, t.impact, t.effort_days
               FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
              WHERE w.name = 'demo' ORDER BY t.local_id`,
          )
          .all() as Array<Record<string, unknown>>;
        expect(remote).toEqual([
          { local_id: "a", title: "A", status: "CLOSED", impact: 50, effort_days: 1 },
          { local_id: "b", title: "B", status: "OPEN", impact: 60, effort_days: 2 },
        ]);

        // The edge and the note came across too.
        const edges = (
          target.prepare("SELECT COUNT(*) AS n FROM task_edges").get() as { n: number }
        ).n;
        expect(edges).toBe(1);
        const note = target.prepare("SELECT author, content FROM task_notes").get() as {
          author: string;
          content: string;
        };
        expect(note).toEqual({ author: "worker-1", content: "a real note" });

        // Replaying is idempotent on the target too.
        applyOps(target, ops);
        expect(
          (target.prepare("SELECT COUNT(*) AS n FROM task_notes").get() as { n: number }).n,
        ).toBe(1);
      } finally {
        target.close();
      }
    });
  });
});
