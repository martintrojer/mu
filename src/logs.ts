// mu — the log surface, as a thin shim over the **ops log**.
//
// @deprecated — v2-log-verb replaces this module. v9 dropped the
// `agent_logs` table; `ops` is now the single append-only record of
// every change (VISION.md § 2b). Rather than rewrite ~25 consumers in
// the schema commit, this module keeps its legacy signatures
// (appendLog / listLogs / latestSeq / emitEvent) and reads and writes
// `ops` rows underneath. v2-capture makes triggers the real writers
// and v2-log-verb re-renders `mu log` from intents; both delete
// chunks of this file.
//
// Shim mapping (legacy log row -> op):
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
import { intentSpellings } from "./legacy-ops.js";
import type { HasNextSteps, NextStep } from "./output.js";

export type LogKind = "message" | "event" | "broadcast" | string;

export interface LogRow {
  /** Monotonic AUTOINCREMENT id. Use as the cursor for `--since`. */
  seq: number;
  /** Workstream this entry belongs to, or `null` for machine-wide. */
  workstreamName: string | null;
  /** Free TEXT: agent name, "system", "user", or anything a caller picks.
   *  Captured ops that ran outside any actor context have no actor, and
   *  render as "system" rather than the string "null". */
  source: string;
  /** Structured intent ('task.close', 'agent.spawn', ...). Null only for
   *  operator-authored prose lines (`mu log write` / a `--kind` ledger),
   *  which name no state change. The formatter in src/log-render.ts
   *  renders from this — never from the payload text. */
  intent: string | null;
  /** Undo group: every op of one operator action shares it. Surfaced so
   *  `mu log` can print it and `mu log --group <id>` can filter to it
   *  (undo discoverability). */
  group: string;
  /** 'put' (semantic partial update) or 'del' (tombstone). The formatter
   *  needs it to tell "edge removed" from "row touched". */
  op: string;
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
  /** `ops.key` verbatim (the natural key). '' means machine-wide. */
  workstream: string | null;
  /** `ops.actor`, which IS nullable: a captured op outside any actor
   *  context has none. Normalised in `rowFromDb`. */
  source: string | null;
  intent: string | null;
  group_id: string;
  op: string;
  kind: string;
  payload: string;
  created_at: string;
}

/** SELECT clause mapping op columns back onto the legacy log row shape.
 *  `ops.key` already holds the operator-facing workstream name (the
 *  natural key), so there is no join to do; '' means machine-wide and
 *  is normalised back to NULL in `rowFromDb`. */
const SELECT_LOG_COLS = `
  l.seq AS seq,
  l.key AS workstream,
  l.actor AS source,
  l.intent AS intent,
  l.group_id AS group_id,
  l.op AS op,
  l.entity AS kind,
  l.payload AS payload,
  l.created_at AS created_at
`;

const LOG_FROM_JOIN = "FROM ops l";

// WHY THERE IS NO LONGER AN ENTITY FILTER (v2-retire-log-shim)
//
// v2-capture briefly left `ops` holding the SAME change twice: once as
// a typed op from the trigger (intent='task.update', key='demo/t1',
// JSON payload) and once as a prose breadcrumb from `emitEvent`
// (intent=NULL, key='demo', free text). A filter pinning `mu log` to
// the prose entities was needed so a single `task add` did not surface
// twice.
//
// The duplicate prose emits are gone, so the filter's reason to exist
// went with them. `mu log` now reads EVERY op, which is what
// docs/VOCABULARY.md § log entry has always claimed ("a rendered op...
// not a distinct table"). Payloads for captured ops are still raw JSON;
// v2-log-verb renders prose from `intent`. Uglier for now, honest, and
// no longer lossy: a peer's synced ops appear in `mu log` too, which
// prose events could never do (they were machine-local by accident of
// entity='event' not being in SYNCED_ENTITIES).
//
// `latestSeq` deliberately shares this same "no filter" shape. When the
// two disagreed, `mu log --tail` started its cursor past rows the
// non-tail view had shown and silently skipped them.

/** Scope a log query to one workstream.
 *
 *  `ops.key` is the NATURAL key, so it is the bare workstream name for
 *  workstream-scoped rows ('demo') and a qualified ref for everything
 *  inside it ('demo/t1', 'demo/t1#1', 'demo/t2->demo/t1'). Matching
 *  only `key = 'demo'` would therefore hide every task, note, and edge
 *  op in the workstream — which is most of them. Exact-or-prefix is the
 *  smallest predicate that reads "belongs to this workstream". */
