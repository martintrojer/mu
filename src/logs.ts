// mu — the log surface, as a thin shim over the **ops log**.
//
// @deprecated — v2-log-verb replaces this module. v9 dropped the
// `agent_logs` table; `ops` is now the single append-only record of
// every change (VISION.md § 2b). Rather than rewrite ~25 consumers in
// the schema commit, this module keeps its v1 signatures
// (appendLog / listLogs / latestSeq / emitEvent) and reads and writes
// `ops` rows underneath. v2-capture makes triggers the real writers
// and v2-log-verb re-renders `mu log` from intents; both delete
// chunks of this file.
//
// Shim mapping (v1 log row -> op):
//   kind       -> ops.entity     ('message' | 'event' | ...)
//   source     -> ops.actor
//   workstream -> ops.key        (natural key; '' = machine-wide)
//   payload    -> ops.payload    (raw text, not JSON, until v2-capture)
//   seq        -> ops.seq        (same AUTOINCREMENT cursor semantics)
//
// `ops.hlc` is now a REAL HLC minted by `nextHlc` (src/hlc.ts). The old
// placeholder `<iso>|<uuid>` is gone: `parseHlc` deliberately rejects
// that shape as a tripwire, so leaving it would have failed loudly the
// moment anything downstream read the log in HLC order.
//
// `group_id` is still a fresh uuid per entry rather than the ambient
// **op context** group. That is correct for this module's remaining
// callers, which are log APPENDS (`mu log write`, event breadcrumbs) —
// each is its own user-visible action, not part of a row-mutation
// group. Rows written through the capture triggers get the ambient
// group; these are hand-written log lines, not captured mutations.

import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { nextHlc } from "./hlc.js";

export type LogKind = "message" | "event" | "broadcast" | string;

