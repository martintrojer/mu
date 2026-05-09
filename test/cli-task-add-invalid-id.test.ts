// CLI smoke test for the typed `TaskIdInvalidError`.
//
// Surfaced by nit_invalid_id_typeerror: `mu task add Bad-ID ...`
// previously fell through to the generic exit-1 catch-all because
// addTask threw a bare `TypeError`. The fix replaces it with a
// `TaskIdInvalidError implements HasNextSteps` and adds it to the
// classifyError() exit-code map (exit 4 = validation / conflict).
//
// This test pins the outward contract (exit code + JSON shape +
// nextSteps); the unit-level coverage of the error class lives in
// test/tasks.test.ts and test/error-nextsteps.test.ts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task add — invalid id ergonomics", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-bad-id-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("invalid id exits 4 (not 1) with a typed JSON error envelope", async () => {
    // isJsonMode() reads process.argv directly (not the argv passed to
    // parseAsync), so shim process.argv to include --json for this run.
    const argv = [
      "--json",
      "task",
      "add",
      "Bad ID",
      "-w",
      "test",
      "-t",
      "Anything",
      "-i",
      "50",
      "-e",
      "1",
    ];
    const originalArgv = process.argv;
    process.argv = ["node", "mu", ...argv];
    let result: Awaited<ReturnType<typeof runCli>>;
    try {
      result = await runCli(argv, dbPath);
    } finally {
      process.argv = originalArgv;
    }
    const { stderr, exitCode, error } = result;
    expect(error).toBeUndefined();
    expect(exitCode).toBe(4);
    // The CLI's emitError() writes one JSON object per error to stderr.
    const lines = stderr.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toBeDefined();
    const envelope = JSON.parse(lastLine as string) as {
      error: string;
      message: string;
      nextSteps: { intent: string; command: string }[];
      exitCode: number;
    };
    expect(envelope.error).toBe("TaskIdInvalidError");
    expect(envelope.exitCode).toBe(4);
    expect(envelope.message).toMatch(/invalid task id/);
    expect(envelope.nextSteps.length).toBeGreaterThan(0);
    // First step is the auto-derived path: `mu task add --title "..."`
    // (no positional id). The second is the sanitised candidate.
    expect(envelope.nextSteps[0]?.command).toMatch(/--title/);
    const sanitised = envelope.nextSteps.find((s) => s.intent.toLowerCase().includes("sanitise"));
    expect(sanitised?.command).toMatch(/mu task add bad_id /);
  });

  it("DB has no row after a rejected add (validation runs before INSERT)", async () => {
    await runCli(["task", "add", "Bad ID", "-w", "test", "-t", "x", "-i", "50", "-e", "1"], dbPath);
    const db = openDb({ path: dbPath });
    const row = db.prepare("SELECT 1 FROM tasks").get();
    db.close();
    expect(row).toBeUndefined();
  });
});
