// Unit tests for `mu task wait`'s cross-workstream qualified refs +
// --first WHICH return (task_wait_cross_workstream).
//
// Real SQLite (in-temp-dir), no tmux. Drives the CLI in-process via
// runCli so the assertions cover the whole verb pipeline (parse +
// resolve + dispatch + JSON shape + stdout).
//
// What the v0.3 dispatch wave needs from `mu task wait`:
//   1. Two-workstream qualified refs resolve without -w; --first
//      prints the firing ref's qualified id to stdout.
//   2. Mixed bare + qualified refs: bare uses -w, qualified uses
//      its own prefix.
//   3. --json firing shape matches the spec: { workstreamName,
//      name, qualifiedId, status, owner } on success; null on the
//      --all path even on success.
//   4. Bad qualified ref (workstream doesn't exist) → TaskNotFoundError
//      naming the bad ref. Nothing waited; nothing committed.
//   5. --all success: all=[every closed ref], timedOut=[].
//   6. Timeout/partial: firing=null, all=[met refs], timedOut=[unmet].

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask, setTaskStatus } from "../src/tasks.js";
import { setWaitSleepForTests } from "../src/tasks/wait.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task wait — cross-workstream qualified refs + --first", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;
  let restoreSleep: ((ms: number) => Promise<void>) | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-x-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "wsa");
    ensureWorkstream(db, "wsb");
    // Tight poll-sleep so timeout-path tests don't burn real wall time.
    restoreSleep = setWaitSleepForTests(async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)));
    });
  });

  afterEach(() => {
    if (restoreSleep !== undefined) setWaitSleepForTests(restoreSleep);
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── --first / --any cross-ws WHICH return ─────────────────────────

  it("--any across two workstreams returns the firing ref's qualified id", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    addTask(db, { localId: "bar", workstream: "wsb", title: "Bar", impact: 50, effortDays: 1 });
    // wsa/foo is already CLOSED → wait should return immediately.
    setTaskStatus(db, "foo", "CLOSED", { workstream: "wsa" });

    const { exitCode, stdout, stderr, error } = await runCli(
      ["task", "wait", "wsa/foo", "wsb/bar", "--any", "--timeout", "5", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stderr).toBe("");
    expect(exitCode).toBeNull();
    const out = JSON.parse(stdout);
    expect(out.firing).toMatchObject({
      workstreamName: "wsa",
      name: "foo",
      qualifiedId: "wsa/foo",
      status: "CLOSED",
    });
    expect(out.all).toHaveLength(1);
    expect(out.all[0]).toMatchObject({ workstreamName: "wsa", name: "foo" });
    expect(out.timedOut).toHaveLength(0);
  });

  it("--first prints qualified id to stdout (pipeable into the next step)", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    addTask(db, { localId: "bar", workstream: "wsb", title: "Bar", impact: 50, effortDays: 1 });
    setTaskStatus(db, "bar", "CLOSED", { workstream: "wsb" });

    const { exitCode, stdout, error } = await runCli(
      ["task", "wait", "wsa/foo", "wsb/bar", "--first", "--timeout", "5"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    // First line of stdout MUST be the qualified id (so a script can
    // do `closed=$(mu task wait ... --first | head -1)`).
    const firstLine = stdout.split("\n")[0];
    expect(firstLine).toBe("wsb/bar");
  });

  it("mixed bare + qualified: bare uses -w, qualified uses its prefix", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    addTask(db, { localId: "bar", workstream: "wsb", title: "Bar", impact: 50, effortDays: 1 });
    setTaskStatus(db, "foo", "CLOSED", { workstream: "wsa" });
    setTaskStatus(db, "bar", "CLOSED", { workstream: "wsb" });

    // foo is bare (resolves via -w wsa); wsb/bar is qualified.
    const { exitCode, stdout, stderr, error } = await runCli(
      ["task", "wait", "foo", "wsb/bar", "-w", "wsa", "--timeout", "5", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stderr).toBe("");
    expect(exitCode).toBeNull();
    const out = JSON.parse(stdout);
    expect(out.allReached).toBe(true);
    expect(out.all).toHaveLength(2);
    const allIds = (out.all as { qualifiedId: string }[]).map((t) => t.qualifiedId).sort();
    expect(allIds).toEqual(["wsa/foo", "wsb/bar"]);
  });

  // ─── --json shape contract ─────────────────────────────────────────

  it("--json on --all success: firing=null; all=[every ref]; timedOut=[]", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    addTask(db, { localId: "bar", workstream: "wsb", title: "Bar", impact: 50, effortDays: 1 });
    setTaskStatus(db, "foo", "CLOSED", { workstream: "wsa" });
    setTaskStatus(db, "bar", "CLOSED", { workstream: "wsb" });

    const { exitCode, stdout, error } = await runCli(
      ["task", "wait", "wsa/foo", "wsb/bar", "--timeout", "5", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    const out = JSON.parse(stdout);
    // --all path: firing IS null (no single "first" to single out).
    expect(out.firing).toBeNull();
    expect(out.all).toHaveLength(2);
    expect(out.timedOut).toEqual([]);
    // nextSteps include the verify hint on success.
    expect(out.nextSteps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ intent: expect.stringContaining("Verify") }),
      ]),
    );
  });

  it("--json on partial timeout: firing=null; all=[met]; timedOut=[unmet]", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    addTask(db, { localId: "bar", workstream: "wsb", title: "Bar", impact: 50, effortDays: 1 });
    // foo CLOSED, bar OPEN → --all times out with partial progress.
    setTaskStatus(db, "foo", "CLOSED", { workstream: "wsa" });

    const { exitCode, stdout, error } = await runCli(
      ["task", "wait", "wsa/foo", "wsb/bar", "--timeout", "1", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    // --json + timeout = exit 5.
    expect(exitCode).toBe(5);
    const out = JSON.parse(stdout);
    // The JSON contract per task_wait_cross_workstream:
    //   firing  — null on the --all path (even on partial success)
    //   all     — array of refs that REACHED target
    //   timedOut— array of refs that did NOT reach target.
    //             (The legacy boolean `timedOut` from the SDK result
    //             spread is intentionally overwritten by the array;
    //             callers branch on `firing === null && timedOut.length
    //             > 0` for the partial-progress case.)
    expect(out.firing).toBeNull();
    const all = out.all as { qualifiedId: string }[];
    const unmet = out.timedOut as { qualifiedId: string }[];
    expect(all).toHaveLength(1);
    expect(all[0]?.qualifiedId).toBe("wsa/foo");
    expect(Array.isArray(unmet)).toBe(true);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.qualifiedId).toBe("wsb/bar");
  });

  // ─── Bad ref handling ──────────────────────────────────────────────

  it("qualified ref to a non-existent workstream → TaskNotFoundError; nothing waited", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });

    const { exitCode, stderr, error } = await runCli(
      ["task", "wait", "wsa/foo", "ghostws/bar", "--timeout", "60"],
      dbPath,
    );
    expect(error).toBeUndefined();
    // TaskNotFoundError → exit 3 via the cli handler.
    expect(exitCode).toBe(3);
    expect(stderr).toContain("ghostws/bar");
  });

  it("qualified ref where the task doesn't exist → TaskNotFoundError naming the qualified ref", async () => {
    // wsa exists but has no 'missing' task.
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });

    const { exitCode, stderr, error } = await runCli(
      ["task", "wait", "wsa/missing", "--timeout", "60"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBe(3);
    expect(stderr).toContain("wsa/missing");
  });

  // ─── Single-ws happy path stays unchanged ─────────────────────────

  it("single-ws (no qualified refs) keeps today's bare-id output shape", async () => {
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    setTaskStatus(db, "foo", "CLOSED", { workstream: "wsa" });

    const { exitCode, stdout, error } = await runCli(
      ["task", "wait", "foo", "-w", "wsa", "--timeout", "5"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    // Single-ws: per-task lines use the bare local id (not the
    // qualified form) to avoid noise. Verify by absence of `wsa/foo`
    // and presence of bare `foo`.
    expect(stdout).not.toContain("wsa/foo");
    expect(stdout).toContain("foo");
  });
});
