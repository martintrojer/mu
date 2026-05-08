// CLI-level tests for the `mu task add --blocked-by` flag (and the
// deprecated `--blocks` alias).
//
// Surfaced by nit_blocks_flag_naming on the roadmap-v0-2 workstream:
// the original `-b/--blocks <ids>` flag on `mu task add` reads as
// "this task BLOCKS those" but actually means "this task is BLOCKED BY
// those" — a recurring footgun. The fix:
//
//   1. Add a clearer `--blocked-by <ids>` option that means the same
//      thing as `--blocks` (which is now a deprecated alias).
//   2. If both are passed with different values, error with a typed
//      UsageError so the user knows to pick one. Identical values are
//      tolerated (the same string snuck in via shell aliasing etc.).
//
// We drive the program directly via buildProgram() + parseAsync() with
// stdout captured (same pattern as test/json-output.test.ts) so we
// exercise the real Commander wiring without spawning subprocesses.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli.js";
import { type Db, openDb } from "../src/db.js";
import { getTaskEdges } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";

interface Capture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCli(argv: readonly string[], dbPath: string): Promise<Capture> {
  const originalDbPath = process.env.MU_DB_PATH;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  const originalLog = console.log;
  const originalErrLog = console.error;
  const originalExit = process.exit;

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  process.env.MU_DB_PATH = dbPath;
  // biome-ignore lint/suspicious/noExplicitAny: shim
  console.log = (...args: any[]) => {
    stdout += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };
  // biome-ignore lint/suspicious/noExplicitAny: shim
  console.error = (...args: any[]) => {
    stderr += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };
  // biome-ignore lint/suspicious/noExplicitAny: shim
  (process.stdout as any).write = (chunk: any) => {
    stdout += String(chunk);
    return true;
  };
  // biome-ignore lint/suspicious/noExplicitAny: shim
  (process.stderr as any).write = (chunk: any) => {
    stderr += String(chunk);
    return true;
  };
  // The CLI's handle() wrapper calls process.exit(N) on typed errors;
  // intercept it so the test process keeps running.
  // biome-ignore lint/suspicious/noExplicitAny: shim
  (process as any).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__:${exitCode}`);
  };

  try {
    const program = buildProgram();
    program.exitOverride();
    await program.parseAsync(["node", "mu", ...argv]);
  } catch {
    // exitOverride throws on parse errors; our exit shim throws on typed
    // errors. Either way we want to return what was captured.
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    console.log = originalLog;
    console.error = originalErrLog;
    process.exit = originalExit;
    if (originalDbPath === undefined) {
      const key = "MU_DB_PATH";
      delete process.env[key];
    } else {
      process.env.MU_DB_PATH = originalDbPath;
    }
  }

  return { stdout, stderr, exitCode };
}

describe("mu task add --blocked-by (and deprecated --blocks alias)", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-blocked-by-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("--blocks (deprecated alias) inserts incoming edges (back-compat)", async () => {
    await runCli(
      ["task", "add", "design", "-w", "test", "-t", "Design", "-i", "80", "-e", "2"],
      dbPath,
    );
    await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocks",
        "design",
      ],
      dbPath,
    );
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build");
    db.close();
    expect(edges.blockers).toEqual(["design"]);
  });

  it("--blocked-by inserts the same incoming edges as --blocks", async () => {
    await runCli(
      ["task", "add", "design", "-w", "test", "-t", "Design", "-i", "80", "-e", "2"],
      dbPath,
    );
    await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocked-by",
        "design",
      ],
      dbPath,
    );
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build");
    db.close();
    expect(edges.blockers).toEqual(["design"]);
  });

  it("--blocked-by accepts comma-separated lists same as --blocks", async () => {
    for (const id of ["a", "b", "c"]) {
      await runCli(
        ["task", "add", id, "-w", "test", "-t", id.toUpperCase(), "-i", "50", "-e", "1"],
        dbPath,
      );
    }
    await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocked-by",
        "a,b,c",
      ],
      dbPath,
    );
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build");
    db.close();
    expect(edges.blockers.sort()).toEqual(["a", "b", "c"]);
  });

  it("--blocked-by + --blocks with the SAME value is tolerated (idempotent)", async () => {
    await runCli(
      ["task", "add", "design", "-w", "test", "-t", "Design", "-i", "80", "-e", "2"],
      dbPath,
    );
    const { stderr, exitCode } = await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocks",
        "design",
        "--blocked-by",
        "design",
      ],
      dbPath,
    );
    expect(exitCode).toBeNull();
    expect(stderr).toBe("");
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build");
    db.close();
    expect(edges.blockers).toEqual(["design"]);
  });

  it("--blocked-by + --blocks with DIFFERENT values is a UsageError", async () => {
    await runCli(
      ["task", "add", "design", "-w", "test", "-t", "Design", "-i", "80", "-e", "2"],
      dbPath,
    );
    await runCli(
      ["task", "add", "review", "-w", "test", "-t", "Review", "-i", "60", "-e", "1"],
      dbPath,
    );
    const { stderr, exitCode } = await runCli(
      [
        "task",
        "add",
        "build",
        "-w",
        "test",
        "-t",
        "Build",
        "-i",
        "70",
        "-e",
        "3",
        "--blocks",
        "design",
        "--blocked-by",
        "review",
      ],
      dbPath,
    );
    expect(exitCode).not.toBeNull();
    expect(stderr).toMatch(/--blocked-by.*--blocks/);
    // Task should NOT have been created.
    const db = openDb({ path: dbPath });
    const row = db.prepare("SELECT 1 FROM tasks WHERE local_id = 'build'").get();
    db.close();
    expect(row).toBeUndefined();
  });
});
