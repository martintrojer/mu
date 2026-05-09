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
import { type Db, openDb } from "../src/db.js";
import { getTaskEdges } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

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
    const edges = getTaskEdges(db, "build", "test");
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
    const edges = getTaskEdges(db, "build", "test");
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
    const edges = getTaskEdges(db, "build", "test");
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
    // commander.exitOverride throws on unknown options. Tighten the
    // assertion: must be a non-zero exit (was 'null OR != 0' which
    // also passes when runCli reports success). Stderr must contain
    // BOTH 'unknown option' AND '--blocks' literally (was a regex
    // disjunction that matched a help-line mentioning either word).
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/unknown option.*--blocks/);
    const db = openDb({ path: dbPath });
    const row = db.prepare("SELECT 1 FROM tasks WHERE local_id = 'build'").get();
    db.close();
    expect(row).toBeUndefined();
  });
});
