// CLI-level tests for `mu task reparent --blocked-by`.
//
// Mirrors test/cli-task-add-blocked-by.test.ts but for the
// reparent verb. Both forms (CSV and repeated-flag, as codified by
// cli_audit_plurality_uniformity in v0.3) must work end-to-end.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getTaskEdges } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task reparent --blocked-by", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-reparent-blocked-by-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
    // Seed: a, b, c, d (potential blockers) + target (will be reparented).
    for (const id of ["a", "b", "c", "d"]) {
      await runCli(
        ["task", "add", id, "-w", "test", "-t", id.toUpperCase(), "-i", "50", "-e", "1"],
        dbPath,
      );
    }
    await runCli(
      ["task", "add", "target", "-w", "test", "-t", "Target", "-i", "70", "-e", "3"],
      dbPath,
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("CSV form (existing): --blocked-by a,b,c", async () => {
    const r = await runCli(
      ["task", "reparent", "target", "-w", "test", "--blocked-by", "a,b,c"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "target", "test");
    db.close();
    expect(edges.blockers.sort()).toEqual(["a", "b", "c"]);
  });

  it("repeated-flag form: --blocked-by a --blocked-by b --blocked-by c", async () => {
    const r = await runCli(
      [
        "task",
        "reparent",
        "target",
        "-w",
        "test",
        "--blocked-by",
        "a",
        "--blocked-by",
        "b",
        "--blocked-by",
        "c",
      ],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "target", "test");
    db.close();
    expect(edges.blockers.sort()).toEqual(["a", "b", "c"]);
  });

  it("mixed form: --blocked-by a,b --blocked-by c,d", async () => {
    const r = await runCli(
      ["task", "reparent", "target", "-w", "test", "--blocked-by", "a,b", "--blocked-by", "c,d"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "target", "test");
    db.close();
    expect(edges.blockers.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("empty string clears all blockers", async () => {
    // Seed with two blockers first.
    await runCli(["task", "reparent", "target", "-w", "test", "--blocked-by", "a,b"], dbPath);
    // Clear.
    const r = await runCli(
      ["task", "reparent", "target", "-w", "test", "--blocked-by", ""],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    const db = openDb({ path: dbPath });
    const edges = getTaskEdges(db, "target", "test");
    db.close();
    expect(edges.blockers).toEqual([]);
  });
});
