// Tests for `--status` (multi-value) on `mu task next`
// (task_list_multi_status_union, v0.3). `task next` reads the `ready`
// view, which itself constrains to status='OPEN' AND unblocked, so
// `--status` further narrows that set. Default (no flag) keeps the
// historical "all ready" shape (open + unblocked).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task next --status (multi-value)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-task-next-multistatus-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    // Three OPEN unblocked tasks (all three appear in `ready`).
    addTask(db, { localId: "a", workstream: "auth", title: "A", impact: 90, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "auth", title: "B", impact: 50, effortDays: 1 });
    addTask(db, { localId: "c", workstream: "auth", title: "C", impact: 10, effortDays: 1 });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function names(argv: readonly string[]): Promise<string[]> {
    const { stdout, exitCode, error } = await runCli(argv, dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const env = JSON.parse(stdout.trim()) as { items: Array<{ name: string }>; count: number };
    return env.items.map((t) => t.name);
  }

  it("single --status OPEN: back-compat (matches today's no-flag set)", async () => {
    expect(
      await names(["task", "next", "-w", "auth", "-n", "0", "--status", "OPEN", "--json"]),
    ).toEqual(["a", "b", "c"]);
  });

  it("CSV form: --status OPEN,IN_PROGRESS — IN_PROGRESS rows aren't in `ready` so still OPEN-only", async () => {
    expect(
      await names([
        "task",
        "next",
        "-w",
        "auth",
        "-n",
        "0",
        "--status",
        "OPEN,IN_PROGRESS",
        "--json",
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  it("repeat form: dedup --status open --status OPEN collapses (no double-counting)", async () => {
    expect(
      await names([
        "task",
        "next",
        "-w",
        "auth",
        "-n",
        "0",
        "--status",
        "open",
        "--status",
        "OPEN",
        "--json",
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  it("--status CLOSED on a workstream with only OPEN ready tasks returns empty", async () => {
    expect(
      await names(["task", "next", "-w", "auth", "-n", "0", "--status", "CLOSED", "--json"]),
    ).toEqual([]);
  });

  it("invalid value surfaces a clear error naming the offender", async () => {
    const { stderr, error } = await runCli(
      ["task", "next", "-w", "auth", "--status", "OPEN,RESOLVED"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stderr).toMatch(/--status must be one of/);
    expect(stderr).toContain("RESOLVED");
  });
});
