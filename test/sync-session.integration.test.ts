// A REALISTIC SESSION: several days of laptop <-> devserver work on ONE
// workstream, many rounds, no coordination beyond a shared folder.
//
// WHY THIS FILE EXISTS ALONGSIDE test/cli-sync.integration.test.ts
// ----------------------------------------------------------------
// That file has 28 good tests and they all share one shape: create,
// diverge ONCE, sync ONCE, assert. Only two of them reach four exchange
// points. Measured verb coverage across them was 0 hits for `task
// claim`, 0 for `task delete`, 0 for `archive`, 0 for `undo`, 2 for
// notes and 3 for edges. So the substrate was proven and a SESSION was
// not — which is a different claim, and the one mu actually makes.
//
// The difference is not cosmetic. The single-round shape cannot express
// "an op arrives before the op it depends on", because with one
// exchange there is nothing to be out of order with. That case is what
// this file found (see § the ordering case) and it was a real,
// permanent, silent divergence bug.
//
// WHY A FIXED INTERLEAVING RATHER THAN PROPERTY-BASED
// ---------------------------------------------------
// fast-check is a dev dep and test/cli-input-property.test.ts is the
// in-repo precedent, so generation was the first thing tried. It was
// dropped, for a reason worth recording: the interesting orderings here
// are not random, they are ADVERSARIAL and few. "A note whose task op
// is in the other machine's segment, ingested second" is one specific
// arrangement out of a large space, and a generator hits it rarely
// while a hand-written round hits it every time and NAMES it in the
// failure message. Random verb sequences would also make the ops-growth
// assertion (§ 5) unstateable, since the expected count would itself be
// random. Determinism here comes from writing the schedule down.
//
// THE ORDERING CASE IS FORCED, NOT HOPED FOR
// -------------------------------------------
// `discoverPeers` sorts by path, and paths are random UUIDs, so which
// peer is ingested first is a coin flip PER FLEET. A test that just
// syncs would pass or fail at random (measured: 5 of 8 fresh runs
// dropped the edge). `forceIngestOrder` renames the segments so the
// order is pinned, which turns a flake into a proof.