function workstreamScopeSql(column = "l.key"): string {
  return `(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`;
}

/** Bind params for `workstreamScopeSql`. The LIKE pattern escapes the
 *  operator-supplied name so a workstream containing '%' or '_' cannot
 *  widen the match. */
function workstreamScopeParams(workstream: string): [string, string] {
  const escaped = workstream.replace(/[\\%_]/g, (c) => `\\${c}`);
  return [workstream, `${escaped}/%`];
}

/**
 * Hide parent-row TOUCH ops from the log surface.
 *
 * Adding a note or an edge bumps its task's `updated_at` so
 * `--sort recency` works. That UPDATE fires the tasks capture trigger,
 * producing a second op in the same group whose payload is ONLY
 * `updated_at` — no new information, and it renders as a duplicate of
 * the note/edge line the operator actually cares about. A `task note`
 * therefore appeared twice in `mu log`.
 *
 * These rows stay in `ops` (they are real state changes, and per-field
 * merge needs them); they are just not LOG LINES. The predicate is
 * shared by `listLogs` and `latestSeq` — those two MUST return the same
 * row set, or `--tail` starts its cursor past rows the non-tail view
 * already showed (hit in R4 and again in R7).
 *
 * `json_extract` is not used: SQLite's JSON1 is compiled in by default
 * for better-sqlite3, but a plain LENGTH test needs no extension and is
 * cheaper. A payload with only `updated_at` is always short.
 */
const TOUCH_OP_FILTER = `NOT (
  l.intent IS NOT NULL
  AND l.op = 'put'
  AND l.payload LIKE '{"updated_at":%'
  AND LENGTH(l.payload) < 45
)`;

/** Sentinel stored in `ops.key` for machine-wide entries (ops.key is
 *  NOT NULL). Exported so the few call sites that query `ops` directly
 *  agree with the shim. */
export const MACHINE_WIDE_KEY = "";

// ─── group-id prefix resolution (shared) ──────────────────────────
//
// Group ids are uuids, which nobody types. `mu undo` prints 8-char
// prefixes and accepts them, so `mu log --group` must too — otherwise the
// documented workflow (`mu undo` to see the id → `mu log --group <id>` to
// inspect it → `mu undo <id> --yes`) breaks in the middle, and it breaks
// SILENTLY: an unmatched prefix returns zero rows, which reads as "this
// group did nothing" rather than "you gave me a prefix I ignored".
// (bug_group_id_prefix_asymmetry — found by following the workflow across
// R9 and R10; each verb was self-consistent on its own.)
//
// This lives HERE, next to the ops reader, so both verbs share ONE
// resolution rule. `src/undo.ts` delegates to it rather than keeping a
// second copy. Same affordance git gives for abbreviated shas, and the
// same shape as `src/tasks/id.ts`'s resolve-or-raise helpers.

/** Raised when a group-id prefix matches more than one group.
 *  Astronomically unlikely with uuids, but silently picking one of two
 *  candidate groups to UNDO is not an acceptable failure mode. */
export class GroupIdAmbiguousError extends Error implements HasNextSteps {
  constructor(
    readonly prefix: string,
    readonly candidates: readonly string[],
  ) {
    super(
      `group id ${JSON.stringify(prefix)} is ambiguous: matches ${candidates.length} groups (${candidates
        .slice(0, 4)
        .map((c) => c.slice(0, 12))
        .join(", ")}${candidates.length > 4 ? ", …" : ""})`,
    );
    this.name = "GroupIdAmbiguousError";
  }

  errorNextSteps(): NextStep[] {
    return [
      { intent: "List recent groups with their ids", command: "mu undo" },
      {
        intent: "Retry with more characters",
        command: `mu log --group ${this.candidates[0] ?? "<full-id>"}`,
      },
    ];
  }
}

/**
 * Resolve a possibly-abbreviated group id to the full one.
 *
 * Returns null when nothing matches, so callers choose their own
 * not-found error (undo raises `UndoGroupNotFoundError`; `mu log`
 * filters to nothing but says so). Throws `GroupIdAmbiguousError` when a
 * prefix matches several groups — that is a genuine conflict the
 * operator must resolve, not something to guess at.
 *
 * An EXACT match always wins over prefix matching, so a full uuid can
 * never be shadowed by a longer id that happens to start with it.
 */
