// Unit tests for the multi-statement support in `mu sql`.
//
// Two pieces:
//   1. countTopLevelStatements() — pure function; covered exhaustively
//      with edge cases (comments, quotes, escaped quotes, etc.)
//   2. End-to-end: build the program, invoke `mu sql "..."` with a
//      multi-statement script, verify the DB state changed as expected.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countTopLevelStatements } from "../src/cli.js";
import { type Db, openDb } from "../src/db.js";
import { runCli } from "./_runCli.js";

describe("countTopLevelStatements", () => {
  it("counts a single trailing-semicolon-less statement", () => {
    expect(countTopLevelStatements("SELECT 1")).toBe(1);
  });

  it("counts a single trailing-semicolon statement", () => {
    expect(countTopLevelStatements("SELECT 1;")).toBe(1);
  });

  it("counts two statements separated by ;", () => {
    expect(countTopLevelStatements("SELECT 1; SELECT 2;")).toBe(2);
  });

  it("counts statements without trailing newline", () => {
    expect(countTopLevelStatements("INSERT INTO t VALUES(1); INSERT INTO t VALUES(2)")).toBe(2);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    expect(countTopLevelStatements("INSERT INTO t VALUES('a;b;c'); SELECT 1")).toBe(2);
  });

  it("handles SQL-style escaped single quotes ('')", () => {
    // 'a''b;c' is the literal a'b;c. The semicolon inside should not count.
    expect(countTopLevelStatements("SELECT 'a''b;c'; SELECT 2")).toBe(2);
  });

  it("ignores semicolons inside double-quoted identifiers", () => {
    expect(countTopLevelStatements(`SELECT "col;name" FROM t; SELECT 2`)).toBe(2);
  });

  it("ignores semicolons inside line comments", () => {
    expect(countTopLevelStatements("SELECT 1; -- ; ; ;\nSELECT 2;")).toBe(2);
  });

  it("ignores semicolons inside block comments", () => {
    expect(countTopLevelStatements("SELECT 1; /* ; ; */ SELECT 2;")).toBe(2);
  });

  it("returns 0 for whitespace-only / empty input", () => {
    expect(countTopLevelStatements("")).toBe(0);
    expect(countTopLevelStatements("   \n\t  ")).toBe(0);
  });

  it("returns 0 for comments-only input", () => {
    expect(countTopLevelStatements("-- just a comment\n/* and another */")).toBe(0);
  });

  it("counts a BEGIN/COMMIT block as multiple statements", () => {
    const sql = `
      BEGIN;
      INSERT INTO t VALUES(1);
      INSERT INTO t VALUES(2);
      COMMIT;
    `;
    expect(countTopLevelStatements(sql)).toBe(4);
  });

  it("doesn't double-count empty statements (;;)", () => {
    expect(countTopLevelStatements("SELECT 1;; SELECT 2;")).toBe(2);
  });

  it("handles trailing semicolons gracefully", () => {
    expect(countTopLevelStatements("SELECT 1;;;;")).toBe(1);
  });
});

describe("multi-statement support via better-sqlite3 db.exec", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-sql-multi-"));
    db = openDb({ path: join(tempDir, "mu.db") });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("better-sqlite3 prepare() rejects multi-statement input", () => {
    expect(() => db.prepare("SELECT 1; SELECT 2;")).toThrow(/more than one statement/i);
  });

  it("better-sqlite3 exec() runs multi-statement input atomically", () => {
    db.exec(`
      INSERT INTO workstreams (name, created_at) VALUES ('a', datetime('now'));
      INSERT INTO workstreams (name, created_at) VALUES ('b', datetime('now'));
      INSERT INTO workstreams (name, created_at) VALUES ('c', datetime('now'));
    `);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name IN ('a','b','c')").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(3);
  });

  it("BEGIN/COMMIT inside exec is honoured", () => {
    db.exec(`
      BEGIN;
      INSERT INTO workstreams (name, created_at) VALUES ('tx_a', datetime('now'));
      INSERT INTO workstreams (name, created_at) VALUES ('tx_b', datetime('now'));
      COMMIT;
    `);
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name LIKE 'tx_%'").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(2);
  });
});

describe("mu sql --confirm-rows", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-sql-confirm-"));
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    // Seed a known set of rows we can DELETE/UPDATE against.
    db.exec(`
      INSERT INTO workstreams (name, created_at) VALUES ('cr_a', datetime('now'));
      INSERT INTO workstreams (name, created_at) VALUES ('cr_b', datetime('now'));
      INSERT INTO workstreams (name, created_at) VALUES ('cr_c', datetime('now'));
      INSERT INTO workstreams (name, created_at) VALUES ('keep', datetime('now'));
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function countCr(): number {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name LIKE 'cr_%'").get() as {
        n: number;
      }
    ).n;
  }

  it("single-statement: --confirm-rows N matches actual → commits", async () => {
    expect(countCr()).toBe(3);
    const { stdout, stderr } = await runCli(
      ["sql", "DELETE FROM workstreams WHERE name LIKE 'cr_%'", "--confirm-rows", "3", "--json"],
      dbPath,
    );
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toMatchObject({ changes: 3, confirmRows: 3, actualRows: 3 });
    expect(countCr()).toBe(0);
  });

  it("single-statement: --confirm-rows N != actual → rollback + UsageError", async () => {
    expect(countCr()).toBe(3);
    const { stdout, stderr } = await runCli(
      ["sql", "DELETE FROM workstreams WHERE name LIKE 'cr_%'", "--confirm-rows", "2"],
      dbPath,
    );
    // Combined output: error message references both expected and actual.
    const combined = stdout + stderr;
    expect(combined).toMatch(/expected 2 rows, would have affected 3/);
    expect(combined).toMatch(/rolled back/);
    expect(combined).toMatch(/--confirm-rows 3/);
    // No rows deleted.
    expect(countCr()).toBe(3);
  });

  it("--confirm-rows on a SELECT → UsageError, no rows changed", async () => {
    const { stdout, stderr } = await runCli(
      ["sql", "SELECT * FROM workstreams WHERE name LIKE 'cr_%'", "--confirm-rows", "3"],
      dbPath,
    );
    const combined = stdout + stderr;
    expect(combined).toMatch(/--confirm-rows is only meaningful on write statements/);
    expect(countCr()).toBe(3);
  });

  it("multi-statement: --confirm-rows N matches actual → commits", async () => {
    expect(countCr()).toBe(3);
    const sql = `
      DELETE FROM workstreams WHERE name = 'cr_a';
      DELETE FROM workstreams WHERE name = 'cr_b';
    `;
    const { stdout, stderr } = await runCli(["sql", sql, "--confirm-rows", "2", "--json"], dbPath);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toMatchObject({
      multiStatement: true,
      confirmRows: 2,
      actualRows: 2,
    });
    expect(countCr()).toBe(1); // only cr_c left
  });

  it("multi-statement: --confirm-rows N != actual → rollback + UsageError", async () => {
    expect(countCr()).toBe(3);
    const sql = `
      DELETE FROM workstreams WHERE name = 'cr_a';
      DELETE FROM workstreams WHERE name = 'cr_b';
    `;
    const { stdout, stderr } = await runCli(["sql", sql, "--confirm-rows", "3"], dbPath);
    const combined = stdout + stderr;
    expect(combined).toMatch(/expected 3 rows, would have affected 2/);
    expect(combined).toMatch(/rolled back/);
    expect(combined).toMatch(/--confirm-rows 2/);
    // Rollback restored both rows.
    expect(countCr()).toBe(3);
  });
});
