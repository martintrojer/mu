// Regression for review_substrate_resolve_id_anonymous_errors.
//
// `src/db.ts` used to throw plain `Error` objects with `.name` patched
// to the string `"TaskNotFoundError"` / `"AgentNotFoundError"` from
// `resolveTaskId` / `resolveAgentId`. Those instances flunk the
// `instanceof TaskNotFoundError` check in `src/cli/handle.ts`'s
// `classifyError` and fall through to generic exit 1, robbing
// operators of the 3 = not-found exit-code contract.
//
// The fix renames the helpers to `tryResolveTaskId` /
// `tryResolveAgentId` (return `null` on miss) and pushes the typed
// throw into the SDK callers that own the error classes. This test
// asserts a verb-level miss \u2014 `mu task close <nonexistent>` \u2014
// surfaces the typed exit code (3) instead of the generic 1.
//
// Lives in the fast tier: in-process CLI invocation (runCli), per-test
// temp DB, no real tmux / VCS subprocesses.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

interface JsonError {
  error: string;
  exitCode: number;
}

describe("typed not-found exit code surfaces from verb paths", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-not-found-exit-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("`mu task close <nonexistent>` exits 3, not 1", async () => {
    const r = await runCli(["task", "close", "no_such_task", "-w", "test"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toMatch(/no such task|TaskNotFoundError|not found/i);
  });

  it("`mu task close <nonexistent> --json` exits 3 and emits a structured error", async () => {
    const r = await runCli(["task", "close", "no_such_task", "-w", "test", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(3);
    const payload = JSON.parse(r.stderr) as JsonError;
    expect(payload.exitCode).toBe(3);
    expect(payload.error).toBe("TaskNotFoundError");
  });

  it("`mu agent show <nonexistent>` exits 3, not 1", async () => {
    const r = await runCli(["agent", "show", "no_such_agent", "-w", "test"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toMatch(/no such agent|AgentNotFoundError|not found/i);
  });
});
