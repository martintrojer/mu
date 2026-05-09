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

import { type Db, tryResolveWorkstreamId } from "./db.js";

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
  /** Joined from workstreams.name. Null when workstream_id is NULL. */
  workstream: string | null;
  source: string;
  kind: string;
  payload: string;
  created_at: string;
}

/** SELECT clause for joining workstream_id back to the operator-facing
 *  workstream name. Used by every read path so the JS-side row shape
 *  preserves the v4 contract. */
const SELECT_LOG_COLS = `
  l.seq AS seq,
  ws.name AS workstream,
  l.source AS source,
  l.kind AS kind,
  l.payload AS payload,
  l.created_at AS created_at
`;

const LOG_FROM_JOIN = "FROM agent_logs l LEFT JOIN workstreams ws ON ws.id = l.workstream_id";

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
  // Resolve workstream name -> surrogate id. Null stays null. We do NOT
  // throw on a missing workstream here — an event payload may legitimately
  // reference a workstream the row for which is being concurrently dropped
  // (e.g. workstream destroy emits its own log row with workstream=null
  // for exactly this reason). Best-effort resolution.
  const workstreamId =
    opts.workstream === null ? null : tryResolveWorkstreamId(db, opts.workstream);
  const result = db
    .prepare(
      `INSERT INTO agent_logs (workstream_id, source, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(workstreamId, opts.source, kind, opts.payload, createdAt);
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
    conditions.push("l.workstream_id IS NULL");
  } else if (opts.workstream !== undefined) {
    // Resolve once; if the workstream doesn't exist the result set is empty.
    const wsId = tryResolveWorkstreamId(db, opts.workstream);
    if (wsId === null) return [];
    conditions.push("l.workstream_id = ?");
    params.push(wsId);
  }
  if (opts.since !== undefined) {
    conditions.push("l.seq > ?");
    params.push(opts.since);
  }
  if (opts.source !== undefined) {
    conditions.push("l.source = ?");
    params.push(opts.source);
  }
  if (opts.kind !== undefined) {
    conditions.push("l.kind = ?");
    params.push(opts.kind);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Two query shapes:
  //   - When `since` is set, ascending order is what we want directly.
  //   - When `limit` is set without `since`, fetch the most-recent N
  //     (descending) then reverse so the caller still sees oldest-first.
  if (opts.limit !== undefined && opts.since === undefined) {
    const rowsDesc = db
      .prepare(`SELECT ${SELECT_LOG_COLS} ${LOG_FROM_JOIN} ${where} ORDER BY l.seq DESC LIMIT ?`)
      .all(...params, opts.limit) as RawLogRow[];
    return rowsDesc.reverse().map(rowFromDb);
  }

  let sql = `SELECT ${SELECT_LOG_COLS} ${LOG_FROM_JOIN} ${where} ORDER BY l.seq ASC`;
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

// ─── claim-event structured prefix ─────────────────────────────────
//
// `task claim` events are the one place where a state-changing verb
// emits TWO actors per row: the agent recorded as `source`, and the
// `actor=` field that may differ on the --self anonymous-claim path
// (where source == actor but tasks.owner stays NULL). The original
// payload was free prose (`task claim foo by bar (was owner=...)`)
// and the consumer (lastClaimActor below) prefix-matched the prose
// — brittle: any rename silently nulled out the attribution.
//
// The fix keeps the prose suffix for human readability but prepends
// a tab-delimited structured prefix that lastClaimActor parses
// robustly. Format:
//
//   task.claim<TAB><localId><TAB>actor=<actor><TAB>self=<0|1><TAB><prose>
//
// The trailing prose still starts with `task claim <localId> ...` so
// the HUD's verb colourer (which strips the structured prefix via
// displayEventPayload before colouring) keeps working unchanged.
//
// See: review_code_last_claim_actor_brittle.

/** Structured-prefix sentinel used by claim event payloads. The dot
 *  distinguishes it from the prose `task claim ...` tail. */
export const CLAIM_EVENT_PREFIX = "task.claim";

/** Build the structured payload for a `task claim` event. */
export function formatClaimEvent(opts: {
  localId: string;
  actor: string;
  anonymous: boolean;
  prose: string;
}): string {
  const self = opts.anonymous ? "1" : "0";
  return `${CLAIM_EVENT_PREFIX}\t${opts.localId}\tactor=${opts.actor}\tself=${self}\t${opts.prose}`;
}

/** Strip the structured `task.claim` prefix and return the human-prose
 *  tail. For non-claim payloads, returns the input unchanged. Used by
 *  `mu log` and HUD render so the user sees the prose, not the
 *  delimiter-noise. */
export function displayEventPayload(payload: string): string {
  if (!payload.startsWith(`${CLAIM_EVENT_PREFIX}\t`)) return payload;
  // task.claim<TAB><id><TAB>actor=...<TAB>self=...<TAB><prose>
  // Split into 5 fields; the prose may itself contain tabs (it doesn't
  // today, but be defensive: rejoin with TAB so we never lose data).
  const parts = payload.split("\t");
  if (parts.length < 5) return payload;
  return parts.slice(4).join("\t");
}

/** Parse the actor= field out of a structured claim payload. Returns
 *  null when the payload isn't a claim event or is malformed. */
export function parseClaimEventActor(payload: string): string | null {
  if (!payload.startsWith(`${CLAIM_EVENT_PREFIX}\t`)) return null;
  for (const field of payload.split("\t")) {
    if (field.startsWith("actor=")) return field.slice("actor=".length);
  }
  return null;
}

/**
 * Find the actor of the most recent `task claim <id>` event for a
 * given task. Used to surface 'who's working on this' when
 * `tasks.owner IS NULL` (the --self anonymous-claim path). Returns
 * null when no claim event exists for this task.
 *
 * Implementation: indexed lookup on (workstream, seq) with a LIKE
 * against the structured prefix. Unbounded — the previous limit=100
 * ceiling silently dropped attribution on long-lived workstreams.
 * The structured prefix (CLAIM_EVENT_PREFIX) makes the match
 * robust against payload-prose churn.
 */
export function lastClaimActor(db: Db, workstream: string, localId: string): string | null {
  // localId is validated by isValidTaskId — alnum + `_` + `-`. The
  // `_` is a LIKE wildcard, so escape it (and `%` and `\` for
  // completeness, even though they can't appear in a valid id).
  const escaped = localId.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `${CLAIM_EVENT_PREFIX}\t${escaped}\t%`;
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return null;
  const row = db
    .prepare(
      `SELECT payload FROM agent_logs
        WHERE workstream_id = ? AND kind = 'event' AND payload LIKE ? ESCAPE '\\'
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(wsId, pattern) as { payload: string } | undefined;
  if (!row) return null;
  return parseClaimEventActor(row.payload);
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
  // `task claim` is the prose-tail of a `task.claim\t...` structured
  // payload (see CLAIM_EVENT_PREFIX above); displayEventPayload
  // strips the structured prefix before the HUD colourer runs, so
  // the prose tail starting with `task claim` still matches.
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
