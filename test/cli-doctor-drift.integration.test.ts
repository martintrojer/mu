// CLI-level tests for `mu doctor`'s drift + fleet checks.
//
// Integration tier: drives the whole program through buildProgram(), and
// the --deep path runs a real rebuild.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { withCaptureSuppressed } from "../src/op-context.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

describe("mu doctor — drift + fleet checks", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-doctor-drift-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmFixtureDir(tempDir);
  });

  const seed = async (): Promise<void> => {
    await runCli(["workstream", "init", "demo"], dbPath);
    await runCli(["task", "add", "a", "-t", "A", "-i", "60", "-e", "1", "-w", "demo"], dbPath);
  };

  /** Plant drift the way a capture bug would: suppress capture, mutate. */
  const plant = (sql: string): void => {
    const db = openDb({ path: dbPath });
    try {
      withCaptureSuppressed(db, () => {
        db.prepare(sql).run();
      });
    } finally {
      db.close();
    }
  };

  it("reports clean on a healthy DB and exits 0", async () => {
    await seed();
    const { stdout, exitCode } = await runCli(["doctor"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("fleet");
    expect(stdout).toContain("ops log");
    expect(stdout).toMatch(/drift \(shallow\)/);
    // The default tier must point at the deep one rather than implying
    // it has proved anything.
    expect(stdout).toContain("mu doctor --deep");
  });

  it("--deep reports clean and says what it compared", async () => {
    await seed();
    const { stdout, exitCode } = await runCli(["doctor", "--deep"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toMatch(/rebuild matches live tables/);
    expect(stdout).toMatch(/1 tasks/);
  });

  it("--deep DETECTS a planted uncaptured UPDATE, names it, and exits 5", async () => {
    await seed();
    plant("UPDATE tasks SET impact = 7 WHERE local_id = 'a'");

    const { stdout, stderr, exitCode } = await runCli(["doctor", "--deep"], dbPath);
    const all = stdout + stderr;
    expect(exitCode).toBe(5);
    // Table, key, field AND both values — "drift detected" alone is
    // useless at 3am.
    expect(all).toContain("tasks demo/a.impact");
    expect(all).toContain("live=7");
    expect(all).toContain("log=60");
    // Remediation, and specifically the warning not to rebuild blindly.
    expect(all).toContain("Do not rebuild reflexively");
    expect(all).toContain("mu db backup");
  });

  it("the DEFAULT (shallow) tier detects an uncaptured INSERT and exits 5", async () => {
    await seed();
    const now = new Date().toISOString();
    plant(
      `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days,
                          created_at, updated_at)
       VALUES ((SELECT id FROM workstreams WHERE name = 'demo'), 'ghost', 'G', 'OPEN', 50, 1,
               '${now}', '${now}')`,
    );

    const { stdout, stderr, exitCode } = await runCli(["doctor"], dbPath);
    const all = stdout + stderr;
    expect(exitCode).toBe(5);
    expect(all).toContain("tasks demo/ghost");
    expect(all).toContain("no op names this key");
  });

  it("the shallow tier stays quiet on an uncaptured UPDATE (documented blindness)", async () => {
    await seed();
    plant("UPDATE tasks SET impact = 7 WHERE local_id = 'a'");
    // Default run passes: the key still has ops. This is why --deep
    // exists and is asserted so the tiering cannot silently change.
    expect((await runCli(["doctor"], dbPath)).exitCode).toBeNull();
    expect((await runCli(["doctor", "--deep"], dbPath)).exitCode).toBe(5);
  });

  it("--json emits the drift payload BEFORE failing", async () => {
    await seed();
    plant("UPDATE tasks SET impact = 7 WHERE local_id = 'a'");

    const { stdout, exitCode } = await runCli(["doctor", "--deep", "--json"], dbPath);
    expect(exitCode).toBe(5);
    // A --json consumer needs the machine-readable report even on a
    // non-zero exit, so the payload must be on stdout regardless.
    const parsed = JSON.parse(stdout.trim()) as {
      drift: {
        mode: string;
        ok: boolean;
        totalDrift: number;
        records: Array<Record<string, unknown>>;
      };
      fleet: Array<{ name: string; severity: string }>;
      remediation: string[];
    };
    expect(parsed.drift.mode).toBe("deep");
    expect(parsed.drift.ok).toBe(false);
    expect(parsed.drift.totalDrift).toBe(1);
    expect(parsed.drift.records[0]).toMatchObject({
      table: "tasks",
      key: "demo/a",
      field: "impact",
    });
    expect(parsed.fleet.map((f) => f.name)).toEqual(["db-vs-sync", "db-filesystem", "name-case"]);
    expect(parsed.remediation.length).toBeGreaterThan(0);
  });

  it("--json shallow mode reports its own tier and hint", async () => {
    await seed();
    const { stdout, exitCode } = await runCli(["doctor", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout.trim()) as {
      drift: { mode: string; ok: boolean; hint: string };
    };
    expect(parsed.drift.mode).toBe("shallow");
    expect(parsed.drift.ok).toBe(true);
    expect(parsed.drift.hint).toContain("--deep");
  });

  it("FAILS loudly when MU_DB_PATH is inside MU_SYNC_DIR", async () => {
    await seed();
    const key = "MU_SYNC_DIR";
    const previous = process.env[key];
    process.env[key] = tempDir; // dbPath is inside tempDir
    try {
      const { stdout } = await runCli(["doctor"], dbPath);
      expect(stdout).toContain("db-vs-sync");
      expect(stdout).toContain("INSIDE MU_SYNC_DIR");
      expect(stdout).toContain("WILL corrupt");
      // The explanation must be present, not just the verdict.
      expect(stdout).toContain("-wal");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("warns about case-colliding workstream names", async () => {
    await seed();
    await runCli(
      ["sql", "INSERT INTO workstreams (name, created_at) VALUES ('Demo', datetime('now'))"],
      dbPath,
    );
    const { stdout } = await runCli(["doctor"], dbPath);
    expect(stdout).toContain("name-case");
    expect(stdout).toMatch(/Demo|demo/);
    expect(stdout).toContain("APFS");
  });

  it("--deep appears in doctor --help", async () => {
    const { stdout } = await runCli(["doctor", "--help"], dbPath);
    expect(stdout).toContain("--deep");
  });
});