export interface LogRow {
  /** Monotonic AUTOINCREMENT id. Use as the cursor for `--since`. */
  seq: number;
  /** Workstream this entry belongs to, or `null` for machine-wide. */
  workstreamName: string | null;
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

/** SELECT clause mapping op columns back onto the v1 log row shape.
 *  `ops.key` already holds the operator-facing workstream name (the
 *  natural key), so there is no join to do; '' means machine-wide and
 *  is normalised back to NULL in `rowFromDb`. */
const SELECT_LOG_COLS = `
  l.seq AS seq,
  l.key AS workstream,
  l.actor AS source,
  l.entity AS kind,
  l.payload AS payload,
  l.created_at AS created_at
`;

const LOG_FROM_JOIN = "FROM ops l";

/** The op entities this shim treats as LOG LINES.
 *
 *  Since v2-capture, `ops` holds two very different kinds of row: hand
 *  written log lines (these entities, from `appendLog` / `emitEvent`)
 *  and rows captured by the triggers on the portable tables
 *  ('workstream' / 'task' / 'note' / 'edge'). `mu log` and every v1
 *  consumer want only the former — without this filter a single
 *  `task add` would surface twice in `mu log`, once as its event
 *  breadcrumb and once as the raw captured op with a JSON payload.
 *
 *  v2-log-verb replaces this by rendering prose from `intent`, at which
 *  point captured ops become the PRIMARY source and this constant goes
 *  away. Until then the shim stays behaviour-compatible with v1. */
const LOG_ENTITIES = ["message", "event", "broadcast"] as const;

/** SQL predicate restricting a query to log-line entities. Any
 *  caller-supplied `kind` filter narrows within this set. */
const LOG_ENTITY_FILTER = `l.entity IN (${LOG_ENTITIES.map((e) => `'${e}'`).join(", ")})`;

/** Sentinel stored in `ops.key` for machine-wide entries (ops.key is
 *  NOT NULL). Exported so the few call sites that query `ops` directly
 *  agree with the shim. */
export const MACHINE_WIDE_KEY = "";

/** This machine's identity — the peer id every op is stamped with. */
function machineId(db: Db): string {
  const row = db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as
    | { machine_id: string }
    | undefined;
  return row?.machine_id ?? "unknown";
}

function rowFromDb(row: RawLogRow): LogRow {
  return {
    seq: row.seq,
    workstreamName: row.workstream === MACHINE_WIDE_KEY ? null : row.workstream,
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
  // `ops.key` is the NATURAL key, so the workstream NAME goes in
  // verbatim — no resolution, and the op stays readable after the
  // workstream is destroyed (which is the point of an ops log).
  const key = opts.workstream ?? MACHINE_WIDE_KEY;
  const result = db
    .prepare(
      `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'put', ?, ?)`,
    )
    .run(
      nextHlc(db),
      machineId(db),
      randomUUID(),
      opts.source,
      null,
      kind,
      key,
      opts.payload,
      createdAt,
    );
  return {
    seq: Number(result.lastInsertRowid),
    workstreamName: opts.workstream,
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
    conditions.push("l.key = ?");
    params.push(MACHINE_WIDE_KEY);
  } else if (opts.workstream !== undefined) {
    conditions.push("l.key = ?");
    params.push(opts.workstream);
  }
  if (opts.since !== undefined) {
    conditions.push("l.seq > ?");
    params.push(opts.since);
  }
  if (opts.source !== undefined) {
    conditions.push("l.actor = ?");
    params.push(opts.source);
  }
  if (opts.kind !== undefined) {
    conditions.push("l.entity = ?");
    params.push(opts.kind);
  }

  // Always restrict to log-line entities: captured row-mutation ops are
  // not log lines and must not leak into the v1 log surface.
  conditions.push(LOG_ENTITY_FILTER);

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
export function latestSeq(db: Db, workstream?: string): number {
  // Same LOG_ENTITY_FILTER as listLogs: this is the cursor INTO that
  // result set, so if it counted captured ops too, `--tail` would start
  // past log lines it never showed and silently skip them.
  const row =
    workstream === undefined
      ? (db.prepare(`SELECT MAX(seq) AS s FROM ops l WHERE ${LOG_ENTITY_FILTER}`).get() as {
          s: number | null;
        })
      : (db
          .prepare(`SELECT MAX(seq) AS s FROM ops l WHERE l.key = ? AND ${LOG_ENTITY_FILTER}`)
          .get(workstream) as { s: number | null });
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
// event renderers (which strip the structured prefix via
// displayEventPayload before colouring) keep working unchanged.
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
 *  `mu log`, static state, and the TUI so the user sees the prose, not
 *  the delimiter-noise. */
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
function lastClaimEvent(
  db: Db,
  workstream: string,
  localId: string,
): { payload: string; created_at: string } | null {
  // localId is validated by isValidTaskId — alnum + `_` + `-`. The
  // `_` is a LIKE wildcard, so escape it (and `%` and `\` for
  // completeness, even though they can't appear in a valid id).
  const escaped = localId.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `${CLAIM_EVENT_PREFIX}\t${escaped}\t%`;
  const row = db
    .prepare(
      `SELECT payload, created_at FROM ops
        WHERE key = ? AND entity = 'event' AND payload LIKE ? ESCAPE '\\'
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(workstream, pattern) as { payload: string; created_at: string } | undefined;
  return row ?? null;
}

export function lastClaimActor(db: Db, workstream: string, localId: string): string | null {
  const row = lastClaimEvent(db, workstream, localId);
  return row ? parseClaimEventActor(row.payload) : null;
}

/**
 * Find the `created_at` timestamp of the most recent `task claim`
 * event for a given task (the structured `task.claim<TAB>...` payload
 * emitted by claim.ts, both worker-claim and `--self` paths).
 *
 * Used by `mu task notes --since-claim` to slice the note timeline at
 * the most recent claim, so an operator dispatching a worker can see
 * only the post-claim notes (the spec was added before the claim;
 * the worker's progress lives after).
 *
 * Returns null when no claim event exists for this task — the CLI's
 * `--since-claim` then degrades gracefully to no filter (equivalent
 * to `--since-beginning`). Mirrors `lastClaimActor`'s LIKE-with-
 * escape pattern so a same-prefix id (`foo` vs `foo_2`) can't
 * cross-match.
 */
export function lastClaimEventAt(db: Db, workstream: string, localId: string): string | null {
  return lastClaimEvent(db, workstream, localId)?.created_at ?? null;
}

/**
 * Canonical list of two-token verb prefixes that `emitEvent` callers
 * use as the leading words of a payload. Single source of truth for
 * event renderers so they can never drift away from the actual emitter
 * sites.
 *
 * Maintenance contract: when you add an `emitEvent(...)` call whose
 * payload starts with a new two-word verb, add the verb here. A
 * regression test walks every entry and asserts the classifier
 * recognises it; the test fails if you add an emitter without adding
 * its verb here.
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
  // strips the structured prefix before renderers classify it, so the
  // prose tail starting with `task claim` still matches.
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
  "agent kick",
  // src/tasks/wait.ts — emitted when --stuck-after fires (alive +
  // assigned + no recent progress; idle_assigned_agent_detection).
  "agent stalled",
  // src/workspace.ts
  "workspace create",
  "workspace free",
  "workspace refresh",
  "workspace recreate",
  // src/workstream.ts
  "workstream init",
  "workstream destroy",
  "workstream export",
];

// ─── Verb classification (for renderers that colour by verb) ──────

export interface ClassifiedEvent {
  /** One of EVENT_VERB_PREFIXES. */
  verb: string;
  /** Payload past the verb token; preserves leading separator (" " or "\t"). */
  rest: string;
}

/**
 * Match `payload` against EVENT_VERB_PREFIXES. Returns {verb, rest} on
 * match; null otherwise. The verb-boundary check is `next is space, tab,
 * or end-of-string` so we don't false-match e.g. `task addnote`.
 *
 * Pure parser. Consumers (the static state card, the ink Activity-log
 * card) apply their own colour to `verb` after matching.
 */
export function classifyEventVerb(payload: string): ClassifiedEvent | null {
  for (const verb of EVENT_VERB_PREFIXES) {
    if (!payload.startsWith(verb)) continue;
    const next = payload.charCodeAt(verb.length);
    if (!Number.isNaN(next) && next !== 0x20 && next !== 0x09) continue;
    return { verb, rest: payload.slice(verb.length) };
  }
  return null;
}
