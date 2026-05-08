// mu — `mu sql` escape-hatch verb.
//
// Read OR write — `mu sql` is the explicit escape hatch. Single-statement
// path uses better-sqlite3's prepare() so we can distinguish read
// (.all() rows) from write (.run() change count). Multi-statement path
// uses db.exec() which handles BEGIN/COMMIT and multiple semicolon-
// separated statements but returns nothing structured.
//
// `--confirm-rows N` adds a transactional safety belt: if the actual
// affected-row count doesn't match N, the whole thing rolls back.
//
// Extracted from src/cli.ts as part of refactor_split_large_src_files.

import Table from "cli-table3";
import pc from "picocolors";
import { UsageError, emitJson } from "../cli.js";
import type { Db } from "../db.js";

export async function cmdSql(
  db: Db,
  query: string,
  opts: { json?: boolean; confirmRows?: number } = {},
): Promise<void> {
  // Read OR write — `mu sql` is the explicit escape hatch.
  //
  // Single-statement path uses better-sqlite3's prepare() so we can
  // distinguish read (.all() rows) from write (.run() change count).
  // Multi-statement path uses db.exec() which handles BEGIN/COMMIT and
  // multiple semicolon-separated statements but returns nothing
  // structured. We try prepare() first; if it throws the
  // 'more than one statement' SqliteError, we fall back to exec().
  // This keeps the simple case fast and well-typed while making
  // multi-statement migrations / cleanup scripts a one-shot.
  const trimmed = query.trim();
  // Probe whether this is a single statement by trying prepare(); if
  // better-sqlite3 throws 'more than one statement', use exec() instead.
  // Capture the prepared statement so the single-statement path below
  // doesn't re-prepare (review_code_sql_double_prepare).
  let stmt: ReturnType<typeof db.prepare> | undefined;
  let isMulti = false;
  try {
    stmt = db.prepare(trimmed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/more than one statement/i.test(msg)) {
      isMulti = true;
    } else {
      throw err;
    }
  }

  if (isMulti) {
    // Multi-statement: db.exec() doesn't report a per-statement change
    // count, so for --confirm-rows we wrap the whole script in a manual
    // transaction and diff total_changes() before/after. Note: scripts
    // that contain their own BEGIN/COMMIT will fail under --confirm-rows
    // (sqlite refuses nested transactions); that's the price of an
    // atomic confirm-or-rollback wrapper around an opaque blob.
    if (opts.confirmRows !== undefined) {
      const expected = opts.confirmRows;
      const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
      db.exec("BEGIN");
      let actual: number;
      try {
        db.exec(trimmed);
        const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
        actual = after - before;
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
      if (actual !== expected) {
        db.exec("ROLLBACK");
        throw new UsageError(
          `expected ${expected} rows, would have affected ${actual} (rolled back). Re-run with --confirm-rows ${actual} if intentional.`,
        );
      }
      db.exec("COMMIT");
      const n = countTopLevelStatements(trimmed);
      if (opts.json) {
        emitJson({
          statements: n,
          multiStatement: true,
          confirmRows: expected,
          actualRows: actual,
        });
        return;
      }
      console.log(
        pc.dim(
          `ran ${n} statement${n === 1 ? "" : "s"} (${actual} row${actual === 1 ? "" : "s"} affected)`,
        ),
      );
      return;
    }
    db.exec(trimmed);
    const n = countTopLevelStatements(trimmed);
    if (opts.json) {
      emitJson({ statements: n, multiStatement: true });
      return;
    }
    console.log(pc.dim(`ran ${n} statement${n === 1 ? "" : "s"}`));
    return;
  }

  const lower = trimmed.toLowerCase();
  const isRead =
    lower.startsWith("select") || lower.startsWith("with") || lower.startsWith("explain");
  if (opts.confirmRows !== undefined && isRead) {
    throw new UsageError(
      "--confirm-rows is only meaningful on write statements (UPDATE / DELETE / INSERT / REPLACE)",
    );
  }
  if (isRead) {
    if (!stmt) throw new Error("unreachable: stmt should be set on the single-statement path");
    const rows = stmt.all([]);
    if (opts.json) {
      emitJson(rows);
      return;
    }
    if (rows.length === 0) {
      console.log(pc.dim("(no rows)"));
      return;
    }
    const first = rows[0] as Record<string, unknown>;
    const keys = Object.keys(first);
    const table = new Table({ head: keys.map((k) => pc.bold(k)), style: { head: [] } });
    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      table.push(keys.map((k) => formatCell(obj[k])));
    }
    console.log(table.toString());
    console.log(pc.dim(`(${rows.length} row${rows.length === 1 ? "" : "s"})`));
  } else {
    if (opts.confirmRows !== undefined) {
      const expected = opts.confirmRows;
      db.exec("BEGIN");
      if (!stmt) throw new Error("unreachable: stmt should be set on the single-statement path");
      let result: { changes: number; lastInsertRowid: number | bigint };
      try {
        result = stmt.run([]);
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
      if (result.changes !== expected) {
        db.exec("ROLLBACK");
        throw new UsageError(
          `expected ${expected} rows, would have affected ${result.changes} (rolled back). Re-run with --confirm-rows ${result.changes} if intentional.`,
        );
      }
      db.exec("COMMIT");
      if (opts.json) {
        emitJson({
          changes: result.changes,
          lastInsertRowid: Number(result.lastInsertRowid),
          confirmRows: expected,
          actualRows: result.changes,
        });
        return;
      }
      console.log(pc.dim(`${result.changes} row${result.changes === 1 ? "" : "s"} affected`));
      return;
    }
    if (!stmt) throw new Error("unreachable: stmt should be set on the single-statement path");
    const result = stmt.run([]);
    if (opts.json) {
      emitJson({
        changes: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid),
      });
      return;
    }
    console.log(pc.dim(`${result.changes} row${result.changes === 1 ? "" : "s"} affected`));
  }
}

