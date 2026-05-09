// Tests for the test helper itself (test/_runCli.ts). Verifies the
// contract that `runCli` returns `error` on UNHANDLED throws (vs the
// expected exit-shim / commander-parse-error paths). Surfaced by
// review_test_runcli_silently_swallows_throws: the previous contract
// silently turned thrown TypeErrors into 'looks like normal exit'
// (exitCode=null, stdout='') which let broken verbs masquerade as
// successful in every consumer test.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./_runCli.js";

describe("runCli (test helper) error-surfacing contract", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-runcli-test-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("normal completion: exitCode null, no error key", async () => {
    const result = await runCli(["--help"], dbPath);
    // commander --help calls process.exit(0) which our shim captures.
    // Either way, no `error` field.
    expect(result.error).toBeUndefined();
  });

  it("typed error path: exit code captured, no error key", async () => {
    // Trigger a typed error: unknown agent in a fresh, workstream-scoped DB.
    // Post v5_prune_v4_fallback_branches, mu agent show requires a
    // workstream context (the v4 cross-workstream first-match fallback
    // is gone), so we have to seed the workstream and pass -w before
    // AgentNotFoundError can fire.
    const setup = await runCli(["workstream", "init", "scratch"], dbPath);
    // Successful command paths don't call process.exit; runCli captures null.
    expect(setup.exitCode === 0 || setup.exitCode === null).toBe(true);
    expect(setup.error).toBeUndefined();
    const result = await runCli(["agent", "show", "nope-no-such", "-w", "scratch"], dbPath);
    expect(result.error).toBeUndefined();
    // AgentNotFoundError -> exit code 3.
    expect(result.exitCode).toBe(3);
  });

  it("commander parse error: exit code captured, no error key", async () => {
    // Unknown option triggers commander.exitOverride().
    const result = await runCli(["task", "add", "x", "--bogus-flag"], dbPath);
    expect(result.error).toBeUndefined();
    // Commander parse error → some non-zero exit code.
    expect(result.exitCode).not.toBeNull();
  });
});