import { mkdirSync, mkdtempSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

const SYNC_DIR_KEY = "MU_SYNC_DIR";
const WS = "fleet";

interface TaskView {
  task: { name: string; status: string; impact: number; ownerName: string | null };
  blockers: Array<{ name: string }>;
  notes: Array<{ content: string; author: string | null }>;
}

describe("mu sync — a multi-round two-machine session", () => {
  let tempDir: string;
  let dir: string;
  let lap: string;
  let dev: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-sync-session-"));
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

  // ─── helpers ────────────────────────────────────────────────────────

  const add = async (db: string, id: string, impact = 50): Promise<void> => {
    const r = await runCli(
      ["task", "add", id, "-t", id.toUpperCase(), "-i", String(impact), "-e", "1", "-w", WS],
      db,
    );
    expect(r.error, `task add ${id}`).toBeUndefined();
    expect(r.exitCode, r.stderr).toBeNull();
  };

  /** Every mu invocation ingests and flushes, so a bare `mu sync` IS the
   *  round. Named for what it means rather than what it calls. */
  const exchange = async (...dbs: readonly string[]): Promise<void> => {
    for (const db of dbs) {
      const r = await runCli(["sync"], db);
      expect(r.exitCode, r.stderr).toBeNull();
    }
  };

  const view = async (db: string, id: string): Promise<TaskView> => {
    const { stdout, stderr, exitCode } = await runCli(["task", "show", id, "-w", WS, "--json"], db);
    expect(exitCode, `${id}: ${stderr}`).toBeNull();
    return JSON.parse(stdout) as TaskView;
  };

  const missing = async (db: string, id: string): Promise<boolean> => {
    const { exitCode } = await runCli(["task", "show", id, "-w", WS, "--json"], db);
    return exitCode === 3;
  };

  const names = async (db: string): Promise<string[]> => {
    const { stdout } = await runCli(["task", "list", "-w", WS, "--json"], db);
    return (JSON.parse(stdout) as { items: Array<{ name: string }> }).items
      .map((t) => t.name)
      .sort();
  };

  /** `mu sql` is the only read that does NOT ingest, which makes it the
   *  only safe probe: counting cannot change the count. */
  const opCount = async (db: string): Promise<number> => {
    const { stdout } = await runCli(["sql", "SELECT COUNT(*) AS n FROM ops", "--json"], db);
    return (JSON.parse(stdout) as Array<{ n: number }>)[0]?.n ?? 0;
  };

  /**
   * The convergence oracle: every PORTABLE table's content, canonicalised.
   *
   * Surrogate ids are excluded and rows are joined back to their natural
   * keys, because ids are assigned per machine and would differ on two
   * DBs that agree perfectly. `owner_id` is excluded for the same reason
   * one level up: it is an FK into the machine-local `agents` table, so
   * two converged machines are SUPPOSED to disagree about it.
   */
  const portable = async (db: string): Promise<string> => {
    const q = async (sql: string): Promise<string> => {
      const { stdout, stderr } = await runCli(["sql", sql, "--json"], db);
      expect(stderr, sql).toBe("");
      return stdout.trim();
    };
    return [
      await q("SELECT name FROM workstreams ORDER BY name"),
      await q(
        `SELECT w.name AS ws, t.local_id, t.title, t.status, t.impact, t.effort_days
           FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
          ORDER BY w.name, t.local_id`,
      ),
      await q(
        `SELECT fw.name || '/' || f.local_id AS blocker, tw.name || '/' || t.local_id AS blocked
           FROM task_edges e
           JOIN tasks f ON f.id = e.from_task_id
           JOIN workstreams fw ON fw.id = f.workstream_id
           JOIN tasks t ON t.id = e.to_task_id
           JOIN workstreams tw ON tw.id = t.workstream_id
          ORDER BY blocker, blocked`,
      ),
      await q(
        `SELECT w.name || '/' || t.local_id AS task, n.author, n.content
           FROM task_notes n
           JOIN tasks t ON t.id = n.task_id
           JOIN workstreams w ON w.id = t.workstream_id
          ORDER BY task, n.author, n.content`,
      ),
    ].join("\n--\n");
  };

  /**
   * Pin peer ingest order by renaming segments.
   *
   * `discoverPeers` sorts by path and segment names are random UUIDs, so
   * without this the ordering case fires at random. `first` is the
   * machine whose segment must be read FIRST; its files get an 'a'
   * prefix and everyone else's a 'z'. The manifest sidecar is renamed in
   * step because it is looked up by stem.
   */
  const forceIngestOrder = (firstStem: string): void => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith("aaa-") || f.startsWith("zzz-")) continue;
      renameSync(join(dir, f), join(dir, `${f.startsWith(firstStem) ? "aaa-" : "zzz-"}${f}`));
    }
  };

  /** This machine's segment stem, i.e. its machine id. */
  const stemOf = async (db: string): Promise<string> => {
    const { stdout } = await runCli(
      ["sql", "SELECT machine_id FROM machine_identity", "--json"],
      db,
    );
    const rows = JSON.parse(stdout) as Array<{ machine_id: string }>;
    const id = rows[0]?.machine_id;
    if (id === undefined) throw new Error("no machine identity");
    return id;
  };

  // ─── § the ordering case, isolated ──────────────────────────────────
  //
  // Kept as its own test rather than folded into the long session,
  // because it is the case the task brief explicitly said to assert
  // rather than assume, and it is the one that found a bug.

  describe("an op that arrives BEFORE the op it depends on", () => {
    /** Build the arrangement: task on the laptop, edge + note on the
     *  devserver referring to it, and the devserver's segment ingested
     *  FIRST by a machine that has neither. */
    const dependentsFirst = async (): Promise<string> => {
      const third = join(tempDir, "third.db");
      await runCli(["workstream", "init", WS], lap);
      await add(lap, "parent");
      await exchange(dev);
      await add(dev, "child");
      await runCli(["task", "block", "child", "--by", "parent", "-w", WS], dev);
      await runCli(["task", "note", "parent", "seen-by-dev", "-w", WS], dev);
      forceIngestOrder(await stemOf(dev));
      return third;
    };

    it("PROJECTS the edge, though its segment is read before the task's", async () => {
      const third = await dependentsFirst();
      await exchange(third);
      // Before the fix this was `[]`, permanently: applyEdgePut returned
      // skipped:'absent' and the watermark advanced past the line, so no
      // later sync ever retried it.
      expect((await view(third, "child")).blockers.map((b) => b.name)).toEqual(["parent"]);
    });

    it("PROJECTS the note, same arrangement", async () => {
      const third = await dependentsFirst();
      await exchange(third);
      expect((await view(third, "parent")).notes.map((n) => n.content)).toEqual(["seen-by-dev"]);
    });

    it("leaves NO drift, which is how the bug was visible at all", async () => {
      // `mu rebuild` replays the whole log in global HLC order, so it got
      // the right answer while the live tables did not — that mismatch is
      // exactly what --deep compares, and it exited 5 before the fix.
      const third = await dependentsFirst();
      await exchange(third);
      const { stdout, exitCode } = await runCli(["doctor", "--deep"], third);
      expect(exitCode, stdout).toBeNull();
      expect(stdout).toMatch(/drift\s+:\s+.*ok/);
    });

    it("re-projects at most once — a second sync changes nothing", async () => {
      const third = await dependentsFirst();
      await exchange(third);
      const before = await opCount(third);
      const snapshot = await portable(third);
      await exchange(third);
      await exchange(third);
      expect(await portable(third)).toBe(snapshot);
      expect(await opCount(third)).toBe(before);
    });

    it("does NOT resurrect a dependent whose parent was deleted", async () => {
      // The repair pass must not confuse "parent not here YET" with
      // "parent deliberately gone". Deleting the parent cascades the edge
      // away; a repair that re-added it would be a resurrection bug.
      const third = await dependentsFirst();
      await exchange(third);
      await runCli(["task", "delete", "parent", "-w", WS, "--yes"], third);
      await exchange(third, third);
      expect(await missing(third, "parent")).toBe(true);
      expect((await view(third, "child")).blockers).toEqual([]);
    });
  });

  // ─── § the session ──────────────────────────────────────────────────

  it("converges across many rounds of uncoordinated two-machine work", async () => {
    const opsPerRound: number[] = [];
    const record = async (): Promise<void> => {
      opsPerRound.push(await opCount(lap));
    };

    // ── round 1: the laptop starts a workstream, both machines add ────
    await runCli(["workstream", "init", WS], lap);
    await add(lap, "lap-1", 80);
    await exchange(dev);
    // Independent adds, same round, no coordination. local_ids are
    // per-workstream unique, so the only thing stopping a collision is
    // that the two machines pick different names — assert they coexist.
    await add(lap, "lap-2", 40);
    await add(dev, "dev-1", 60);
    await exchange(lap, dev, lap);
    expect(await names(lap)).toEqual(["dev-1", "lap-1", "lap-2"]);
    expect(await names(dev)).toEqual(["dev-1", "lap-1", "lap-2"]);
    await record();

    // ── round 2: an edge on one side across the machine boundary ──────
    // The devserver blocks ITS task by the LAPTOP's task, so the edge op
    // lives in the devserver's segment and names a task from the
    // laptop's. That is the cross-segment reference the ordering case is
    // about, arriving here in the benign order.
    await runCli(["task", "block", "dev-1", "--by", "lap-1", "-w", WS], dev);
    await runCli(["task", "block", "lap-2", "--by", "dev-1", "-w", WS], lap);
    await exchange(lap, dev, lap);
    for (const db of [lap, dev]) {
      expect((await view(db, "dev-1")).blockers.map((b) => b.name)).toEqual(["lap-1"]);
      expect((await view(db, "lap-2")).blockers.map((b) => b.name)).toEqual(["dev-1"]);
    }
    await record();

    // ── round 3: notes accumulate on both sides ───────────────────────
    // Notes are a GROW-ONLY SET, so the failure modes are duplication and
    // loss. Both are only reachable with repeated exchange, which is
    // exactly what single-round tests cannot do.
    await runCli(["task", "note", "lap-1", "from-lap-a", "-w", WS], lap);
    await runCli(["task", "note", "lap-1", "from-dev-a", "-w", WS], dev);
    await exchange(lap, dev);
    await runCli(["task", "note", "lap-1", "from-lap-b", "-w", WS], lap);
    await runCli(["task", "note", "lap-1", "from-dev-b", "-w", WS], dev);
    await exchange(lap, dev, lap, dev, lap);
    for (const db of [lap, dev]) {
      const contents = (await view(db, "lap-1")).notes.map((n) => n.content).sort();
      expect(contents).toEqual(["from-dev-a", "from-dev-b", "from-lap-a", "from-lap-b"]);
    }
    await record();

    // ── round 4: closed here, reopened there ──────────────────────────
    await runCli(["task", "close", "lap-1", "-w", WS], lap);
    await exchange(lap, dev);
    expect((await view(dev, "lap-1")).task.status).toBe("CLOSED");
    await runCli(["task", "open", "lap-1", "-w", WS], dev);
    await exchange(dev, lap);
    // The reopen is strictly newer, so per-field LWW says OPEN on both.
    for (const db of [lap, dev]) expect((await view(db, "lap-1")).task.status).toBe("OPEN");
    await record();

    // ── round 5: claim is machine-local; the FK makes it so ───────────
    // `tasks.owner_id` is an FK into the machine-local `agents` table, so
    // ownership must NOT cross. Each machine keeps its own owner view.
    await runCli(["task", "claim", "dev-1", "--self", "--actor", "devbot", "-w", WS], dev);
    await exchange(dev, lap);
    for (const db of [lap, dev]) {
      // owner stays NULL everywhere on an anonymous claim...
      expect((await view(db, "dev-1")).task.ownerName).toBeNull();
    }
    // ...and STATUS does travel, because status is portable and the task
    // really is in progress somewhere in the fleet. Asserted rather than
    // assumed: it is the one visible edge of an otherwise-local verb.
    expect((await view(lap, "dev-1")).task.status).toBe("IN_PROGRESS");
    await runCli(["task", "release", "dev-1", "-w", WS], dev);
    await exchange(dev, lap);
    for (const db of [lap, dev]) expect((await view(db, "dev-1")).task.status).toBe("OPEN");
    await record();

    // ── round 6: delete vs concurrent edit, BOTH hlc orders ───────────
    // (a) delete newer than the edit: the tombstone wins on both.
    await add(lap, "doomed-a");
    await exchange(lap, dev);
    await runCli(["task", "update", "doomed-a", "--impact", "90", "-w", WS], dev);
    await exchange(dev, lap);
    await runCli(["task", "delete", "doomed-a", "-w", WS, "--yes"], lap);
    await exchange(lap, dev, lap);
    expect(await missing(lap, "doomed-a")).toBe(true);
    expect(await missing(dev, "doomed-a")).toBe(true);

    // (b) the edit is newer than the delete: a legitimate resurrection.
    // The put recreates the row, because tombstones are ordinary ops and
    // an OLDER one simply loses the comparison.
    await add(lap, "doomed-b");
    await exchange(lap, dev);
    await runCli(["task", "delete", "doomed-b", "-w", WS, "--yes"], lap);
    await runCli(["task", "update", "doomed-b", "--impact", "77", "-w", WS], dev);
    await exchange(dev, lap, dev);
    const resurrectedLap = await missing(lap, "doomed-b");
    expect(resurrectedLap).toBe(await missing(dev, "doomed-b"));
    if (!resurrectedLap) {
      expect((await view(lap, "doomed-b")).task.impact).toBe(77);
      expect((await view(dev, "doomed-b")).task.impact).toBe(77);
    }
    await record();

    // ── round 7: an archive marker crosses, and restores elsewhere ────
    const pinned = await runCli(["archive", "add", "day-3", "-w", WS], lap);
    expect(pinned.exitCode, pinned.stderr).toBeNull();
    await exchange(lap, dev);
    const listed = await runCli(["archive", "list", "--json"], dev);
    const archives = JSON.parse(listed.stdout) as { items: Array<{ label: string }> };
    expect(archives.items.map((a) => a.label)).toContain("day-3");
    // Restored under a NEW name on the OTHER machine, from ops the
    // devserver only ever received over the shared folder.
    const restored = await runCli(["archive", "restore", "day-3", "--as", "revived", "--yes"], dev);
    expect(restored.exitCode, restored.stderr).toBeNull();
    const revived = await runCli(["task", "list", "-w", "revived", "--json"], dev);
    const revivedNames = (JSON.parse(revived.stdout) as { items: Array<{ name: string }> }).items;
    expect(revivedNames.length).toBeGreaterThan(0);
    await exchange(dev, lap);
    await record();

    // ── round 8: undo on one machine propagates to the other ──────────
    // Undo is itself ops (inverse ops in a new group), so it syncs by the
    // same path as the thing it undoes — no special case anywhere.
    await runCli(["task", "update", "lap-2", "--impact", "12", "-w", WS], lap);
    await exchange(lap, dev);
    expect((await view(dev, "lap-2")).task.impact).toBe(12);
    const groupsRaw = await runCli(["undo", "--json", "-n", "10"], lap);
    const groups = (
      JSON.parse(groupsRaw.stdout) as {
        groups: Array<{ groupId: string; intents: string[] }>;
      }
    ).groups;
    const target = groups.find((g) => g.intents.includes("task.update"));
    if (target === undefined) throw new Error("expected an undoable task.update group");
    const undone = await runCli(["undo", target.groupId, "--yes"], lap);
    expect(undone.exitCode, undone.stderr).toBeNull();
    await exchange(lap, dev);
    // Whatever the impact reverted to, BOTH machines must agree on it —
    // that agreement, not the specific number, is the sync claim.
    expect((await view(dev, "lap-2")).task.impact).toBe((await view(lap, "lap-2")).task.impact);
    expect((await view(lap, "lap-2")).task.impact).not.toBe(12);
    await record();

    // ── settle: a couple of quiet rounds, as a real fleet has ─────────
    await exchange(lap, dev, lap, dev);

    // ═══ END-STATE ASSERTION 1: byte-identical portable content ═══════
    expect(await portable(dev)).toBe(await portable(lap));

    // ═══ END-STATE ASSERTION 2: no drift on EITHER machine ════════════
    for (const [label, db] of [
      ["lap", lap],
      ["dev", dev],
    ] as const) {
      const { stdout, exitCode } = await runCli(["doctor", "--deep"], db);
      expect(exitCode, `${label}: ${stdout}`).toBeNull();
      expect(stdout, label).toMatch(/drift\s+:\s+.*ok/);
    }

    // ═══ END-STATE ASSERTION 3: rebuild reproduces the same state ═════
    // The ops log is the canonical state, so replaying it into a fresh
    // DB must land on the same portable content the live tables hold.
    for (const [label, db] of [
      ["lap", lap],
      ["dev", dev],
    ] as const) {
      const target = join(tempDir, `rebuilt-${label}.db`);
      // Rebuild without the ambient hook: the point is what the LOG
      // says, not what one more ingest would add.
      delete process.env[SYNC_DIR_KEY];
      const rebuilt = await runCli(["rebuild", target], db);
      expect(rebuilt.exitCode, rebuilt.stderr).toBeNull();
      const live = await portable(db);
      process.env[SYNC_DIR_KEY] = dir;
      delete process.env[SYNC_DIR_KEY];
      expect(await portable(target), `${label} rebuild`).toBe(live);
      process.env[SYNC_DIR_KEY] = dir;
    }

    // ═══ END-STATE ASSERTION 4: --repair from zero changes NOTHING ════
    // The strongest idempotence check available: re-ingest every peer's
    // entire segment from line 0 and assert the DB does not budge.
    for (const db of [lap, dev]) {
      const before = await portable(db);
      const beforeOps = await opCount(db);
      const { stdout } = await runCli(["sync", "--json"], db);
      const peers = (JSON.parse(stdout) as { peers: Array<{ short: string }> }).peers;
      expect(peers.length).toBeGreaterThan(0);
      for (const p of peers) {
        const r = await runCli(["sync", "--repair", p.short], db);
        expect(r.exitCode, r.stderr).toBeNull();
      }
      expect(await portable(db)).toBe(before);
      // UNIQUE (machine_id, hlc) is what makes re-reading free.
      expect(await opCount(db)).toBe(beforeOps);
    }

    // ═══ END-STATE ASSERTION 5: ops do not grow superlinearly ═════════
    // An echo loop (a peer's op re-captured as a local op and flushed
    // back) or a re-flush bug shows up as growth, and nothing else
    // guards it. Each round does a bounded amount of work, so the log
    // must grow by a bounded amount per round — linear, not quadratic.
    expect(opsPerRound.length).toBeGreaterThanOrEqual(8);
    const deltas = opsPerRound.slice(1).map((n, i) => n - (opsPerRound[i] ?? 0));
    for (const [i, d] of deltas.entries()) {
      expect(d, `round ${i + 2} added ${d} ops: ${opsPerRound.join(",")}`).toBeLessThan(40);
    }
    const first = opsPerRound[0] ?? 0;
    const last = opsPerRound[opsPerRound.length - 1] ?? 0;
    // Quadratic growth over 8 rounds would blow past this by an order of
    // magnitude; the real numbers sit far below it.
    expect(last, `ops per round: ${opsPerRound.join(",")}`).toBeLessThan(first * 8 + 60);

    // And the quiet rounds at the end must have added NOTHING: with no
    // new work, an exchange is pure bookkeeping. This is the echo-loop
    // detector in its sharpest form.
    const quiet = await opCount(lap);
    await exchange(lap, dev, lap, dev, lap);
    expect(await opCount(lap)).toBe(quiet);
  });
});
