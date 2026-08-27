// Regression tests for finding_optswithglobals_can_pass_root.
//
// The ROOT `-w, --workstream <names...>` flag is VARIADIC. Subcommands
// that call `optsWithGlobals()` (task owned-by, agent wait, agent
// adopt) inherit it, so a root-position invocation
// like `mu -w ws task owned-by agent` previously handed them a
// string[] (e.g. ["ws"]) where a single workstream name was expected.
// That array leaked unchanged through resolveWorkstream into DB calls,
// producing confusing substrate errors instead of documented scoping.
//
// normalizeInheritedWorkstream() now funnels the inherited value into a
// single name. These tests drive the whole CLI pipeline in-process so
// the parse + resolve + dispatch path is covered, asserting that
// root-position `-w` scopes the same as subcommand-position `-w`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, claimTask } from "../src/tasks.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("root-position -w + optsWithGlobals subcommands (finding_optswithglobals_can_pass_root)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-root-w-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "wsa");
    addTask(db, {
      localId: "t1",
      workstream: "wsa",
      title: "Owned by worker",
      impact: 50,
      effortDays: 1,
    });
    insertAgent(db, { name: "worker-1", workstream: "wsa", paneId: "%1", status: "busy" });
    await claimTask(db, "t1", { agentName: "worker-1", workstream: "wsa" });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // The leak triggers whenever the variadic root `-w` stops greedily
  // consuming subcommand tokens — the `--workstream=name` form (one
  // value via `=`), `-w name --json ...` (a following flag breaks the
  // variadic), and `-w name -- ...` all hand the subcommand a string[].
  it("task owned-by: root-position --workstream=ws scopes identically to subcommand-position -w", async () => {
    const rootPos = await runCli(
      ["--workstream=wsa", "task", "owned-by", "worker-1", "--json"],
      dbPath,
    );
    expect(rootPos.error).toBeUndefined();
    expect(rootPos.exitCode).toBeNull();
    const rootParsed = JSON.parse(rootPos.stdout) as { items: { title: string }[] };
    expect(rootParsed.items).toHaveLength(1);
    expect(rootParsed.items[0]?.title).toBe("Owned by worker");

    const subPos = await runCli(["task", "owned-by", "worker-1", "-w", "wsa", "--json"], dbPath);
    expect(subPos.error).toBeUndefined();
    expect(subPos.stdout).toBe(rootPos.stdout);
  });

  it("rejects multiple workstreams at root position for a single-workstream verb", async () => {
    ensureWorkstream(db, "wsb");
    const res = await runCli(
      ["--workstream=wsa,wsb", "task", "owned-by", "worker-1", "--json"],
      dbPath,
    );
    expect(res.exitCode).not.toBeNull();
    expect(res.stderr).toMatch(/single workstream here/);
  });
});
