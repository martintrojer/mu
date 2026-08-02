// CLI-level tests for `mu sync` and the AMBIENT sync hook.
//
// Integration tier because every case drives the whole program through
// buildProgram() and writes real files. The decision logic lives in
// test/sync.test.ts (fast tier); this file is about the operator's actual
// workflow, exercised through the VERB rather than the SDK:
//
//   TWO temp DBs + ONE temp dir — the real deployment shape. A
//   single-DB test would pass while missing the entire point.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

const SYNC_DIR_KEY = "MU_SYNC_DIR";

describe("mu sync (CLI)", () => {
  let tempDir: string;
  let dir: string;
  /** "laptop" and "devserver": two machines, one shared folder. */
  let lap: string;
  let dev: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-cli-sync-"));
    dir = join(tempDir, "shared");
    mkdirSync(dir, { recursive: true });
    lap = join(tempDir, "lap.db");
    dev = join(tempDir, "dev.db");
    process.env[SYNC_DIR_KEY] = dir;
  });

  afterEach(() => {
    delete process.env[SYNC_DIR_KEY];
    rmFixtureDir(tempDir);
  });

  const seedTask = async (db: string, id: string, impact = 50): Promise<void> => {
    await runCli(
      ["task", "add", id, "-t", id.toUpperCase(), "-i", String(impact), "-e", "1", "-w", "demo"],
      db,
    );
  };

  const taskJson = async (db: string, id: string) => {
    const { stdout } = await runCli(["task", "show", id, "-w", "demo", "--json"], db);
    return JSON.parse(stdout) as { task: { name: string; status: string; impact: number } };
  };

  const opCount = async (db: string): Promise<number> => {
    // Deliberately via `mu sql`, which does NOT ingest — see the test
    // below. That makes it a safe probe: reading the count cannot change
    // the count.
    const { stdout } = await runCli(["sql", "SELECT COUNT(*) AS n FROM ops", "--json"], db);
    const rows = JSON.parse(stdout) as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  };

  // ─── the workflow that justifies the whole ops-log rewrite ────────

  it("round-trips work between two machines THROUGH THE VERB", async () => {
    await runCli(["workstream", "init", "demo"], lap);
    await seedTask(lap, "t1");

    // The devserver has never heard of this workstream. One `mu sync`.
    const { stdout, exitCode } = await runCli(["sync"], dev);
    expect(exitCode).toBeNull();
    expect(stdout).toMatch(/ingested \d+ from 1 peer/);

    const listed = await runCli(["task", "list", "-w", "demo", "--json"], dev);
    const parsed = JSON.parse(listed.stdout) as { items: Array<{ name: string }> };
    expect(parsed.items.map((t) => t.name)).toEqual(["t1"]);
  });

  it("converges after both machines edit DIFFERENT fields of one task", async () => {
    await runCli(["workstream", "init", "demo"], lap);
    await seedTask(lap, "t1");
    // ONE shared creation op: the devserver receives t1 rather than
    // inventing its own (see test/segments.test.ts § establishShared).
    await runCli(["sync"], dev);

    // Diverge, with no coordination.
    await runCli(["task", "update", "t1", "--impact", "95", "-w", "demo"], lap);
    await runCli(["task", "close", "t1", "-w", "demo"], dev);

    await runCli(["sync"], lap);
    await runCli(["sync"], dev);

    for (const db of [lap, dev]) {
      const { task } = await taskJson(db, "t1");
      expect(task.impact).toBe(95);
      expect(task.status).toBe("CLOSED");
    }
  });

  // ─── the no-hands claim ────────────────────────────────────────────

  it("a bare `mu task list` ALSO ingests — no sync verb needed", async () => {
    await runCli(["workstream", "init", "demo"], lap);
    await seedTask(lap, "t1");

    // Never runs `mu sync`. The ambient hook is the whole feature.
    const { stdout } = await runCli(["task", "list", "-w", "demo", "--json"], dev);
    const parsed = JSON.parse(stdout) as { items: Array<{ name: string }> };
    expect(parsed.items.map((t) => t.name)).toEqual(["t1"]);
  });

  it("flushes AFTER the verb body, so one invocation publishes its own work", async () => {
    // If flush ran BEFORE the body, `mu task add` would publish nothing
    // until the next invocation — which is the no-hands claim, broken.
    await runCli(["workstream", "init", "demo"], lap);
    await seedTask(lap, "brand-new");
    const { stdout } = await runCli(["task", "list", "-w", "demo", "--json"], dev);
    expect(stdout).toContain("brand-new");
  });

  // ─── implicit peer discovery ───────────────────────────────────────

  it("a THIRD machine appears as a peer with no configuration", async () => {
    await runCli(["workstream", "init", "demo"], lap);
    await seedTask(lap, "t1");
    await runCli(["sync"], dev);
    const third = join(tempDir, "third.db");
    await runCli(["sync"], third);

    // From the laptop's point of view there are now two peers, and it
    // configured nothing to learn that.
    const { stdout } = await runCli(["sync", "--json"], lap);
    const parsed = JSON.parse(stdout) as { peers: Array<{ machineId: string }> };
    expect(parsed.peers).toHaveLength(2);
  });

  it("transitive convergence: two machines that never meet, via a shared folder", async () => {
    await runCli(["workstream", "init", "demo"], lap);
    await seedTask(lap, "relayed");
    // The devserver ingests the laptop's segment...
    await runCli(["sync"], dev);
    // ...and a third machine reads BOTH segments out of the same folder.
    const third = join(tempDir, "third.db");
    const { stdout } = await runCli(["task", "list", "-w", "demo", "--json"], third);
    expect(stdout).toContain("relayed");
  });

  // ─── MU_SYNC_DIR unset ────────────────────────────────────────────

  describe("MU_SYNC_DIR unset", () => {
    it("touches no file and costs nothing", async () => {
      delete process.env[SYNC_DIR_KEY];
      await runCli(["workstream", "init", "demo"], lap);
      await seedTask(lap, "t1");
      expect(readdirSync(dir)).toEqual([]);
    });

    it("`mu sync` says sync is off and tells you how to turn it on", async () => {
      delete process.env[SYNC_DIR_KEY];
      const { stdout, exitCode } = await runCli(["sync"], lap);
      expect(exitCode).toBeNull();
      expect(stdout).toContain("sync is off");
      expect(stdout).toContain("MU_SYNC_DIR");
    });

    it("--json reports enabled:false rather than erroring", async () => {
      delete process.env[SYNC_DIR_KEY];
      const { stdout } = await runCli(["sync", "--json"], lap);
      const parsed = JSON.parse(stdout) as { enabled: boolean; peers: unknown[] };
      expect(parsed.enabled).toBe(false);
      expect(parsed.peers).toEqual([]);
    });

    it("an unrelated verb still works normally", async () => {
      delete process.env[SYNC_DIR_KEY];
      const { exitCode } = await runCli(["workstream", "init", "demo"], lap);
      expect(exitCode).toBeNull();
    });
  });

  // ─── `mu sql` does NOT ingest ─────────────────────────────────────

  it("`mu sql` does NOT ingest (its no-mutation guarantee is load-bearing)", async () => {
    await runCli(["workstream", "init", "demo"], lap);
    await seedTask(lap, "t1");
    // Give the devserver a DB with a machine identity but nothing else.
    delete process.env[SYNC_DIR_KEY];
    await runCli(["workstream", "init", "other"], dev);
    process.env[SYNC_DIR_KEY] = dir;

    const before = await opCount(dev);
    // Several `mu sql` invocations, with a real peer segment sitting
    // right there waiting to be ingested.
    await runCli(["sql", "SELECT COUNT(*) AS n FROM tasks"], dev);
    await runCli(["sql", "SELECT COUNT(*) AS n FROM workstreams"], dev);
    expect(await opCount(dev)).toBe(before);

    // ...and any other verb DOES ingest, proving the carve-out is
    // specific to `mu sql` rather than sync being broken.
    await runCli(["task", "list", "-w", "demo"], dev);
    expect(await opCount(dev)).toBeGreaterThan(before);
  });

  // ─── never fail an unrelated command ──────────────────────────────

  it("a corrupt segment does not fail an unrelated command", async () => {
    await runCli(["workstream", "init", "demo"], lap);
    await seedTask(lap, "t1");
    // Truncate the laptop's segment mid-line: the dominant real failure
    // mode (a transfer caught in flight).
    const segment = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    if (segment === undefined) throw new Error("expected a segment");
    const path = join(dir, segment);
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.slice(0, Math.floor(raw.length * 0.6)), "utf8");

    // An entirely unrelated command on the OTHER machine must still work.
    const { stdout, stderr, exitCode } = await runCli(["workstream", "init", "mine"], dev);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("Created workstream");
    // The problem is REPORTED, on stderr, without failing anything.
    expect(stderr).toContain("mu: sync:");
    expect(stderr).toContain("--repair");
  });

  it("a segment full of garbage does not fail an unrelated command", async () => {
    writeFileSync(join(dir, "99999999-9999-4999-8999-999999999999.jsonl"), "}}}not json\n");
    const { exitCode } = await runCli(["workstream", "init", "demo"], dev);
    expect(exitCode).toBeNull();
  });

  it("an unreadable sync dir does not fail a command", async () => {
    // A FILE where a directory should be: the shape a botched mount or a
    // typo'd env var actually takes.
    const bogus = join(tempDir, "not-a-dir");
    writeFileSync(bogus, "nope", "utf8");
    process.env[SYNC_DIR_KEY] = bogus;
    const { exitCode } = await runCli(["workstream", "init", "demo"], lap);
    expect(exitCode).toBeNull();
  });

  // ─── --repair ─────────────────────────────────────────────────────

  describe("--repair <peer>", () => {
    it("re-reads a peer's segment from zero and converges", async () => {
      await runCli(["workstream", "init", "demo"], lap);
      await seedTask(lap, "t1");
      await seedTask(lap, "t2");
      const first = await runCli(["sync", "--json"], dev);
      const parsedFirst = JSON.parse(first.stdout) as {
        peers: Array<{ short: string; watermark: number }>;
      };
      const peer = parsedFirst.peers[0];
      if (peer === undefined) throw new Error("expected one peer");
      expect(peer.watermark).toBeGreaterThan(0);

      const opsBefore = await opCount(dev);
      const { stdout, exitCode } = await runCli(["sync", "--repair", peer.short, "--json"], dev);
      expect(exitCode).toBeNull();
      const parsed = JSON.parse(stdout) as {
        repaired: string;
        ingested: Array<{ applied: number }>;
        peers: Array<{ watermark: number; behind: number }>;
      };
      expect(parsed.repaired).toContain(peer.short);
      // Everything was re-read...
      expect(parsed.ingested[0]?.applied).toBeGreaterThan(0);
      // ...and yet nothing was duplicated: idempotent via
      // UNIQUE (machine_id, hlc).
      expect(await opCount(dev)).toBe(opsBefore);
      expect(parsed.peers[0]?.behind).toBe(0);
      const listed = await runCli(["task", "list", "-w", "demo", "--json"], dev);
      const tasks = JSON.parse(listed.stdout) as { items: Array<{ name: string }> };
      expect(tasks.items.map((t) => t.name).sort()).toEqual(["t1", "t2"]);
    });

    it("accepts a unique prefix", async () => {
      await runCli(["workstream", "init", "demo"], lap);
      await runCli(["sync"], dev);
      const { stdout } = await runCli(["sync", "--json"], dev);
      const peer = (JSON.parse(stdout) as { peers: Array<{ short: string }> }).peers[0];
      if (peer === undefined) throw new Error("expected one peer");
      const { exitCode } = await runCli(["sync", "--repair", peer.short.slice(0, 4)], dev);
      expect(exitCode).toBeNull();
    });

    it("exits 3 (not found) for a peer that does not exist", async () => {
      const { stderr, exitCode } = await runCli(["sync", "--repair", "nope"], lap);
      expect(exitCode).toBe(3);
      expect(stderr).toContain("no peer matches");
    });
  });

  // ─── --from <peer.db> ─────────────────────────────────────────────

  describe("--from <path>", () => {
    it("ingests from a peer's mu.db file", async () => {
      await runCli(["workstream", "init", "demo"], lap);
      await seedTask(lap, "t1", 70);
      // No shared folder involved at all: sync is off on the devserver,
      // which only has a copy of the laptop's DB.
      delete process.env[SYNC_DIR_KEY];

      const { stdout, exitCode } = await runCli(["sync", "--from", lap], dev);
      expect(exitCode).toBeNull();
      expect(stdout).toMatch(/read \d+ ops from/);

      const { task } = await taskJson(dev, "t1");
      expect(task.impact).toBe(70);
    });

    it("--json reports the counts", async () => {
      await runCli(["workstream", "init", "demo"], lap);
      await seedTask(lap, "t1");
      const { stdout } = await runCli(["sync", "--from", lap, "--json"], dev);
      const parsed = JSON.parse(stdout) as { read: number; changed: number; from: string };
      expect(parsed.read).toBeGreaterThan(0);
      expect(parsed.changed).toBeGreaterThan(0);
      expect(parsed.from).toBe(lap);
    });

    it("exits 3 for a path that does not exist", async () => {
      const { stderr, exitCode } = await runCli(["sync", "--from", join(tempDir, "nope.db")], dev);
      expect(exitCode).toBe(3);
      expect(stderr).toContain("no such file");
    });

    it("does not modify the source DB", async () => {
      await runCli(["workstream", "init", "demo"], lap);
      await seedTask(lap, "t1");
      delete process.env[SYNC_DIR_KEY];
      const before = await opCount(lap);
      await runCli(["workstream", "init", "devlocal"], dev);
      await runCli(["sync", "--from", lap], dev);
      expect(await opCount(lap)).toBe(before);
    });
  });

  // ─── the report itself ────────────────────────────────────────────

  describe("the peer report", () => {
    it("prints a copy-pasteable rsync NextStep for a stale peer", async () => {
      await runCli(["workstream", "init", "demo"], lap);
      await seedTask(lap, "t1");
      // Backdate the laptop's segment past the staleness threshold.
      const segment = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
      const { utimesSync } = await import("node:fs");
      const old = (Date.now() - 5 * 24 * 60 * 60 * 1000) / 1000;
      for (const name of segment) utimesSync(join(dir, name), old, old);

      const { stdout } = await runCli(["sync"], dev);
      expect(stdout).toContain("stale");
      expect(stdout).toContain("Next:");
      expect(stdout).toContain("rsync");
      expect(stdout).toContain(dir);
    });

    it("never shells out to ssh/scp/rsync — the operator owns transport", async () => {
      // The pledge as an assertion: rsync appears only as PRINTED text.
      // If mu had run it, the segment would have been fetched from a
      // host that does not exist and the command would have failed.
      await runCli(["workstream", "init", "demo"], lap);
      const { exitCode } = await runCli(["sync"], dev);
      expect(exitCode).toBeNull();
    });

    it("emits a Next: block and valid --json on the ordinary path", async () => {
      await runCli(["workstream", "init", "demo"], lap);
      const human = await runCli(["sync"], dev);
      expect(human.stdout).toContain("Next:");
      const { stdout } = await runCli(["sync", "--json"], dev);
      const parsed = JSON.parse(stdout) as {
        syncDir: string;
        enabled: boolean;
        flushed: number;
        peers: unknown[];
        nextSteps: Array<{ intent: string; command: string }>;
      };
      expect(parsed.syncDir).toBe(dir);
      expect(parsed.enabled).toBe(true);
      expect(Array.isArray(parsed.peers)).toBe(true);
      expect(parsed.nextSteps.length).toBeGreaterThan(0);
    });

    it("reports zero peers honestly rather than pretending", async () => {
      const { stdout } = await runCli(["sync"], lap);
      expect(stdout).toContain("no peers yet");
    });
  });

  // ─── doctor wiring ────────────────────────────────────────────────

  describe("mu doctor", () => {
    it("FAILS when MU_DB_PATH is inside MU_SYNC_DIR — THE footgun", async () => {
      const inside = join(dir, "mu.db");
      const { stdout } = await runCli(["doctor"], inside);
      expect(stdout).toContain("db-vs-sync");
      expect(stdout).toContain("INSIDE MU_SYNC_DIR");
    });

    it("is ok when the DB is outside the sync dir", async () => {
      const { stdout } = await runCli(["doctor"], lap);
      expect(stdout).toContain("db-vs-sync");
      expect(stdout).toContain("outside the sync dir");
    });

    it("reports no drift after a real two-machine exchange", async () => {
      await runCli(["workstream", "init", "demo"], lap);
      await seedTask(lap, "t1");
      await runCli(["sync"], dev);
      await runCli(["task", "close", "t1", "-w", "demo"], dev);
      await runCli(["sync"], lap);

      for (const db of [lap, dev]) {
        const { stdout, exitCode } = await runCli(["doctor", "--deep"], db);
        expect(exitCode, stdout).toBeNull();
        expect(stdout).toMatch(/drift\s+:\s+.*ok/);
      }
    });
  });
});