export function groupIdFromPrefix(db: Db, prefix: string): string | null {
  if (prefix === "") return null;
  const rows = db
    .prepare(
      `SELECT DISTINCT group_id AS groupId FROM ops
        WHERE group_id = @exact OR group_id LIKE @prefix || '%' ESCAPE '\\'`,
    )
    .all({ exact: prefix, prefix: prefix.replace(/[\\%_]/g, (c) => `\\${c}`) }) as {
    groupId: string;
  }[];
  const exact = rows.find((r) => r.groupId === prefix);
  if (exact !== undefined) return exact.groupId;
  const first = rows[0];
  if (rows.length === 1 && first !== undefined) return first.groupId;
  if (rows.length === 0) return null;
  throw new GroupIdAmbiguousError(
    prefix,
    rows.map((r) => r.groupId),
  );
}

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
    source: row.source ?? "system",
    intent: row.intent,
    group: row.group_id,
    op: row.op,
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
  /** Structured intent. Set by `emitEvent` for the local-only changes
   *  no trigger can see. Stays null for operator-authored `mu log
   *  write` / `mu agent send` lines, which are prose by nature and have
   *  no state change to name. */
  intent?: string;
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
  const group = randomUUID();
  const result = db
    .prepare(
      `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'put', ?, ?)`,
    )
    .run(
      nextHlc(db),
      machineId(db),
      group,
      opts.source,
      opts.intent ?? null,
      kind,
      key,
      opts.payload,
      createdAt,
    );
  return {
    seq: Number(result.lastInsertRowid),
    workstreamName: opts.workstream,
    source: opts.source,
    intent: opts.intent ?? null,
    group,
    op: "put",
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
  /** Filter by `ops.entity` (the legacy `kind` column). */
  kind?: string;
  /** Filter by structured `ops.intent`, e.g. 'task.close'. */
  intent?: string;
  /** Filter to one undo group (`ops.group_id`). */
  group?: string;
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
    conditions.push(workstreamScopeSql());
    params.push(...workstreamScopeParams(opts.workstream));
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
  if (opts.intent !== undefined) {
    // Accept every historical spelling, so a renamed intent does not
    // truncate the user's history at the release boundary.
    const spellings = intentSpellings(opts.intent);
    conditions.push(`l.intent IN (${spellings.map(() => "?").join(", ")})`);
    params.push(...spellings);
  }
  if (opts.group !== undefined) {
    conditions.push("l.group_id = ?");
    params.push(opts.group);
  }
  // Same predicate as latestSeq — see TOUCH_OP_FILTER.
  conditions.push(TOUCH_OP_FILTER);

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
  // MUST stay consistent with listLogs' row set — this is the cursor
  // INTO it. When the two disagreed (a filter here that listLogs did
  // not apply, or vice versa) `--tail` started past rows the non-tail
  // view had already shown and silently skipped them.
  const row =
    workstream === undefined
      ? (db.prepare(`SELECT MAX(seq) AS s FROM ops l WHERE ${TOUCH_OP_FILTER}`).get() as {
          s: number | null;
        })
      : (db
          .prepare(
            `SELECT MAX(seq) AS s FROM ops l WHERE ${workstreamScopeSql()} AND ${TOUCH_OP_FILTER}`,
          )
          .get(...workstreamScopeParams(workstream)) as { s: number | null });
  return row.s ?? 0;
}

/**
 * Record a change that NO capture trigger can see.
 *
 * The triggers in src/capture.ts cover the four **portable** tables
 * (workstreams, tasks, task_edges, task_notes), so every task and
 * workstream mutation is already an op with a real `intent` and a real
 * natural key. Anything that mutates one of those tables must NOT call
 * this — that was the duplication v2-retire-log-shim deleted: 13 call
 * sites each writing a second, prose, intent-less copy of a change the
 * trigger had already captured properly.
 *
 * What legitimately remains is state that lives OUTSIDE those tables:
 *
 *   agent.*      spawn / close / free / adopt / kick — `agents` is
 *                machine-local (it holds `pane_id`), so there is no
 *                trigger and never will be.
 *   workspace.*  create / free / refresh — `vcs_workspaces`
 *                is machine-local (absolute paths).
 *   agent.stall  a pure observation; nothing is mutated.
 *
 * `intent` is REQUIRED (and typed), not optional, because the whole
 * point is that these rows render through the same formatter as
 * captured ops. An intent-less op cannot be rendered without
 * prefix-matching prose, which is the brittleness
 * (`classifyEventVerb`, `CLAIM_EVENT_PREFIX`) the ops log deletes.
 *
 * These entities are deliberately NOT in SYNCED_ENTITIES: every one of
 * them describes something about THIS machine (a pane id, a filesystem
 * path) that is meaningless on a peer. They are still recorded, so
 * `mu log` and the TUI show them locally.
 */
