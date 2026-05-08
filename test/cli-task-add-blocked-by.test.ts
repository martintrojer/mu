// CLI-level tests for the `mu task add --blocked-by` flag.
//
// Surfaced by nit_blocks_flag_naming: the original `-b/--blocks <ids>`
// flag read as 'this task BLOCKS those' but actually meant 'this task
// is BLOCKED BY those' — a recurring footgun. We renamed the flag to
// `-b, --blocked-by <ids>` and removed the old name entirely
// (pre-public-release; no compat burden). Same rename applies to
// `mu task reparent --blocked-by`.
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

describe("mu task add --blocked-by", () => {
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

  it("--blocked-by inserts incoming edges", async () => {
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

  it("-b is a short form for --blocked-by", async () => {
    await runCli(
      ["task", "add", "design", "-w", "test", "-t", "Design", "-i", "80", "-e", "2"],
      dbPath,
    );
    await runCli(
      ["task", "add", "build", "-w", "test", "-t", "Build", "-i", "70", "-e", "3", "-b", "design"],
      dbPath,
    );
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "build");
    db.close();
    expect(edges.blockers).toEqual(["design"]);
  });

  it("--blocked-by accepts comma-separated lists", async () => {
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

  it("--blocks (the old name) is rejected by commander as unknown option", async () => {
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
      ],
      dbPath,
    );
    // commander.exitOverride throws on unknown options; runCli swallows.
    // Either way: 'build' must NOT have been created.
    expect(exitCode === null || exitCode !== 0).toBe(true);
    expect(stderr).toMatch(/unknown option|--blocks/);
    const db = openDb({ path: dbPath });
    const row = db.prepare("SELECT 1 FROM tasks WHERE local_id = 'build'").get();
    db.close();
    expect(row).toBeUndefined();
  });
});
