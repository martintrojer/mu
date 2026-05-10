// Tests for the multi-value `--status` flag on `mu task list`
// (task_list_multi_status_union, v0.3). Per cli_audit_plurality_uniformity:
// repeat OR comma-separate OR mix; result is the UNION of listed
// statuses. Single value is back-compat-identical; missing is no-filter.
//
// Sister files: test/cli-task-next-multi-status.test.ts,
// test/cli-approve-list-multi-status.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task list --status (multi-value)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-task-list-multistatus-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    // Seed one task per status so each filter case has ≥1 hit.
    addTask(db, { localId: "o", workstream: "auth", title: "O", impact: 10, effortDays: 1 });
    addTask(db, { localId: "ip", workstream: "auth", title: "IP", impact: 10, effortDays: 1 });
    addTask(db, { localId: "cl", workstream: "auth", title: "CL", impact: 10, effortDays: 1 });
    addTask(db, { localId: "rj", workstream: "auth", title: "RJ", impact: 10, effortDays: 1 });
    addTask(db, { localId: "df", workstream: "auth", title: "DF", impact: 10, effortDays: 1 });
    db.prepare("UPDATE tasks SET status='IN_PROGRESS' WHERE local_id='ip'").run();
    db.prepare("UPDATE tasks SET status='CLOSED'      WHERE local_id='cl'").run();
    db.prepare("UPDATE tasks SET status='REJECTED'    WHERE local_id='rj'").run();
    db.prepare("UPDATE tasks SET status='DEFERRED'    WHERE local_id='df'").run();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function names(argv: readonly string[]): Promise<string[]> {
    const { stdout, exitCode, error } = await runCli(argv, dbPath);
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout.trim()) as Array<{ name: string }>;
    return parsed.map((t) => t.name).sort();
  }

  it("single --status (back-compat: byte-identical to today's shape)", async () => {
    expect(await names(["task", "list", "-w", "auth", "--status", "OPEN", "--json"])).toEqual([
      "o",
    ]);
  });

  it("single --status accepts lowercase (case-insensitive, today's shape)", async () => {
    expect(await names(["task", "list", "-w", "auth", "--status", "closed", "--json"])).toEqual([
      "cl",
    ]);
  });

  it("--status missing returns ALL tasks (no auto-default to OPEN ∪ IN_PROGRESS)", async () => {
    expect(await names(["task", "list", "-w", "auth", "--json"])).toEqual([
      "cl",
      "df",
      "ip",
      "o",
      "rj",
    ]);
  });

  it("CSV form: --status OPEN,IN_PROGRESS unions both", async () => {
    expect(
      await names(["task", "list", "-w", "auth", "--status", "OPEN,IN_PROGRESS", "--json"]),
    ).toEqual(["ip", "o"]);
  });

  it("repeat form: --status OPEN --status CLOSED unions both", async () => {
    expect(
      await names([
        "task",
        "list",
        "-w",
        "auth",
        "--status",
        "OPEN",
        "--status",
        "CLOSED",
        "--json",
      ]),
    ).toEqual(["cl", "o"]);
  });

  it("mixed form: --status OPEN,CLOSED --status REJECTED unions all three", async () => {
    expect(
      await names([
        "task",
        "list",
        "-w",
        "auth",
        "--status",
        "OPEN,CLOSED",
        "--status",
        "REJECTED",
        "--json",
      ]),
    ).toEqual(["cl", "o", "rj"]);
  });

  it("dedup: --status open --status OPEN collapses to one filter", async () => {
    expect(
      await names(["task", "list", "-w", "auth", "--status", "open", "--status", "OPEN", "--json"]),
    ).toEqual(["o"]);
  });

  it("invalid value in the list surfaces a clear error naming the offender", async () => {
    const { stderr, error } = await runCli(
      ["task", "list", "-w", "auth", "--status", "OPEN,RESOLVED"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stderr).toMatch(/--status must be one of/);
    expect(stderr).toContain("RESOLVED");
  });

  it("'show me everything terminal' (CLOSED ∪ REJECTED ∪ DEFERRED) — the motivating case", async () => {
    expect(
      await names(["task", "list", "-w", "auth", "--status", "CLOSED,REJECTED,DEFERRED", "--json"]),
    ).toEqual(["cl", "df", "rj"]);
  });

  it("'show me everything actionable' (OPEN ∪ IN_PROGRESS) — the motivating case", async () => {
    expect(
      await names(["task", "list", "-w", "auth", "--status", "OPEN,IN_PROGRESS", "--json"]),
    ).toEqual(["ip", "o"]);
  });
});
