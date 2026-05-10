// CLI-level tests for the `mu task add` truncation hint.
//
// Surfaced by slugifytitle_silently_drops_clauses: when a long title
// is auto-slugified, the SLUG_SOFT_CAP word-boundary cut silently
// drops trailing clauses. The id can read as the opposite of the
// original title (the dogfooded repro shifted "JSON omits localId;
// only top-level `name` is exposed" into an id that parses as "JSON
// only omits localId"). The fix is a stderr hint on the create path
// pointing the operator at the `<id>` positional override; behaviour
// for scripts is unchanged (stderr-only, exit 0, suppressed in JSON
// mode).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task add — truncation hint", () => {
  let tempDir: string;
  let dbPath: string;

  // The dogfooded repro from the originating task note. Stripped slug
  // is 64 chars; the soft-cap word-boundary cut chops the trailing
  // clause about `name` being exposed.
  const LONG_TITLE = "task list/show JSON omits localId; only top-level 'name' is exposed";
  const SHORT_TITLE = "Build auth";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-trunc-hint-"));
    dbPath = join(tempDir, "mu.db");
    const db: Db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits a one-line stderr hint when auto-id derivation truncates the title", async () => {
    const r = await runCli(
      ["task", "add", "-w", "test", "-t", LONG_TITLE, "-i", "50", "-e", "1"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    // exit 0 — scripts that ignored stderr see no behaviour change.
    expect(r.exitCode === null || r.exitCode === 0).toBe(true);
    // The hint goes to stderr and names the truncated id + the override.
    expect(r.stderr).toContain("hint:");
    expect(r.stderr).toMatch(/truncated/);
    expect(r.stderr).toContain("<id>");
    // stdout still carries the human "Added task <id>" line.
    expect(r.stdout).toContain("Added task ");
  });

  it("does NOT emit the hint for a short title that fits below the soft cap", async () => {
    const r = await runCli(
      ["task", "add", "-w", "test", "-t", SHORT_TITLE, "-i", "50", "-e", "1"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.stderr).not.toContain("hint:");
  });

  it("does NOT emit the hint when the operator passed an explicit <id>", async () => {
    // Operator opted into the long title with an explicit short id —
    // they've already chosen the id by hand; nothing to warn about.
    const r = await runCli(
      ["task", "add", "manual_short_id", "-w", "test", "-t", LONG_TITLE, "-i", "50", "-e", "1"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.stderr).not.toContain("hint:");
  });

  it("suppresses the hint under --json (machine surface stays clean)", async () => {
    const r = await runCli(
      ["task", "add", "-w", "test", "-t", LONG_TITLE, "-i", "50", "-e", "1", "--json"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    // No stderr noise, and stdout parses as a clean JSON object.
    expect(r.stderr).toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveProperty("task");
    expect(typeof parsed.task.name).toBe("string");
  });
});