/**
 * Count top-level SQL statements in `sql`, ignoring semicolons inside
 * single-quoted strings, double-quoted identifiers, line comments
 * (`-- ...`), and block comments (`/* ... *\/`). Used by `mu sql`'s
 * multi-statement path to report 'ran N statements'.
 *
 * Hand-rolled rather than pulling in a SQL parser — mu's escape hatch
 * is for human-typed scripts, not arbitrary SQL. The state machine
 * covers the cases we care about; pathological inputs (nested
 * comments, dollar-quoted strings, etc.) may miscount but won't crash
 * the verb (db.exec already ran successfully by then).
 */
export function countTopLevelStatements(sql: string): number {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let sawNonWs = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      // SQL-style escaped single quote: '' inside a string
      if (c === "'" && next === "'") {
        i++;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '"' && next === '"') {
        i++;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (c === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === ";") {
      if (sawNonWs) {
        count++;
        sawNonWs = false;
      }
      continue;
    }
    if (c !== undefined && /\S/.test(c)) sawNonWs = true;
  }
  if (sawNonWs) count++; // trailing statement without `;`
  return count;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return pc.dim("null");
  if (typeof v === "string") return v;
  return String(v);
}

// ─── commander wiring ────────────────────────────────────────────────
//
// wireSqlCommand is called by buildProgram() in src/cli.ts. Wired here so
// every per-namespace builder lives next to its cmd functions.

import type { Command } from "commander";
import { JSON_OPT, handle, parseLines } from "../cli.js";

export function wireSqlCommand(program: Command): void {
  program
    .command("sql <query>")
    .description("Run a SQL query against the live mu DB (SELECT / UPDATE / DELETE all allowed)")
    .option(...JSON_OPT)
    .option(
      "--confirm-rows <n>",
      "abort if affected-row count differs from N (rollback)",
      parseLines,
    )
    .action(function (query: string) {
      const opts = (this as Command).opts() as { json?: boolean; confirmRows?: number };
      return handle((db) => cmdSql(db, query, opts))();
    });
}
