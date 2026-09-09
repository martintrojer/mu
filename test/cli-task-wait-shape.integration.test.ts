// Regression: `mu task wait --any` and `--first` share the SAME
// exit-condition (succeed when ONE listed task reaches target) but
// MUST NOT share the same output shape. The help text and the
// --first inline contract promise that ONLY --first emphasises WHICH
// ref fired (prints the qualified id to stdout / adds a `firing`
// field to --json); --any keeps the ordinary per-task summary.
//
// finding_task_wait_any_emits_first: the implementation had
// `wantFirstShape = opts.first || opts.any`, so --any leaked the
// firing-id line and the `firing` JSON field. These tests pin that
// --any stays summary-shaped while --first carries the firing ref.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { addTask, setTaskStatus } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

interface WaitJsonPayload {
  firing: { qualifiedId: string } | null;
  all: Array<{ qualifiedId: string }>;
  timedOut: unknown[];
}

describe("mu task wait — --any vs --first output shape", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    // No managed agents: the per-poll reconcile must see an empty
    // pane list rather than hitting a real tmux server.
    setTmuxExecutor(async (args) => {
      if (args[0] === "list-panes" && args[1] === "-s") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-shape-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    addTask(db, { localId: "a", workstream: "test", title: "A", impact: 50, effortDays: 1 });
    addTask(db, { localId: "b", workstream: "test", title: "B", impact: 50, effortDays: 1 });
    // Only `a` reaches the target so "first/any" has a single firing ref.
    setTaskStatus(db, "a", "CLOSED", { workstream: "test" });
  });

  afterEach(() => {
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("--first prints the firing ref's qualified id on stdout; --any does not", async () => {
    const first = await runCli(["task", "wait", "a", "b", "--first", "-w", "test"], dbPath);
    const any = await runCli(["task", "wait", "a", "b", "--any", "-w", "test"], dbPath);

    expect(first.error).toBeUndefined();
    expect(any.error).toBeUndefined();
    // --first leads with the bare qualified id line.
    expect(first.stdout.split("\n")[0]).toBe("test/a");
    // --any never emits the firing-id line.
    expect(any.stdout.split("\n")[0]).not.toBe("test/a");
    // Both still print the any-of summary.
    expect(first.stdout).toContain("any-of");
    expect(any.stdout).toContain("any-of");
  });

  it("--first --json sets `firing`; --any --json leaves it null", async () => {
    const first = await runCli(
      ["task", "wait", "a", "b", "--first", "--json", "-w", "test"],
      dbPath,
    );
    const any = await runCli(["task", "wait", "a", "b", "--any", "--json", "-w", "test"], dbPath);

    expect(first.error).toBeUndefined();
    expect(any.error).toBeUndefined();

    const firstPayload = JSON.parse(first.stdout) as WaitJsonPayload;
    const anyPayload = JSON.parse(any.stdout) as WaitJsonPayload;

    expect(firstPayload.firing).not.toBeNull();
    expect(firstPayload.firing?.qualifiedId).toBe("test/a");
    expect(anyPayload.firing).toBeNull();
  });

  // wait-json-firing-null-exit0: filed as "--first can exit 0 with
  // firing:null". It cannot — see the two tests below. What CAN do
  // that is --any, on a perfectly successful wait, which is what the
  // docs described as "--first / --any" and what a consumer doing
  // `.firing.name` crashes on. Pinning both halves so neither the
  // real shape nor the invariant can drift back.

  it("--any exits 0 with firing:null on SUCCESS (the null is not a failure signal)", async () => {
    const any = await runCli(["task", "wait", "a", "b", "--any", "--json", "-w", "test"], dbPath);

    expect(any.error).toBeUndefined();
    const payload = JSON.parse(any.stdout) as WaitJsonPayload;
    // The wait genuinely succeeded: `a` reached CLOSED and is in `all`,
    // and nothing is outstanding — yet `firing` is null. Exit 0 plus
    // firing:null therefore means "success, ref unidentified", never
    // "something went wrong".
    expect(payload.firing).toBeNull();
    expect(payload.all.map((t) => t.qualifiedId)).toEqual(["test/a"]);
    expect(payload.timedOut).toEqual([]);
  });

  it("--first never exits 0 with firing:null: a clean exit always names the ref", async () => {
    // The invariant behind the unreachable `?? null` in claim.ts:
    // --first implies any:true, and both non-timeout returns in
    // waitForTasks are guarded by isDone(), which for any:true means
    // >=1 ref reachedTarget. So a zero exit must carry a firing ref.
    const success = await runCli(
      ["task", "wait", "a", "b", "--first", "--json", "-w", "test"],
      dbPath,
    );
    expect(success.error).toBeUndefined();
    expect((JSON.parse(success.stdout) as WaitJsonPayload).firing).not.toBeNull();

    // The complement: when nothing reaches the target, firing is null
    // — but the exit is 5 (timeout), never 0. `b` is the only ref and
    // it stays OPEN.
    const timedOut = await runCli(
      ["task", "wait", "b", "--first", "--json", "-w", "test", "--timeout", "1"],
      dbPath,
    );
    expect(timedOut.exitCode).toBe(5);
    const payload = JSON.parse(timedOut.stdout) as WaitJsonPayload;
    expect(payload.firing).toBeNull();
    expect(payload.timedOut).toHaveLength(1);
  });
});
