// mu — agent_logs: append-only timeline of activity in a workstream.
//
// Three roles in one table:
//   1. Manual broadcasts (`mu log "..."` from a shell or agent pane)
//   2. System events (auto-emitted by every state-changing verb;
//      wired in a follow-up commit so this surface is reviewable
//      first)
//   3. External script entries via `mu log --as ...`
//
// The seq column (AUTOINCREMENT INTEGER PK) is the cursor. A tail
// subscriber stores the last seq it saw and re-queries with
// `seq > <last>`; AUTOINCREMENT guarantees seq never recycles even
// after deletes, so the cursor is durable.

import type { Db } from "./db.js";

export type LogKind = "message" | "event" | "broadcast" | string;

export interface LogRow {
  /** Monotonic AUTOINCREMENT id. Use as the cursor for `--since`. */
  seq: number;
  /** Workstream this entry belongs to, or `null` for machine-wide. */
  workstream: string | null;
  /** Free TEXT: agent name, "system", "user", or anything a caller picks. */
  source: string;
  /** Free TEXT: "message" (default), "event" (auto state changes),
   *  "broadcast" (explicit cross-agent), or any caller-defined value. */
  kind: LogKind;
  /** Free utf-8 string. May be JSON if the kind suggests structure. */
  payload: string;
  /** ISO 8601 timestamp set at insert time. */
  createdAt: string;
}

interface RawLogRow {
  seq: number;
  workstream: string | null;
  source: string;
  kind: string;
  payload: string;
  created_at: string;
}

function rowFromDb(row: RawLogRow): LogRow {
  return {
    seq: row.seq,
    workstream: row.workstream,
    source: row.source,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export interface AppendLogOptions {
  /** Workstream this entry belongs to. `null` for machine-wide. */
  workstream: string | null;
  /** Who emitted this. Agent name, "system", "user", or arbitrary. */
  source: string;
  /** Defaults to "message". */
  kind?: LogKind;
  /** Free utf-8. Multi-line allowed. */
  payload: string;
}

/**
 * Append a log entry. Returns the inserted row (with assigned `seq`).
 * Constant-time. Single INSERT; safe to call from any state-changing
 * verb without a transaction wrapper.
 */
export function appendLog(db: Db, opts: AppendLogOptions): LogRow {
  const kind = opts.kind ?? "message";
  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO agent_logs (workstream, source, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(opts.workstream, opts.source, kind, opts.payload, createdAt);
  return {
    seq: Number(result.lastInsertRowid),
    workstream: opts.workstream,
    source: opts.source,
    kind,
    payload: opts.payload,
    createdAt,
  };
}

export interface ListLogsOptions {
  /** Filter by workstream. `undefined` = every workstream + machine-wide.
   *  `null` = ONLY machine-wide entries. */
  workstream?: string | null;
  /** Strictly > this seq. Use to resume a tail. */
  since?: number;
  /** Cap the result. With `since`, returns the FIRST N matching (oldest
   *  first). Without `since`, returns the LAST N (most recent),
   *  re-sorted oldest-first. */
  limit?: number;
  source?: string;
  kind?: string;
}

/**
 * List log entries. Always returns oldest-first. Use `since` for
 * cursor-based reads (the canonical tail pattern); use `limit` alone
 * for "show me the most recent N" reads.
 */
export function listLogs(db: Db, opts: ListLogsOptions = {}): LogRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.workstream === null) {
    conditions.push("workstream IS NULL");
  } else if (opts.workstream !== undefined) {
    conditions.push("workstream = ?");
    params.push(opts.workstream);
  }
  if (opts.since !== undefined) {
    conditions.push("seq > ?");
    params.push(opts.since);
  }
  if (opts.source !== undefined) {
    conditions.push("source = ?");
    params.push(opts.source);
  }
  if (opts.kind !== undefined) {
    conditions.push("kind = ?");
    params.push(opts.kind);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Two query shapes:
  //   - When `since` is set, ascending order is what we want directly.
  //   - When `limit` is set without `since`, fetch the most-recent N
  //     (descending) then reverse so the caller still sees oldest-first.
  if (opts.limit !== undefined && opts.since === undefined) {
    const rowsDesc = db
      .prepare(`SELECT * FROM agent_logs ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...params, opts.limit) as RawLogRow[];
    return rowsDesc.reverse().map(rowFromDb);
  }

  let sql = `SELECT * FROM agent_logs ${where} ORDER BY seq ASC`;
  if (opts.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  const rows = db.prepare(sql).all(...params) as RawLogRow[];
  return rows.map(rowFromDb);
}

/**
 * Return the latest seq currently in the table (or 0 if empty). Used
 * by `mu log --tail` to start the cursor at "now" so the subscriber
 * only sees NEW entries unless they explicitly pass `--since 0`.
 */
export function latestSeq(db: Db): number {
  const row = db.prepare("SELECT MAX(seq) AS s FROM agent_logs").get() as { s: number | null };
  return row.s ?? 0;
}

/**
 * One-line helper for state-changing SDK functions to auto-emit a
 * `kind='event'` log entry. Called AFTER the mutation succeeds, only
 * when the mutation actually produced a change (no-ops stay quiet).
 *
 * `source` defaults to 'system' since this is the auto-emission path;
 * a different source means "a specific agent caused this" and is set
 * by callers like `claimTask` (source = the claiming agent).
 */
export function emitEvent(
  db: Db,
  workstream: string | null,
  payload: string,
  source = "system",
): void {
  appendLog(db, { workstream, source, kind: "event", payload });
}

/**
 * Canonical list of two-token verb prefixes that `emitEvent` callers
 * use as the leading words of a payload. Single source of truth: the
 * HUD's event-tail colourer (src/cli/hud.ts colorEventPayload) reads
 * this so it can never drift away from the actual emitter sites.
 *
 * Maintenance contract: when you add an `emitEvent(...)` call whose
 * payload starts with a new two-word verb, add the verb here. A
 * regression test in test/hud.test.ts walks every entry and asserts
 * the HUD recognises it; the test fails if you add an emitter without
 * adding its verb here.
 *
 * Audit (2026-05): every `emitEvent` callsite under src/ produces a
 * payload that starts with one of these. Verified by
 * `grep -rn emitEvent src/ | grep -v import`.
 */
export const EVENT_VERB_PREFIXES: readonly string[] = [
  // src/tasks.ts + src/tasks/*.ts
  "task add",
  "task note",
  "task status",
  "task claim",
  "task release",
  "task update",
  "task delete",
  "task reap",
  "task block",
  "task unblock",
  "task reparent",
  // src/agents.ts + src/agents/*.ts
  "agent spawn",
  "agent close",
  "agent free",
  "agent adopt",
  // src/workspace.ts
  "workspace create",
  "workspace free",
  // src/workstream.ts
  "workstream init",
  "workstream destroy",
  "workstream export",
  // src/approvals.ts — note `approval`, not `approve`. The CLI verb
  // is `mu approve`, but the event payload uses the noun `approval`
  // (followed by a status word, e.g. `approval granted slug ...`).
  "approval add",
  "approval granted",
  "approval denied",
  "approval timeout",
];
