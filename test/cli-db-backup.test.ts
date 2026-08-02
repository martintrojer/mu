// `mu db backup` — the only survivor of the old `db` namespace.
//
// R17 deleted `mu db export / import / replay` (src/db-sync.ts and
// friends). Backup survives because the SchemaTooOldError next-steps
// and scripts/README.md both tell operators to run it before the
// importer — a missing verb there is a broken upgrade hint, which is
// what this file guards.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cmdDbBackup } from "../src/cli/db.js";
import { UsageError } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import { ensureWorkstream } from "../src/workstream.js";

describe("mu db backup", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-db-backup-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // best effort
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a readable copy of the whole DB", async () => {
    await ensureWorkstream(db, "alpha");
    const target = join(tempDir, "copy.db");

    cmdDbBackup(db, target);

    expect(existsSync(target)).toBe(true);
    const copy = openDb({ path: target });
    try {
      // The copy is a real mu DB, not just bytes on disk. Read the table
      // directly rather than via listWorkstreams, which shells out to
      // tmux for liveness and would drag this out of the fast tier.
      const names = (copy.prepare("SELECT name FROM workstreams").all() as { name: string }[]).map(
        (r) => r.name,
      );
      expect(names).toEqual(["alpha"]);
    } finally {
      copy.close();
    }
  });

  it("creates missing parent directories", () => {
    const target = join(tempDir, "nested", "deeper", "copy.db");
    cmdDbBackup(db, target);
    expect(existsSync(target)).toBe(true);
  });

  it("refuses to overwrite an existing file", () => {
    const target = join(tempDir, "copy.db");
    cmdDbBackup(db, target);
    expect(() => cmdDbBackup(db, target)).toThrow(UsageError);
  });
});
