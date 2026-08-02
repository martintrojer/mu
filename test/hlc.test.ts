// Tests for src/hlc.ts — the hybrid logical clock that orders every op.
//
// This is a correctness primitive: a regression here silently loses
// edits on cross-machine merge rather than failing loudly, so the
// tests are deliberately adversarial. The clock is injected (the `now`
// parameter) — no sleeps, so the whole file stays in the fast tier.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  compareHlc,
  formatHlc,
  HlcOverflowError,
  HlcParseError,
  nextHlc,
  parseHlc,
  receiveHlc,
} from "../src/hlc.js";
import { rmFixtureDir } from "./_fs.js";

describe("hlc", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-hlc-test-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed by a test
    }
    rmFixtureDir(tempDir);
  });

  const machineId = (): string => {
    const row = db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as {
      machine_id: string;
    };
    return row.machine_id;
  };

  // ─── format / parse ────────────────────────────────────────────────

  describe("formatHlc / parseHlc", () => {
    it("produces the documented fixed-width dotted shape", () => {
      const s = formatHlc({
        wallMs: 1_780_000_000_123,
        counter: 7,
        machineId: "9f1c8a2e-4b6d-4f0a-9c31-2f7c5d3e8a10",
      });
      expect(s).toBe("001780000000123.000007.9f1c8a2e-4b6d-4f0a-9c31-2f7c5d3e8a10");
    });

    it("round-trips", () => {
      const hlc = { wallMs: 42, counter: 999_999, machineId: "abc-def" };
      expect(parseHlc(formatHlc(hlc))).toEqual(hlc);
    });

    it("rejects malformed values, including the legacy placeholder shape", () => {
      const placeholder = `2026-01-01T00:00:00.000Z|${"a".repeat(8)}`;
      expect(() => parseHlc(placeholder)).toThrow(HlcParseError);
      expect(() => parseHlc("")).toThrow(HlcParseError);
      expect(() => parseHlc("1.2.m")).toThrow(HlcParseError); // unpadded
      expect(() => parseHlc("001780000000123.000007")).toThrow(HlcParseError); // no machine
      expect(() => parseHlc("00178000000012x.000007.m")).toThrow(HlcParseError); // non-digit
    });

    it("refuses a machine_id containing the separator (field spill)", () => {
      expect(() => formatHlc({ wallMs: 1, counter: 1, machineId: "a.b" })).toThrow(HlcParseError);
    });

    it("throws rather than wrapping on counter overflow", () => {
      expect(() => formatHlc({ wallMs: 1, counter: 1_000_000, machineId: "m" })).toThrow(
        HlcOverflowError,
      );
    });
  });

  // ─── lexicographic order == causal order ───────────────────────────

  describe("lexicographic sort equals causal order", () => {
    it("sorts counter 9 before 10 (the zero-padding bug)", () => {
      const nine = formatHlc({ wallMs: 1000, counter: 9, machineId: "m" });
      const ten = formatHlc({ wallMs: 1000, counter: 10, machineId: "m" });
      expect(compareHlc(nine, ten)).toBe(-1);
      expect([ten, nine].sort()).toEqual([nine, ten]);
    });

    it("sorts across a wall-clock digit rollover (999 -> 1000)", () => {
      const before = formatHlc({ wallMs: 999, counter: 5, machineId: "m" });
      const after = formatHlc({ wallMs: 1000, counter: 0, machineId: "m" });
      expect(compareHlc(before, after)).toBe(-1);
      expect([after, before].sort()).toEqual([before, after]);
    });

    it("wall dominates counter", () => {
      const a = formatHlc({ wallMs: 1000, counter: 999_999, machineId: "m" });
      const b = formatHlc({ wallMs: 1001, counter: 0, machineId: "m" });
      expect(compareHlc(a, b)).toBe(-1);
    });

    it("machine_id is a stable tiebreak only", () => {
      const a = formatHlc({ wallMs: 5, counter: 5, machineId: "aaa" });
      const b = formatHlc({ wallMs: 5, counter: 5, machineId: "bbb" });
      expect(compareHlc(a, b)).toBe(-1);
      expect(compareHlc(a, a)).toBe(0);
    });

    it("JS sort agrees with SQLite ORDER BY", () => {
      const minted: string[] = [];
      for (const t of [1000, 1000, 1000, 999, 998, 1200, 1200, 5]) {
        minted.push(nextHlc(db, t));
      }
      db.exec("CREATE TABLE t (hlc TEXT NOT NULL)");
      const ins = db.prepare("INSERT INTO t (hlc) VALUES (?)");
      for (const h of minted) ins.run(h);
      const sql = (db.prepare("SELECT hlc FROM t ORDER BY hlc").all() as { hlc: string }[]).map(
        (r) => r.hlc,
      );
      expect(sql).toEqual([...minted].sort(compareHlc));
      // …and mint order already WAS causal order.
      expect(sql).toEqual(minted);
    });
  });

  // ─── monotonicity ──────────────────────────────────────────────────

  describe("nextHlc monotonicity", () => {
    it("advances the wall and resets the counter when the clock ticks", () => {
      const a = parseHlc(nextHlc(db, 1000));
      const b = parseHlc(nextHlc(db, 1001));
      expect(a).toMatchObject({ wallMs: 1000, counter: 0 });
      expect(b).toMatchObject({ wallMs: 1001, counter: 0 });
    });

    it("increments the counter when the clock STALLS on one millisecond", () => {
      const minted = Array.from({ length: 50 }, () => nextHlc(db, 1000));
      expect(new Set(minted).size).toBe(50);
      expect([...minted].sort(compareHlc)).toEqual(minted);
      expect(minted.map((h) => parseHlc(h).counter)).toEqual(
        Array.from({ length: 50 }, (_, i) => i),
      );
      for (const h of minted) expect(parseHlc(h).wallMs).toBe(1000);
    });

    it("never regresses when the clock jumps BACKWARDS", () => {
      // A laptop sleeps and wakes three days behind the devserver.
      const clocks = [1_780_000_000_000, 1_780_000_000_001, 1_779_740_000_000, 1, 0, 500];
      const minted = clocks.map((t) => nextHlc(db, t));
      for (let i = 1; i < minted.length; i++) {
        const prev = minted[i - 1];
        const cur = minted[i];
        if (prev === undefined || cur === undefined) throw new Error("unreachable");
        expect(compareHlc(prev, cur)).toBe(-1);
      }
      // The wall never went below the pre-jump high-water mark.
      for (const h of minted) expect(parseHlc(h).wallMs).toBeGreaterThanOrEqual(1_780_000_000_000);
    });

    it("recovers real timestamps once the clock catches back up", () => {
      nextHlc(db, 2000);
      nextHlc(db, 1000); // backwards
      const after = parseHlc(nextHlc(db, 5000));
      expect(after).toMatchObject({ wallMs: 5000, counter: 0 });
    });

    it("stamps this machine's id", () => {
      expect(parseHlc(nextHlc(db, 1000)).machineId).toBe(machineId());
    });
  });

  // ─── receiveHlc ────────────────────────────────────────────────────

  describe("receiveHlc", () => {
    const remote = (wall: number, counter: number): string =>
      formatHlc({ wallMs: wall, counter, machineId: "peer-0000" });

    it("advances past a remote HLC from the FUTURE", () => {
      nextHlc(db, 1000);
      const r = remote(9000, 3);
      const got = parseHlc(receiveHlc(db, r, 1000));
      expect(got).toMatchObject({ wallMs: 9000, counter: 4, machineId: machineId() });
      expect(compareHlc(r, formatHlc(got))).toBe(-1);
      // The next local mint still dominates the remote op.
      expect(compareHlc(r, nextHlc(db, 1000))).toBe(-1);
    });

    it("does NOT move the clock backwards for a remote HLC from the past", () => {
      const local = parseHlc(nextHlc(db, 5000));
      const got = parseHlc(receiveHlc(db, remote(10, 0), 4000));
      expect(got.wallMs).toBe(5000);
      expect(got.counter).toBe(local.counter + 1);
    });

    it("uses `now` when it strictly beats both local and remote (counter resets)", () => {
      nextHlc(db, 1000);
      const got = parseHlc(receiveHlc(db, remote(2000, 7), 3000));
      expect(got).toMatchObject({ wallMs: 3000, counter: 0 });
    });

    it("takes max(local, remote) + 1 when local and remote tie at the max wall", () => {
      nextHlc(db, 4000); // counter 0
      nextHlc(db, 4000); // counter 1
      const got = parseHlc(receiveHlc(db, remote(4000, 9), 4000));
      expect(got).toMatchObject({ wallMs: 4000, counter: 10 });
    });

    it("takes remote.counter + 1 when only the remote is at the max wall", () => {
      nextHlc(db, 1000);
      const got = parseHlc(receiveHlc(db, remote(7000, 41), 900));
      expect(got).toMatchObject({ wallMs: 7000, counter: 42 });
    });

    it("keeps causality across the laptop/devserver skew scenario", () => {
      // Devserver op minted at real time; laptop clock is 3 days behind.
      const devOp = remote(1_780_000_000_000, 0);
      const laptopNow = 1_779_740_000_000;
      const afterIngest = receiveHlc(db, devOp, laptopNow);
      const laptopEdit = nextHlc(db, laptopNow);
      expect(compareHlc(devOp, afterIngest)).toBe(-1);
      expect(compareHlc(afterIngest, laptopEdit)).toBe(-1);
    });

    it("rejects a malformed remote HLC without touching the clock", () => {
      const before = nextHlc(db, 1000);
      expect(() => receiveHlc(db, "not-an-hlc", 1000)).toThrow(HlcParseError);
      expect(parseHlc(nextHlc(db, 1000))).toMatchObject({
        wallMs: parseHlc(before).wallMs,
        counter: parseHlc(before).counter + 1,
      });
    });
  });

  // ─── durability ────────────────────────────────────────────────────

  describe("persistence across processes", () => {
    it("survives a close/reopen (catches an in-memory counter)", () => {
      const first = nextHlc(db, 1000);
      const second = nextHlc(db, 1000);
      db.close();

      db = openDb({ path: dbPath });
      const third = nextHlc(db, 1000); // same stalled millisecond
      expect(compareHlc(second, third)).toBe(-1);
      expect(parseHlc(third).counter).toBe(parseHlc(first).counter + 2);
      expect(parseHlc(third).machineId).toBe(machineId());
    });

    it("survives a reopen after a backwards clock jump", () => {
      nextHlc(db, 9_000_000);
      db.close();
      db = openDb({ path: dbPath });
      const after = parseHlc(nextHlc(db, 1000));
      expect(after.wallMs).toBe(9_000_000);
      expect(after.counter).toBe(1);
    });

    it("persists receiveHlc's advance too", () => {
      const r = formatHlc({ wallMs: 8_000_000, counter: 2, machineId: "peer-0000" });
      receiveHlc(db, r, 1000);
      db.close();
      db = openDb({ path: dbPath });
      expect(compareHlc(r, nextHlc(db, 1000))).toBe(-1);
    });
  });

  // ─── concurrency ───────────────────────────────────────────────────

  describe("concurrency", () => {
    it("N connections minting against one DB produce N DISTINCT ordered HLCs", () => {
      // Models `mu agent spawn a & mu agent spawn b & …`: several
      // short-lived processes hitting the same file. better-sqlite3 is
      // synchronous, so the fan-out is modelled as N connections
      // interleaved round-robin — which is exactly the read-modify-write
      // interleaving a non-atomic implementation would lose to.
      const conns = Array.from({ length: 8 }, () => openDb({ path: dbPath }));
      try {
        const minted: string[] = [];
        for (let round = 0; round < 10; round++) {
          for (const c of conns) minted.push(nextHlc(c, 1000)); // stalled clock: worst case
        }
        expect(new Set(minted).size).toBe(minted.length);
        expect([...minted].sort(compareHlc)).toEqual(minted);
      } finally {
        for (const c of conns) c.close();
      }
    });

    it("a UNIQUE (machine_id, hlc) insert never collides across connections", () => {
      db.exec("CREATE TABLE u (machine_id TEXT, hlc TEXT, UNIQUE (machine_id, hlc))");
      const conns = Array.from({ length: 4 }, () => openDb({ path: dbPath }));
      try {
        const ins = db.prepare("INSERT INTO u (machine_id, hlc) VALUES (?, ?)");
        const id = machineId();
        for (let round = 0; round < 25; round++) {
          for (const c of conns) ins.run(id, nextHlc(c, 1000));
        }
        const count = db.prepare("SELECT COUNT(*) AS n FROM u").get() as { n: number };
        expect(count.n).toBe(100);
      } finally {
        for (const c of conns) c.close();
      }
    });
  });
});
