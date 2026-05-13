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
    // runCli() now mirrors argv onto process.argv internally so
    // isJsonMode() (which reads process.argv directly) works in tests.
    // No per-test argv shim required.
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
    const { stderr, exitCode, error } = await runCli(argv, dbPath);
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
    // Assert only the load-bearing parts (verb, sanitised id, --title flag)
    // so cosmetic copy edits to the suggestion suffix don't drift the test.
    const sanitised = envelope.nextSteps.find((s) => s.intent.toLowerCase().includes("sanitise"));
    const sanitisedCmd = sanitised?.command ?? "";
    expect(sanitisedCmd).toContain("mu task add");
    expect(sanitisedCmd).toContain("bad_id");
    expect(sanitisedCmd).toMatch(/--title/);
  });

  it("DB has no row after a rejected add (validation runs before INSERT)", async () => {
    await runCli(["task", "add", "Bad ID", "-w", "test", "-t", "x", "-i", "50", "-e", "1"], dbPath);
    const db = openDb({ path: dbPath });
    const row = db.prepare("SELECT 1 FROM tasks").get();
    db.close();
    expect(row).toBeUndefined();
  });
});
