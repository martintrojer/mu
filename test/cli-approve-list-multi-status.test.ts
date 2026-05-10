// Tests for `--status` (multi-value) on `mu approve list`
// (task_list_multi_status_union, v0.3). Same shape as task list /
// task next: repeat OR comma-separate OR mix; case-insensitive;
// dedup; missing == no filter.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addApproval, denyApproval, grantApproval } from "../src/approvals.js";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu approve list --status (multi-value)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-approve-list-multistatus-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "auth");
    addApproval(db, { slug: "a-pend", workstream: "auth", reason: "p", requestedBy: "u" });
    addApproval(db, { slug: "a-grant", workstream: "auth", reason: "g", requestedBy: "u" });
    addApproval(db, { slug: "a-deny", workstream: "auth", reason: "d", requestedBy: "u" });
    grantApproval(db, "a-grant", { decidedBy: "alice", workstream: "auth" });
    denyApproval(db, "a-deny", { decidedBy: "bob", workstream: "auth" });
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
    return parsed.map((r) => r.name).sort();
  }

  it("single --status pending: back-compat (today's shape)", async () => {
    expect(await names(["approve", "list", "-w", "auth", "--status", "pending", "--json"])).toEqual(
      ["a-pend"],
    );
  });

  it("single --status accepts mixed case (lowercased internally)", async () => {
    expect(await names(["approve", "list", "-w", "auth", "--status", "Pending", "--json"])).toEqual(
      ["a-pend"],
    );
  });

  it("--status missing returns ALL approvals", async () => {
    expect(await names(["approve", "list", "-w", "auth", "--json"])).toEqual([
      "a-deny",
      "a-grant",
      "a-pend",
    ]);
  });

  it("CSV form: --status pending,granted unions both", async () => {
    expect(
      await names(["approve", "list", "-w", "auth", "--status", "pending,granted", "--json"]),
    ).toEqual(["a-grant", "a-pend"]);
  });

  it("repeat form: --status pending --status denied unions both", async () => {
    expect(
      await names([
        "approve",
        "list",
        "-w",
        "auth",
        "--status",
        "pending",
        "--status",
        "denied",
        "--json",
      ]),
    ).toEqual(["a-deny", "a-pend"]);
  });

  it("mixed form unions all three", async () => {
    expect(
      await names([
        "approve",
        "list",
        "-w",
        "auth",
        "--status",
        "pending,granted",
        "--status",
        "denied",
        "--json",
      ]),
    ).toEqual(["a-deny", "a-grant", "a-pend"]);
  });

  it("dedup: --status pending --status PENDING collapses (one filter element)", async () => {
    expect(
      await names([
        "approve",
        "list",
        "-w",
        "auth",
        "--status",
        "pending",
        "--status",
        "PENDING",
        "--json",
      ]),
    ).toEqual(["a-pend"]);
  });

  it("invalid value surfaces a clear error naming the offender", async () => {
    const { stderr, error } = await runCli(
      ["approve", "list", "-w", "auth", "--status", "pending,bogus"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stderr).toMatch(/--status must be one of/);
    expect(stderr).toContain("bogus");
  });
});
