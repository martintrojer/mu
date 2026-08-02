// bug_whitespace_status_fragment — end-to-end exit-code guard for the
// empty-vs-blank rule (docs/VOCABULARY.md § Empty vs blank flag
// fragments).
//
// The unit tests in test/cli-shared.test.ts pin parseCsvFlag itself and
// test/cli-input-property.test.ts pins the property. This file pins the
// thing an operator actually observes: the EXIT CODE. A blank fragment
// must land in the usage lane (exit 2), not silently produce a
// different answer than the one typed.
//
// Why exit code and not just the message: the original bug was
// silent-and-successful. A regression that restored the drop would keep
// every message assertion green while flipping exit 2 back to exit 0.
//
// Fast tier: in-process runCli, per-test temp DB, no tmux/VCS.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("blank (whitespace-only) flag fragments are a usage error", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-blankfrag-"));
    dbPath = join(tempDir, "mu.db");
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "ws");
    db.close();
    for (const id of ["a", "b"]) {
      const r = await runCli(
        ["task", "add", id, "-t", id.toUpperCase(), "-i", "5", "-e", "1", "-w", "ws"],
        dbPath,
      );
      expect(r.exitCode).toBeNull();
    }
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // The headline case from the bug report. Before the fix this exited 0
  // and applied NO status filter at all — a silently wrong answer.
  it("`task list --status 'OPEN, '` exits 2 instead of silently ignoring the filter", async () => {
    const r = await runCli(["task", "list", "-w", "ws", "--status", "OPEN, "], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/blank \(whitespace-only\)/);
  });

  it("`task list --status ' '` exits 2 instead of returning every task", async () => {
    const r = await runCli(["task", "list", "-w", "ws", "--status", " "], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--status got a blank/);
  });

  it("`task block --by ' '` exits 2", async () => {
    const r = await runCli(["task", "block", "b", "--by", " ", "-w", "ws"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/blank \(whitespace-only\)/);
  });

  it("`task add --blocked-by ' '` exits 2 instead of creating an unblocked task", async () => {
    const r = await runCli(
      ["task", "add", "c", "-t", "C", "-i", "5", "-e", "1", "--blocked-by", " ", "-w", "ws"],
      dbPath,
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/blank \(whitespace-only\)/);
    // And the task must NOT exist: the check runs before any write.
    const show = await runCli(["task", "show", "c", "-w", "ws"], dbPath);
    expect(show.exitCode).not.toBeNull();
  });

  it("`-w ' '` exits 2 instead of resolving to a bogus workstream", async () => {
    const r = await runCli(["task", "list", "-w", " "], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/-w\/--workstream got a blank/);
  });

  // ─── The other half of the rule: EMPTY still works ────────────────
  //
  // These guard against over-correcting. A trailing comma is a comma
  // artifact and an explicit '' is a documented sentinel; neither is a
  // typo, so neither may start erroring.

  it("`--status 'OPEN,'` (trailing comma) still succeeds", async () => {
    const r = await runCli(["task", "list", "-w", "ws", "--status", "OPEN,", "--json"], dbPath);
    expect(r.exitCode).toBeNull();
    const payload = JSON.parse(r.stdout.trim()) as { count: number };
    expect(payload.count).toBe(2);
  });

  it("`task reparent --blocked-by ''` still clears all blockers", async () => {
    const blocked = await runCli(["task", "block", "b", "--by", "a", "-w", "ws"], dbPath);
    expect(blocked.exitCode).toBeNull();
    // The documented clear-all sentinel must survive the fix.
    const r = await runCli(["task", "reparent", "b", "--blocked-by", "", "-w", "ws"], dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toMatch(/removed 1 edges/);
  });

  it("`task block --by ''` remains the all-empty usage error it already was", async () => {
    // Pre-existing behaviour, asserted here so the blank rule
    // doesn't accidentally change which message an operator sees.
    const r = await runCli(["task", "block", "b", "--by", "", "-w", "ws"], dbPath);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/at least one blocker/);
  });
});