export function emitEvent(
  db: Db,
  workstream: string | null,
  intent: LocalIntent,
  payload: string,
  source = "system",
): void {
  appendLog(db, { workstream, source, kind: entityForIntent(intent), payload, intent });
}

/**
 * Intents for changes no trigger can capture. Closed union rather than
 * `string` so a typo is a compile error and the set stays auditable —
 * `mu log`'s formatter (v2-log-verb) switches on exactly these.
 */
export type LocalIntent =
  | "agent.spawn"
  | "agent.close"
  | "agent.adopt"
  | "agent.kick"
  | "agent.stall"
  | "workspace.create"
  | "workspace.free"
  | "workspace.refresh";

/** Entity for a local intent: the token before the dot. Keeps
 *  `entity`/`intent` consistent by construction instead of asking each
 *  call site to pass both and agree. */
function entityForIntent(intent: LocalIntent): string {
  const dot = intent.indexOf(".");
  return dot === -1 ? intent : intent.slice(0, dot);
}

// ─── claim attribution ─────────────────────────────────────────────
//
// mu once stored claim attribution as PROSE and re-parsed it: a
// tab-delimited `task.claim<TAB><id><TAB>actor=<a><TAB>...` prefix was
// bolted onto the payload precisely because prefix-matching the prose
// was brittle (review_code_last_claim_actor_brittle). Two helpers then
// existed only to put that prefix on and take it back off.
//
// The ops log makes all of it unnecessary. `withOpContext` seeds
// _op_ctx.actor, the capture trigger copies it into `ops.actor`, and
// the intent is `task.claim`. So attribution is two indexed columns,
// not a string to parse — including on the `--self` path, where
// tasks.owner_id stays NULL by design and the payload therefore
// CANNOT name the actor. Reading ops.actor is the whole fix.

/** The most recent `task.claim` op for a task: its actor and when.
 *
 *  `ops.key` is the natural key, so the task's own ops are keyed
 *  '<ws>/<localId>' exactly — no LIKE, no wildcard escaping, and no
 *  way for `foo` to cross-match `foo_2`. Unbounded by design: the old
 *  limit=100 ceiling silently dropped attribution on long-lived
 *  workstreams. */
function lastClaimOp(
  db: Db,
  workstream: string,
  localId: string,
): { actor: string | null; created_at: string } | null {
  const row = db
    .prepare(
      `SELECT actor, created_at FROM ops
        WHERE key = ? AND intent = 'task.claim'
        ORDER BY seq DESC LIMIT 1`,
    )
    .get(`${workstream}/${localId}`) as { actor: string | null; created_at: string } | undefined;
  return row ?? null;
}

/**
 * Actor of the most recent claim of this task. Surfaces "who is working
 * on this" when `tasks.owner_id IS NULL` — the `--self` anonymous-claim
 * path. Null when the task was never claimed.
 */
export function lastClaimActor(db: Db, workstream: string, localId: string): string | null {
  return lastClaimOp(db, workstream, localId)?.actor ?? null;
}

/**
 * Find the `created_at` timestamp of the most recent claim of a task.
 *
 * Used by `mu task notes --since-claim` to slice the note timeline at
 * the most recent claim, so an operator dispatching a worker sees only
 * the post-claim notes (the spec was written before the claim; the
 * worker's progress lands after).
 *
 * Returns null when the task was never claimed — `--since-claim` then
 * degrades gracefully to no filter.
 */
export function lastClaimEventAt(db: Db, workstream: string, localId: string): string | null {
  return lastClaimOp(db, workstream, localId)?.created_at ?? null;
}

// ─── retired: prose verb classification ───────────────────────────────
//
// The old renderer needed EVENT_VERB_PREFIXES + classifyEventVerb + ClassifiedEvent +
// logRowSubject to render a log line: every consumer prefix-matched a
// payload's leading two words to find its verb, and CLAIM_EVENT_PREFIX
// was bolted on because that matching kept breaking.
//
// v2-log-verb deletes all four. Rendering now reads `intent` (+ `key` +
// named payload fields) in src/log-render.ts, which cannot be broken by
// rewording a payload. If you find yourself wanting to string-match a
// payload to decide what an op IS, that is the bug this removed.
