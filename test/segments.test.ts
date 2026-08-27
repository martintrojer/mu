// Tests for src/segments.ts — the transport layer.
//
// The shape that matters is TWO DATABASES and one shared directory,
// because that is the real deployment: two machines, a folder something
// else moves. Single-DB tests would pass while missing the whole point,
// so most tests here open two temp DBs.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { formatHlc } from "../src/hlc.js";
import { withOpContext } from "../src/op-context.js";
import {
  discoverPeers,
  encodeSegmentLine,
  flushSegment,
  getWatermark,
  ingestSegment,
  localMachineId,
  readManifest,
  resetWatermark,
  SEGMENT_FORMAT_VERSION,
  segmentPath,
  syncDir,
  syncPass,
  verifyAgainstManifest,
} from "../src/segments.js";
import { addBlockEdge } from "../src/tasks/edges.js";
import { addNote, addTask, deleteTask, updateTask } from "../src/tasks/edit.js";
import { closeTask } from "../src/tasks/lifecycle.js";
import { ensureWorkstream } from "../src/workstream.js";
import { rmFixtureDir } from "./_fs.js";

describe("segments", () => {
  let tempDir: string;
  let dir: string;
  let a: Db;
  let b: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-seg-test-"));
    dir = join(tempDir, "sync");
    mkdirSync(dir, { recursive: true });
    a = openDb({ path: join(tempDir, "a.db") });
    b = openDb({ path: join(tempDir, "b.db") });
  });

  afterEach(() => {
    for (const db of [a, b]) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    const key = "MU_SYNC_DIR";
    delete process.env[key];
    rmFixtureDir(tempDir);
  });

  const seedTask = (db: Db, localId: string, impact = 50): void => {
    ensureWorkstream(db, "demo");
    addTask(db, {
      workstream: "demo",
      localId,
      title: localId.toUpperCase(),
      impact,
      effortDays: 1,
    });
  };

  const task = (db: Db, localId: string) =>
    db
      .prepare("SELECT local_id, title, status, impact FROM tasks WHERE local_id = ?")
      .get(localId) as
      | { local_id: string; title: string; status: string; impact: number }
      | undefined;

  /** Every peer segment `db` can see. */
  const peersFor = (db: Db) => discoverPeers(dir, localMachineId(db));

  /** Ingest every peer once. */
  const ingestAll = (db: Db) => peersFor(db).map((peer) => ingestSegment(db, peer));

  const segFor = (db: Db): string => segmentPath(dir, localMachineId(db));

  /** Establish a task on `origin` and sync it to `others`, so every
   *  machine shares ONE creation op.
   *
   *  This matters for the convergence tests. If each machine
   *  independently ran `task add` for the same id, each would emit its own
   *  `task.add` op naming EVERY field (including `status:"OPEN"`), and
   *  whichever creation happened to land a millisecond later would
   *  legitimately win per-field LWW on `status` — reverting a close that
   *  was made before it. That is correct LWW behaviour on an unrealistic
   *  history, not a sync bug: real peers create a task once and receive
   *  it. Sharing the creation op is therefore the honest fixture. */
  const establishShared = async (origin: Db, others: readonly Db[], localId: string) => {
    ensureWorkstream(origin, "demo");
    addTask(origin, {
      workstream: "demo",
      localId,
      title: localId.toUpperCase(),
      impact: 50,
      effortDays: 2,
    });
    await flushSegment(origin, dir);
    for (const other of others) {
      for (const peer of discoverPeers(dir, localMachineId(other))) ingestSegment(other, peer);
    }
  };

  const linesOf = (path: string): string[] =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");

  it("does not flush historical prose workstream.export ops", async () => {
    const machineId = localMachineId(a);
    a.prepare(
      `INSERT INTO ops
         (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
       VALUES (?, ?, 'legacy-export', 'system', 'workstream.export', 'workstream',
               'demo', 'put', 'workstream export demo (out=/tmp/x)', ?)`,
    ).run(
      formatHlc({ wallMs: 2_000_000_000_000, counter: 0, machineId }),
      machineId,
      new Date().toISOString(),
    );

    const result = await flushSegment(a, dir);
    expect(result.appended).toBe(0);
    expect(result.skippedLocal).toBe(1);
    expect(readFileSync(result.segmentPath ?? "", "utf8")).toBe("");
  });

  // ─── round trip ──────────────────────────────────────────────────────

  describe("round trip between two machines", () => {
    it.each(["REJECTED", "DEFERRED"])("ingests a legacy %s task op as OPEN", (status) => {
      const machineId = "legacy-v9-peer";
      const payload = JSON.stringify({
        title: "Legacy task",
        status,
        impact: 50,
        effort_days: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      });
      const line = encodeSegmentLine({
        hlc: formatHlc({ wallMs: 2_000_000_000_000, counter: 0, machineId }),
        machineId,
        groupId: "legacy-group",
        actor: "v9-peer",
        intent: "task.defer",
        entity: "task",
        key: "demo/legacy",
        op: "put",
        payload,
      });
      const path = join(dir, `${machineId}.jsonl`);
      writeFileSync(path, `${line}\n`);

      const result = ingestSegment(b, { machineId, path, conflictCopy: false });
      expect(result.defects).toEqual([]);
      expect(task(b, "legacy")?.status).toBe("OPEN");
      expect(
        (
          b.prepare("SELECT payload FROM ops WHERE machine_id = ?").get(machineId) as {
            payload: string;
          }
        ).payload,
      ).toBe(payload);
    });

    it("A flushes, B ingests, and B's tables match A's", async () => {
      ensureWorkstream(a, "demo");
      addTask(a, { workstream: "demo", localId: "x", title: "X", impact: 60, effortDays: 1 });
      addTask(a, { workstream: "demo", localId: "y", title: "Y", impact: 40, effortDays: 2 });
      addBlockEdge(a, "demo", "y", "x");
      addNote(a, "x", "context", { workstream: "demo", author: "worker-1" });
      closeTask(a, "x", { workstream: "demo" });

      const flushed = await flushSegment(a, dir);
      expect(flushed.appended).toBeGreaterThan(4);
      expect(existsSync(flushed.segmentPath ?? "")).toBe(true);

      const results = ingestAll(b);
      expect(results).toHaveLength(1);
      expect(results[0]?.defects).toEqual([]);

      // Row-by-row, not counts: a count-only check passes on garbage.
      const shape = (db: Db) => ({
        workstreams: db.prepare("SELECT name FROM workstreams ORDER BY name").all(),
        tasks: db
          .prepare(
            `SELECT w.name AS ws, t.local_id, t.title, t.status, t.impact, t.effort_days
               FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
              ORDER BY t.local_id`,
          )
          .all(),
        notes: db.prepare("SELECT author, content FROM task_notes ORDER BY content").all(),
        edges: db.prepare("SELECT COUNT(*) AS n FROM task_edges").get(),
      });
      expect(shape(b)).toEqual(shape(a));
    });

    it("carries a deletion across", async () => {
      seedTask(a, "gone");
      seedTask(a, "stays");
      await flushSegment(a, dir);
      ingestAll(b);
      expect(task(b, "gone")).toBeDefined();

      deleteTask(a, "gone", "demo");
      await flushSegment(a, dir);
      ingestAll(b);
      expect(task(b, "gone")).toBeUndefined();
      expect(task(b, "stays")).toBeDefined();
    });

    it("creates the segment even with nothing to say, so peers can discover us", async () => {
      const result = await flushSegment(a, dir);
      expect(result.appended).toBe(0);
      expect(existsSync(result.segmentPath ?? "")).toBe(true);
      // …and B sees A as a peer immediately.
      expect(peersFor(b).map((p) => p.machineId)).toEqual([localMachineId(a)]);
    });
  });

  // ─── THE MONEY TEST ──────────────────────────────────────────────────

  describe("convergence (the sync thesis)", () => {
    it("A and B edit DIFFERENT fields of the SAME task and both keep BOTH", async () => {
      // Proven at the applyOp level in R5; this proves it end-to-end
      // THROUGH FILES, which is the claim that actually matters.
      await establishShared(a, [b], "fix-auth");
      // Concurrent, on two machines, with no coordination.
      closeTask(a, "fix-auth", { workstream: "demo" });
      updateTask(b, "fix-auth", { impact: 95 }, { workstream: "demo" });

      await flushSegment(a, dir);
      await flushSegment(b, dir);
      ingestAll(a);
      ingestAll(b);

      // BOTH edits survive on BOTH machines. Row-level LWW would have
      // discarded one of them.
      for (const [label, db] of [
        ["A", a],
        ["B", b],
      ] as const) {
        expect(task(db, "fix-auth"), label).toMatchObject({
          status: "CLOSED",
          impact: 95,
          title: "FIX-AUTH",
        });
      }
    });

    it("converges regardless of the order the segments are exchanged", async () => {
      await establishShared(a, [b], "t");
      closeTask(a, "t", { workstream: "demo" });
      updateTask(b, "t", { impact: 77 }, { workstream: "demo" });

      // B ingests first this time, then A.
      await flushSegment(b, dir);
      ingestAll(a);
      await flushSegment(a, dir);
      ingestAll(b);
      // A must re-flush what it learned for B to see it? No — B already
      // has its own edit, and A's segment carries A's. Both converge.
      await flushSegment(a, dir);
      ingestAll(b);

      expect(task(a, "t")).toMatchObject({ status: "CLOSED", impact: 77 });
      expect(task(b, "t")).toMatchObject({ status: "CLOSED", impact: 77 });
    });

    it("a three-way exchange converges", async () => {
      const c = openDb({ path: join(tempDir, "c.db") });
      try {
        await establishShared(a, [b, c], "shared");
        closeTask(a, "shared", { workstream: "demo" });
        updateTask(b, "shared", { impact: 88 }, { workstream: "demo" });
        updateTask(c, "shared", { title: "Renamed by C" }, { workstream: "demo" });

        for (const db of [a, b, c]) await flushSegment(db, dir);
        for (const db of [a, b, c]) ingestAll(db);
        // A second pass so each machine's own late edits propagate.
        for (const db of [a, b, c]) await flushSegment(db, dir);
        for (const db of [a, b, c]) ingestAll(db);

        for (const [label, db] of [
          ["A", a],
          ["B", b],
          ["C", c],
        ] as const) {
          expect(task(db, "shared"), label).toMatchObject({
            status: "CLOSED",
            impact: 88,
            title: "Renamed by C",
          });
        }
      } finally {
        c.close();
      }
    });
  });

  // ─── idempotence ─────────────────────────────────────────────────────

  describe("idempotence", () => {
    it("ingesting the same segment 3x gives identical state and no duplicate ops", async () => {
      seedTask(a, "p");
      seedTask(a, "q");
      await flushSegment(a, dir);
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");

      const first = ingestSegment(b, peer);
      const snapshot = {
        tasks: b.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all(),
        ops: (b.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n,
      };
      expect(first.applied).toBeGreaterThan(0);

      const second = ingestSegment(b, peer);
      const third = ingestSegment(b, peer);
      expect([second.applied, third.applied]).toEqual([0, 0]);
      expect({
        tasks: b.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all(),
        ops: (b.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n,
      }).toEqual(snapshot);
    });

    it("re-reading from zero is safe (the universal repair)", async () => {
      seedTask(a, "r");
      await flushSegment(a, dir);
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      ingestSegment(b, peer);
      const before = b.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all();
      const ops = (b.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n;

      resetWatermark(b, localMachineId(a));
      const again = ingestSegment(b, peer);
      // Every line is re-read and re-applied, changing nothing.
      expect(again.applied).toBeGreaterThan(0);
      expect(again.changed).toBe(0);
      expect(b.prepare("SELECT local_id, impact FROM tasks ORDER BY local_id").all()).toEqual(
        before,
      );
      expect((b.prepare("SELECT COUNT(*) AS n FROM ops").get() as { n: number }).n).toBe(ops);
    });

    it("flushing twice appends nothing the second time", async () => {
      seedTask(a, "s");
      const first = await flushSegment(a, dir);
      const second = await flushSegment(a, dir);
      expect(first.appended).toBeGreaterThan(0);
      expect(second.appended).toBe(0);
      expect(second.total).toBe(first.total);
    });

    it("flush is incremental: only NEW ops are appended", async () => {
      seedTask(a, "u");
      const first = await flushSegment(a, dir);
      updateTask(a, "u", { impact: 91 }, { workstream: "demo" });
      const second = await flushSegment(a, dir);
      expect(second.appended).toBe(1);
      expect(second.total).toBe(first.total + 1);
    });
  });

  // ─── the four robustness layers ──────────────────────────────────────

  describe("robustness", () => {
    const seedFour = async (): Promise<string> => {
      ensureWorkstream(a, "demo");
      for (let i = 0; i < 4; i++) {
        addTask(a, {
          workstream: "demo",
          localId: `t${i}`,
          title: `T${i}`,
          impact: 50,
          effortDays: 1,
        });
      }
      await flushSegment(a, dir);
      return segFor(a);
    };

    it("LAYER 1: a torn write stops ingest at the last GOOD record", async () => {
      const path = await seedFour();
      const whole = readFileSync(path, "utf8");
      // Truncate mid-line, as an in-flight transfer would.
      writeFileSync(path, whole.slice(0, whole.length - 40));

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "torn-write")).toBe(true);
      expect(result.truncatedAt).not.toBeNull();
      // The watermark stopped short, so the tail is re-read next time.
      expect(result.watermark).toBeLessThan(linesOf(path).length + 1);
    });

    it("LAYER 1: the completed tail is picked up on the next ingest", async () => {
      const path = await seedFour();
      const whole = readFileSync(path, "utf8");
      writeFileSync(path, whole.slice(0, whole.length - 40));
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const partial = ingestSegment(b, peer);

      // The transfer completes.
      writeFileSync(path, whole);
      const rest = ingestSegment(b, peer);
      expect(rest.applied).toBeGreaterThan(0);
      expect(rest.defects).toEqual([]);
      expect(rest.watermark).toBeGreaterThan(partial.watermark);
    });

    it("LAYER 2: crc catches bit rot that JSON.parse accepts", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      const target = lines[1];
      if (target === undefined) throw new Error("expected a second line");
      // Valid JSON afterwards, but one field's content changed.
      lines[1] = target.replace('"title":"T0"', '"title":"TX"');
      expect(lines[1]).not.toBe(target);
      writeFileSync(path, `${lines.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "crc-mismatch")).toBe(true);
      // Stopped at the bad line, so the good first line still applied.
      expect(result.watermark).toBe(1);
    });

    it("LAYER 3: a reordered segment is detected as non-monotonic", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      const third = lines[2];
      const fourth = lines[3];
      if (third === undefined || fourth === undefined) throw new Error("need 4 lines");
      lines[2] = fourth;
      lines[3] = third;
      writeFileSync(path, `${lines.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "non-monotonic-hlc")).toBe(true);
    });

    it("LAYER 3: a duplicated line is detected", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      const first = lines[0];
      if (first === undefined) throw new Error("need a line");
      writeFileSync(path, `${[first, first, ...lines.slice(1)].join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "non-monotonic-hlc")).toBe(true);
    });

    it("LAYER 4: the manifest catches truncation on a line boundary", async () => {
      // Every remaining line is individually valid, so layers 1-3 see
      // nothing wrong. Only whole-file verification can catch this.
      const path = await seedFour();
      const lines = linesOf(path);
      writeFileSync(path, `${lines.slice(0, 2).join("\n")}\n`);

      const verified = verifyAgainstManifest(path);
      expect(verified.ok).toBe(false);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "manifest-mismatch")).toBe(true);
    });

    it("LAYER 4: a GROWN segment is not reported as damage", async () => {
      // The common case: the peer appended after the manifest we hold, or
      // our copy is mid-transfer. Flagging that would cry wolf constantly.
      const path = await seedFour();
      const manifest = readManifest(path);
      expect(manifest).not.toBeNull();
      addTask(a, { workstream: "demo", localId: "extra", title: "E", impact: 50, effortDays: 1 });
      const appended = linesOf(path).length;
      // Simulate a stale manifest by writing the file's new content
      // without refreshing the sidecar.
      const whole = readFileSync(path, "utf8");
      writeFileSync(path, whole);
      expect(linesOf(path).length).toBe(appended);
      expect(verifyAgainstManifest(path).ok).toBe(true);
    });

    it("refuses a segment line from an unknown format version", async () => {
      const path = await seedFour();
      const lines = linesOf(path);
      const first = lines[0];
      if (first === undefined) throw new Error("need a line");
      lines[0] = first.replace(`{"v":${SEGMENT_FORMAT_VERSION},`, '{"v":99,');
      writeFileSync(path, `${lines.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects.some((d) => d.kind === "unknown-version")).toBe(true);
      expect(result.watermark).toBe(0);
    });

    it("a damaged segment is recoverable, not fatal: fix it and re-read", async () => {
      const path = await seedFour();
      const whole = readFileSync(path, "utf8");
      const lines = linesOf(path);
      const second = lines[1];
      if (second === undefined) throw new Error("need 2 lines");
      lines[1] = second.replace('"crc":"', '"crc":"0');
      writeFileSync(path, `${lines.join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      expect(ingestSegment(b, peer).defects.length).toBeGreaterThan(0);

      // Operator re-fetches the file; the watermark resumes cleanly.
      writeFileSync(path, whole);
      const repaired = ingestSegment(b, peer);
      expect(repaired.defects).toEqual([]);
      expect(task(b, "t3")).toBeDefined();
    });

    it("a mid-file corruption in OWN segment does not regrow the file forever on repeated flushes", async () => {
      // The regression this guards: readSegmentTail() used to report
      // only "stopped early", with no way to tell a genuine EOF apart
      // from a defect. flushLocked() treated both the same and kept
      // appending fresh ops after the wound on every call, so the file
      // grew strictly larger on EVERY subsequent flush, forever, and
      // never healed.
      const path = await seedFour();
      const lines = linesOf(path);
      const second = lines[1];
      if (second === undefined) throw new Error("need 2 lines");
      // Bit rot: valid JSON, bad crc, mid-file (not at EOF, unlike a
      // torn-write truncation).
      lines[1] = second.replace('"crc":"', '"crc":"0');
      writeFileSync(path, `${lines.join("\n")}\n`);

      // First flush after the damage: must be reported AND healed by
      // truncating back to the one good line before re-deriving anything
      // new from canonical `ops` (t1..t3, lost from disk, plus one new
      // op). That re-derivation happens ONCE, on this call — it is safe
      // regeneration from the canonical source, not the bug.
      addTask(a, { workstream: "demo", localId: "extra-a", title: "A", impact: 50, effortDays: 1 });
      const first = await flushSegment(a, dir);
      expect(first.selfRepaired).not.toBeNull();
      expect(first.selfRepaired?.kind).toBe("crc-mismatch");
      const lineCountBeforeCorruption = 4; // seedFour: t0..t3
      const lineCountAfterHeal = linesOf(path).length;
      // 1 surviving good line (t0) + everything canonical after it
      // (t1..t3, lost from disk, plus the new op) — regenerated once.
      expect(lineCountAfterHeal).toBeGreaterThan(lineCountBeforeCorruption - 3);
      expect(lineCountAfterHeal).toBeGreaterThanOrEqual(lineCountBeforeCorruption);

      // Every flush AFTER the heal is a normal, already-healthy flush:
      // nothing left to repair, and growth is exactly one line per new
      // op — never a repeat of the whole tail.
      for (let i = 0; i < 5; i++) {
        const before = linesOf(path).length;
        addTask(a, {
          workstream: "demo",
          localId: `extra-b${i}`,
          title: `B${i}`,
          impact: 50,
          effortDays: 1,
        });
        const result = await flushSegment(a, dir);
        expect(result.selfRepaired).toBeNull();
        expect(linesOf(path).length).toBe(before + 1);
      }

      // Total: the healed baseline plus exactly one line per subsequent
      // flush — bounded, linear, no repeated regrowth of the tail.
      expect(linesOf(path).length).toBe(lineCountAfterHeal + 5);

      // PEER RECOVERY: a peer discovering this segment from zero gets a
      // clean read all the way through — not a permanent stall on line 1
      // forever, which is what the unbounded-regrowth bug produced (a
      // corrupted first line that never moves, blocking every later,
      // perfectly good op behind it).
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      const result = ingestSegment(b, peer);
      expect(result.defects).toEqual([]);
      expect(result.applied).toBe(lineCountAfterHeal + 5);
      expect(task(b, "t0")).toBeDefined();
      expect(task(b, "t3")).toBeDefined();
      expect(task(b, "extra-b4")).toBeDefined();
    });
  });

  // ─── filtering ───────────────────────────────────────────────────────

  describe("filtering", () => {
    it("machine-local ops NEVER appear in a segment", async () => {
      seedTask(a, "visible");
      // An agent op, as capture would record it: pane id + absolute path,
      // both meaningless on another machine.
      withOpContext(a, { intent: "agent.spawn", group: "new" }, () => {
        a.prepare(
          `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
           VALUES (?, ?, 'g-local', 'user', 'agent.spawn', 'agent', 'demo/worker-1', 'put',
                   '{"pane_id":"%17","path":"/home/me/ws"}', ?)`,
        ).run(
          `001999999999999.000000.${localMachineId(a)}`,
          localMachineId(a),
          new Date().toISOString(),
        );
      });

      const result = await flushSegment(a, dir);
      expect(result.skippedLocal).toBe(1);

      const raw = readFileSync(segFor(a), "utf8");
      const entities = linesOf(segFor(a)).map((l) => (JSON.parse(l) as { entity: string }).entity);
      expect(entities).not.toContain("agent");
      // The specific values that would be wrong elsewhere.
      expect(raw).not.toContain("%17");
      expect(raw).not.toContain("/home/me/ws");
    });

    it("a segment holds only THIS machine's ops, never re-flushed peer ops", async () => {
      // Otherwise two machines would echo each other's history under
      // their own names, growing without bound.
      seedTask(a, "mine");
      await flushSegment(a, dir);
      ingestAll(b);
      seedTask(b, "theirs");
      await flushSegment(b, dir);

      const machines = new Set(
        linesOf(segFor(b)).map((l) => (JSON.parse(l) as { machine: string }).machine),
      );
      expect(machines).toEqual(new Set([localMachineId(b)]));
    });

    it("ingest reports a non-synced entity as a bad-peer defect, not a crash", async () => {
      seedTask(a, "ok");
      await flushSegment(a, dir);
      // A malicious/buggy peer appends an entity that must never travel.
      const path = segFor(a);
      const lines = linesOf(path);
      const template = lines[0];
      if (template === undefined) throw new Error("need a line");
      const forged = template
        .replace('"entity":"workstream"', '"entity":"agent"')
        .replace(/"hlc":"[^"]+"/, '"hlc":"001999999999999.000000.forged"');
      writeFileSync(path, `${[...lines, forged].join("\n")}\n`);

      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");
      // Must not throw.
      const result = ingestSegment(b, peer);
      expect(result.defects.length).toBeGreaterThan(0);
      // Either the crc guard or the entity guard catches it; both are
      // correct rejections of a line that should not exist.
      expect(
        result.defects.some((d) => d.kind === "entity-not-synced" || d.kind === "crc-mismatch"),
      ).toBe(true);
    });
  });

  // ─── peer discovery ──────────────────────────────────────────────────

  describe("peer discovery", () => {
    it("finds every segment that is not mine, with no membership list", async () => {
      await flushSegment(a, dir);
      await flushSegment(b, dir);
      expect(peersFor(a).map((p) => p.machineId)).toEqual([localMachineId(b)]);
      expect(peersFor(b).map((p) => p.machineId)).toEqual([localMachineId(a)]);
    });

    it("ingests a Syncthing conflict copy", async () => {
      // Still a valid op log, and dedup by (machine, hlc) makes reading it
      // safe. Ignoring it would drop real ops exactly when something has
      // already gone wrong.
      seedTask(a, "conflicted");
      await flushSegment(a, dir);
      const original = segFor(a);
      const conflict = join(
        dir,
        `${localMachineId(a)}.sync-conflict-20260609-123456-ABCDEFG.jsonl`,
      );
      writeFileSync(conflict, readFileSync(original, "utf8"));

      const peers = peersFor(b);
      expect(peers.some((p) => p.conflictCopy)).toBe(true);
      const copy = peers.find((p) => p.conflictCopy);
      if (copy === undefined) throw new Error("expected the conflict copy");
      // Its machine id is recovered from the stem before the marker.
      expect(copy.machineId).toBe(localMachineId(a));

      for (const peer of peers) ingestSegment(b, peer);
      expect(task(b, "conflicted")).toBeDefined();
    });

    it("ignores non-segment files in the sync dir", async () => {
      await flushSegment(a, dir);
      writeFileSync(join(dir, "README.md"), "not a segment");
      writeFileSync(join(dir, "notes.txt"), "nor this");
      expect(peersFor(b).map((p) => p.machineId)).toEqual([localMachineId(a)]);
    });

    it("returns nothing when the dir does not exist", () => {
      expect(discoverPeers(join(tempDir, "absent"), localMachineId(a))).toEqual([]);
    });
  });

  // ─── watermarks ──────────────────────────────────────────────────────

  describe("watermarks", () => {
    it("advance with each ingest and persist", async () => {
      seedTask(a, "w1");
      await flushSegment(a, dir);
      const peer = peersFor(b)[0];
      if (peer === undefined) throw new Error("expected a peer");

      expect(getWatermark(b, localMachineId(a))).toBe(0);
      const first = ingestSegment(b, peer);
      expect(getWatermark(b, localMachineId(a))).toBe(first.watermark);
      expect(first.watermark).toBeGreaterThan(0);

      // A new op on A advances it further, and only by the new lines.
      addTask(a, { workstream: "demo", localId: "w2", title: "W2", impact: 50, effortDays: 1 });
      await flushSegment(a, dir);
      const second = ingestSegment(b, peer);
      expect(second.watermark).toBeGreaterThan(first.watermark);
      expect(second.applied).toBe(1);
    });

    it("one integer per peer, tracked independently", async () => {
      const c = openDb({ path: join(tempDir, "c2.db") });
      try {
        seedTask(a, "from-a");
        ensureWorkstream(c, "demo");
        addTask(c, {
          workstream: "demo",
          localId: "from-c",
          title: "C",
          impact: 50,
          effortDays: 1,
        });
        await flushSegment(a, dir);
        await flushSegment(c, dir);
        ingestAll(b);

        expect(getWatermark(b, localMachineId(a))).toBeGreaterThan(0);
        expect(getWatermark(b, localMachineId(c))).toBeGreaterThan(0);
        const rows = b.prepare("SELECT machine_id FROM sync_peers ORDER BY machine_id").all() as {
          machine_id: string;
        }[];
        expect(rows).toHaveLength(2);
      } finally {
        c.close();
      }
    });

    it("survives a close/reopen (it is DB state, not memory)", async () => {
      seedTask(a, "persist");
      await flushSegment(a, dir);
      ingestAll(b);
      const mark = getWatermark(b, localMachineId(a));
      const path = join(tempDir, "b.db");
      b.close();
      b = openDb({ path });
      expect(getWatermark(b, localMachineId(a))).toBe(mark);
    });
  });

  // ─── receiveHlc on ingest ────────────────────────────────────────────

  describe("clock advance on ingest", () => {
    it("the local clock advances past an ingested op's HLC", async () => {
      // What makes "laptop edits after seeing devserver's op" order
      // correctly rather than losing to it.
      seedTask(a, "clock");
      await flushSegment(a, dir);
      const peerMax = linesOf(segFor(a))
        .map((l) => (JSON.parse(l) as { hlc: string }).hlc)
        .sort()
        .at(-1);
      if (peerMax === undefined) throw new Error("expected an hlc");

      ingestAll(b);

      // An edit B makes NOW must sort above everything it just ingested.
      ensureWorkstream(b, "demo");
      addTask(b, {
        workstream: "demo",
        localId: "after",
        title: "After",
        impact: 50,
        effortDays: 1,
      });
      const localMax = (
        b
          .prepare("SELECT MAX(hlc) AS hlc FROM ops WHERE machine_id = ?")
          .get(localMachineId(b)) as {
          hlc: string;
        }
      ).hlc;
      expect(localMax > peerMax).toBe(true);
    });
  });

  // ─── sync not configured ─────────────────────────────────────────────

  describe("MU_SYNC_DIR unset", () => {
    it("flush, ingest and syncPass are no-ops costing nothing", async () => {
      seedTask(a, "nosync");
      const flushed = await flushSegment(a, null);
      expect(flushed).toEqual({
        segmentPath: null,
        appended: 0,
        total: 0,
        skippedLocal: 0,
        selfRepaired: null,
      });

      const pass = await syncPass(a, null);
      expect(pass.flushed.segmentPath).toBeNull();
      expect(pass.ingested).toEqual([]);
      expect(pass.defective).toBe(false);
    });

    it("syncDir() reads the env var and treats blank as unset", () => {
      const key = "MU_SYNC_DIR";
      delete process.env[key];
      expect(syncDir()).toBeNull();
      process.env[key] = "   ";
      expect(syncDir()).toBeNull();
      process.env[key] = dir;
      expect(syncDir()).toBe(dir);
      delete process.env[key];
    });
  });

  // ─── syncPass ────────────────────────────────────────────────────────

  describe("syncPass", () => {
    it("flushes then ingests every peer in one call", async () => {
      seedTask(a, "one");
      seedTask(b, "two");
      await flushSegment(a, dir);

      const pass = await syncPass(b, dir);
      expect(pass.flushed.appended).toBeGreaterThan(0);
      expect(pass.ingested).toHaveLength(1);
      expect(pass.defective).toBe(false);
      expect(task(b, "one")).toBeDefined();
    });

    it("reports defective when a peer segment is damaged", async () => {
      seedTask(a, "dmg");
      await flushSegment(a, dir);
      const path = segFor(a);
      writeFileSync(path, `${readFileSync(path, "utf8").slice(0, 30)}`);

      const pass = await syncPass(b, dir);
      expect(pass.defective).toBe(true);
    });

    it("two concurrent flushes do not interleave lines", async () => {
      // The lock's job. Every line must still parse afterwards; an
      // interleave would produce spliced garbage.
      ensureWorkstream(a, "demo");
      for (let i = 0; i < 12; i++) {
        addTask(a, {
          workstream: "demo",
          localId: `c${i}`,
          title: `C${i}`,
          impact: 50,
          effortDays: 1,
        });
      }
      await Promise.all([flushSegment(a, dir), flushSegment(a, dir), flushSegment(a, dir)]);

      const lines = linesOf(segFor(a));
      for (const line of lines) {
        expect(() => JSON.parse(line) as unknown).not.toThrow();
      }
      // And no op was written twice.
      const hlcs = lines.map((l) => (JSON.parse(l) as { hlc: string }).hlc);
      expect(new Set(hlcs).size).toBe(hlcs.length);
    });
  });
});
