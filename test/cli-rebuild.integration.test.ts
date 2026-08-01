// CLI-level tests for `mu rebuild <file>`.
//
// Integration tier because these drive the whole program through
// buildProgram() and write real DB files. The SDK-level merge/tombstone
// behaviour is covered in test/rebuild.test.ts; this file is about the
// verb's contract: --json shape, the Next: block, the swap command, exit
// codes, and that the summary tells the operator what was NOT rebuilt.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmFixtureDir } from "./_fs.js";
import { runCli } from "./_runCli.js";

describe("mu rebuild", () => {
  let tempDir: string;
  let dbPath: string;
  let counter = 0;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-cli-rebuild-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    rmFixtureDir(tempDir);
  });

  const target = (): string => join(tempDir, `rebuilt-${++counter}.db`);

  /** Seed via the real CLI, so the ops replayed are production-shaped. */
  const seed = async (): Promise<void> => {
    await runCli(["workstream", "init", "demo"], dbPath);
    await runCli(["task", "add", "a", "-t", "A", "-i", "60", "-e", "1", "-w", "demo"], dbPath);
    await runCli(["task", "add", "b", "-t", "B", "-i", "40", "-e", "2", "-w", "demo"], dbPath);
    await runCli(["task", "block", "b", "--by", "a", "-w", "demo"], dbPath);
    await runCli(["task", "note", "a", "context", "-w", "demo"], dbPath);
    await runCli(["task", "close", "a", "-w", "demo"], dbPath);
  };

  it("rebuilds and reports the shape, then the rebuilt DB is usable", async () => {
    await seed();
    const out = target();
    const { stdout, stderr, exitCode } = await runCli(["rebuild", out], dbPath);
    expect(stderr).toBe("");
    expect(exitCode).toBeNull();
    expect(existsSync(out)).toBe(true);
    expect(stdout).toContain("Rebuilt");
    expect(stdout).toMatch(/2 tasks/);

    // The rebuilt DB answers real queries — the actual recovery test.
    const listed = await runCli(["task", "list", "-w", "demo", "--json"], out);
    const parsed = JSON.parse(listed.stdout) as { items: Array<{ name: string; status: string }> };
    expect(parsed.items.map((t) => `${t.name}:${t.status}`).sort()).toEqual(["a:CLOSED", "b:OPEN"]);

    // The blocked-by edge survived, so the DAG is intact.
    const tree = await runCli(["task", "tree", "b", "-w", "demo"], out);
    expect(tree.stdout).toContain("a");
  });

  it("prints a Next: block whose FIRST step is the swap command", async () => {
    await seed();
    const out = target();
    const { stdout } = await runCli(["rebuild", out], dbPath);
    expect(stdout).toContain("Next:");
    const next = stdout.slice(stdout.indexOf("Next:"));
    const firstLine = next.split("\n")[1] ?? "";
    expect(firstLine).toContain("mv ");
    expect(firstLine).toContain(out);
  });

  it("--json emits the documented shape including the swap command", async () => {
    await seed();
    const out = target();
    const { stdout, stderr } = await runCli(["rebuild", out, "--json"], dbPath);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as {
      targetPath: string;
      machineId: string;
      opsCopied: number;
      opsProjected: number;
      rebuiltRows: Record<string, number>;
      machineLocalLost: Array<{ table: string; rows: number }>;
      swapCommand: string;
      nextSteps: Array<{ intent: string; command: string }>;
    };
    expect(parsed.targetPath).toBe(out);
    expect(parsed.machineId).toMatch(/^[0-9a-f-]{36}$/);
    // Every op is copied; only the ones naming a portable table are
    // PROJECTED into rows. After v2 R7 retired the duplicate prose
    // emits, a task-only session has no log-only ops at all, so the
    // two counts are legitimately equal — the invariant is that
    // projection never exceeds what was copied.
    expect(parsed.opsCopied).toBeGreaterThanOrEqual(parsed.opsProjected);
    expect(parsed.opsCopied).toBeGreaterThan(0);
    expect(parsed.rebuiltRows).toMatchObject({ workstreams: 1, tasks: 2, task_edges: 1 });
    expect(parsed.machineLocalLost).toEqual([]);
    expect(parsed.swapCommand).toContain(`mv ${out}`);
    expect(parsed.nextSteps[0]?.command).toBe(parsed.swapCommand);
  });

  it("SAYS SO when machine-local rows cannot be rebuilt", async () => {
    await seed();
    // An agent row: real state, but no capture triggers, so no ops.
    await runCli(
      [
        "sql",
        `INSERT INTO agents (workstream_id, name, cli, pane_id, status, created_at, updated_at)
         VALUES ((SELECT id FROM workstreams WHERE name='demo'), 'w1', 'pi', '%17', 'free',
                 datetime('now'), datetime('now'))`,
      ],
      dbPath,
    );

    const out = target();
    const { stdout } = await runCli(["rebuild", out], dbPath);
    // The operator must not miss this.
    expect(stdout).toContain("NOT rebuilt");
    expect(stdout).toMatch(/1 agents/);
    expect(stdout).toContain("no capture triggers");
    expect(stdout).toContain("Re-spawn agents");
    // And the Next: block gains the re-spawn hint.
    expect(stdout).toContain("mu agent spawn");
  });

  it("exits 4 when the target already exists, and --force overrides", async () => {
    await seed();
    const out = target();
    expect((await runCli(["rebuild", out], dbPath)).exitCode).toBeNull();

    const second = await runCli(["rebuild", out], dbPath);
    expect(second.exitCode).toBe(4);
    expect(second.stdout + second.stderr).toContain("already exists");

    const forced = await runCli(["rebuild", out, "--force"], dbPath);
    expect(forced.exitCode).toBeNull();
  });

  it("exits 4 rather than rebuilding onto the live DB", async () => {
    await seed();
    const { stdout, stderr, exitCode } = await runCli(["rebuild", dbPath], dbPath);
    expect(exitCode).toBe(4);
    expect(stdout + stderr).toContain("source DB");
    // The live DB still works.
    const listed = await runCli(["task", "list", "-w", "demo", "--json"], dbPath);
    expect((JSON.parse(listed.stdout) as { count: number }).count).toBe(2);
  });

  it("appears in --help", async () => {
    const { stdout } = await runCli(["--help"], dbPath);
    expect(stdout).toContain("rebuild");
  });
});
