// Fast-tier structural guards for the syncability constants in
// src/db.ts (SYNCED_ENTITIES / PORTABLE_TABLES / MACHINE_LOCAL_TABLES).
//
// These tests are deliberately STRUCTURAL rather than behavioural.
// Their whole job is to fail LOUDLY when someone adds an 11th table to
// EXPECTED_TABLES and forgets to classify it as **portable** or
// **machine-local** (docs/VOCABULARY.md § portable). A missing
// classification is a silent sync bug months later; a red test here is
// a five-second fix.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Db,
  EXPECTED_TABLES,
  MACHINE_LOCAL_TABLES,
  openDb,
  PORTABLE_TABLES,
  SYNCED_ENTITIES,
  type SyncedEntity,
} from "../src/db.js";

describe("syncability constants", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-entities-"));
    db = openDb({ path: join(dir, "mu.db") });
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  // The guard that matters most. Adding a table to EXPECTED_TABLES
  // without deciding whether it is portable or machine-local fails
  // HERE, at the moment the schema changes, not at the moment sync
  // silently drops (or leaks) it.
  it("PORTABLE_TABLES ∪ MACHINE_LOCAL_TABLES == EXPECTED_TABLES exactly", () => {
    const classified = [...PORTABLE_TABLES, ...MACHINE_LOCAL_TABLES].sort();
    expect(classified).toEqual([...EXPECTED_TABLES].sort());
  });

  it("no table is both portable and machine-local", () => {
    const local = new Set<string>(MACHINE_LOCAL_TABLES);
    const both = PORTABLE_TABLES.filter((t) => local.has(t));
    expect(both).toEqual([]);
  });

  it("neither list has duplicates", () => {
    expect(new Set(PORTABLE_TABLES).size).toBe(PORTABLE_TABLES.length);
    expect(new Set(MACHINE_LOCAL_TABLES).size).toBe(MACHINE_LOCAL_TABLES.length);
  });

  // Don't trust the constant — ask the DB. A typo'd table name would
  // otherwise sail through every set-comparison above.
  it("every portable table exists in a fresh v10 DB", () => {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    const actual = new Set(rows.map((r) => r.name));
    for (const table of PORTABLE_TABLES) {
      expect(actual.has(table), `portable table missing from schema: ${table}`).toBe(true);
    }
  });

  it("every machine-local table exists in a fresh v10 DB", () => {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>;
    const actual = new Set(rows.map((r) => r.name));
    for (const table of MACHINE_LOCAL_TABLES) {
      expect(actual.has(table), `machine-local table missing from schema: ${table}`).toBe(true);
    }
  });

  // OWNERSHIP DOES NOT SYNC, and it falls out of the constants rather
  // than needing a special case: `tasks.owner_id` is an FK into
  // `agents`, and `agents` is machine-local (it holds `pane_id`, e.g.
  // '%17', which names nothing on another machine). So a synced
  // `task` op cannot carry a meaningful owner. The deleted
  // db-sync.ts reached the same conclusion via an `includeOwners`
  // flag; here it is structural. If this test ever needs an exception
  // list, the design has drifted.
  it("agents is machine-local, which is what makes owner non-syncing", () => {
    const local = new Set<string>(MACHINE_LOCAL_TABLES);
    expect(local.has("agents")).toBe(true);
    expect(([...PORTABLE_TABLES] as string[]).includes("agents")).toBe(false);

    // The FK that makes it a consequence rather than a coincidence.
    const fks = db.prepare("PRAGMA foreign_key_list(tasks)").all() as Array<{
      table: string;
      from: string;
    }>;
    const ownerFk = fks.find((f) => f.from === "owner_id");
    expect(ownerFk?.table).toBe("agents");
  });

  // `ops` is classified machine-local ON PURPOSE, not omitted. The
  // table is never wholesale-copied: individual op ROWS ship, filtered
  // by SYNCED_ENTITIES and carried by per-machine segments.
  it("ops is classified rather than omitted", () => {
    expect(new Set<string>(MACHINE_LOCAL_TABLES).has("ops")).toBe(true);
  });

  // Exercising the derived union keeps the tuple `as const`. Drop the
  // `as const` in src/db.ts and this stops compiling (the element type
  // widens to `string`), which is the point.
  it("SyncedEntity is a derived union, not string", () => {
    const task: SyncedEntity = "task";
    expect(SYNCED_ENTITIES).toContain(task);

    // A total switch over the union: adding an entity to the tuple
    // without handling it here is a compile error.
    const describeEntity = (e: SyncedEntity): string => {
      switch (e) {
        case "workstream":
          return "a workstream";
        case "task":
          return "a task";
        case "edge":
          return "a dependency edge";
        case "note":
          return "a task note";
        case "message":
          return "an agent message";
      }
    };
    expect(SYNCED_ENTITIES.map(describeEntity)).toHaveLength(SYNCED_ENTITIES.length);
  });

  it("synced entities are singular and lowercase (op-entity naming)", () => {
    for (const e of SYNCED_ENTITIES) {
      expect(e).toMatch(/^[a-z]+$/);
      expect(e.endsWith("s")).toBe(false);
    }
    expect(new Set(SYNCED_ENTITIES).size).toBe(SYNCED_ENTITIES.length);
  });
});
