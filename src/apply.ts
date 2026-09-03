// mu — the APPLY path: how one op lands in the portable tables.
//
// The counterpart to src/capture.ts. Capture answers "a row changed,
// what op records it"; this answers "here is an op, local or from a
// peer, what does the table look like afterwards". v2-sync will call
// `applyOp` once per op it ingests; this module knows nothing about
// segments, files or watermarks.
//
// THE MERGE RULES (docs/VOCABULARY.md; v2-merge-rules)
// ---------------------------------------------------
//   note / message      GROW-ONLY SET. Insert-if-absent by origin
//                       identity. Never updated, so never in conflict.
//   task / workstream   PER-FIELD LWW by HLC. Not row-level.
//   edge                LWW-ELEMENT-SET: add/remove, each carrying an
//                       HLC, so a remove and a re-add order correctly.
//   anything else       NOT SYNCED. Rejected loudly.
//
// WHY PER-FIELD AND NOT ROW-LEVEL
// -------------------------------
// The original design note argued row-level LWW sufficed, because "the
// operating rule is already no concurrent edits to one workstream on two
// machines". That assumption is weak in mu specifically: mu runs
// autonomous agent crews, so a crew on the devserver closing a task
// while the operator edits that same task's impact on a laptop is
// concurrent multi-machine writing BY CONSTRUCTION, not user error.
// Row-level LWW would let the crew's status=CLOSED clobber the
// operator's impact=80, silently, with no conflict reported.
//
// Per-field costs nothing extra here because capture already emits
// SEMANTIC PARTIAL UPDATES: a task.close op carries {"status":"CLOSED"},
// not a row snapshot. So "apply each op's keys in HLC order" IS
// per-field LWW. No column version vectors, no per-column metadata, none
// of the cr-sqlite machinery we rejected.
//
// PROVENANCE: DERIVED FROM THE OPS LOG, NOT STORED
// ------------------------------------------------
// Per-field LWW needs to know, per field, the HLC that last wrote it.
// The obvious shape is a side table keyed (entity, key, field) -> hlc.
// This module does NOT do that, and the reason is worth stating because
// the brief explicitly asked for a justification.
//
// The ops log ALREADY IS the per-field provenance. Every op carries its
// HLC and names exactly the fields it touched, and `idx_ops_entity_key`
// indexes (entity, key). So "the HLC that last wrote field F of key K"
// is a query over the ~handful of ops for K, not a fact needing separate
// storage. Deriving it instead of storing it means:
//
//   * ONE source of truth. A side table is a denormalisation that can
//     disagree with the log, and when it does, every downstream
//     projection (undo, sync) inherits the disagreement. There
//     is no reconciliation procedure that could fix it, because nothing
//     would know which side was right.
//   * Idempotence for free. Re-applying an op compares HLCs against the
//     log, which already contains that op, so a second apply is a no-op
//     by construction rather than by careful bookkeeping. That is what
//     makes "re-read a peer's segment from zero" a safe universal
//     repair.
//   * Resurrection survives deletion for free. See below.
//   * Storage cost: ZERO additional bytes. A side table would cost one
//     row per (key, field) — for the 8 captured columns of `tasks`, 8
//     rows per task, each ~60 bytes of key text plus a ~55-byte HLC, so
//     roughly 1KB per task, unbounded in the number of tasks and
//     duplicating data already on disk in `ops`.
//
// Measured cost of deriving: ~10us per key against a 16000-op / 2000-task
// log (index seek over that key's ~8 ops). Ingest is already doing a
// write per op, so this is not the bottleneck, and it buys the absence of
// a whole class of drift bug. If a profile ever says otherwise, the fix
// is a materialised cache keyed off `ops.seq` that can be rebuilt from
// the log — which is exactly the kind of thing to add when measured, not
// before.
//
// RESURRECTION vs A STALE PUT
// ---------------------------
// After a `del`, a LATER `put` must recreate the row (a legitimate
// re-add), while an EARLIER `put` arriving late must not. Distinguishing
// them requires provenance that outlives the row — and derived
// provenance does, automatically, because `ops` rows are never deleted
// when a table row is. A stored side table would have to be deliberately
// NOT cleaned up on delete, which is a rule someone eventually
// "optimises" away.
//
// TOMBSTONES ARE JUST OPS (v2-tombstones)
// ---------------------------------------
// There is no tombstone table. `op='del'` rows ARE the tombstones,
// ordinary ops carrying an HLC, so out-of-order arrival is just "compare
// HLCs" — the same comparison the update path does. A late `put` older
// than a seen `del` loses; a `del` older than a seen `put` loses. One
// code path, no special casing.

import { type Db, SYNCED_ENTITIES, type SyncedEntity } from "./db.js";
import { compareHlc } from "./hlc.js";
import { LEGACY_LOG_ONLY_SQL_EXCLUSION } from "./legacy-ops.js";
import { withCaptureSuppressed } from "./op-context.js";
import { normalizeTaskStatus } from "./tasks/status.js";

/** An op as applied. Mirrors the `ops` row shape, minus the local-only
 *  `seq` (meaningless on a peer) and the advisory `created_at`. */
export interface Op {
  /** The ordering key. See docs/VOCABULARY.md § HLC. */
  hlc: string;
  /** Which peer minted it. Half of the (machine_id, hlc) identity. */
  machineId: string;
  /** One user-visible action, for `mu undo`. */
  groupId: string;
  /** Free text: agent name, "user", "system". */
  actor?: string | null;
  /** Semantic label, e.g. "task.close". */
  intent?: string | null;
  /** Which kind of thing this op addresses. */
  entity: string;
  /** The NATURAL key. Never a surrogate id. */
  key: string;
  /** 'put' = semantic partial update, 'del' = tombstone. */
  op: "put" | "del";
  /** JSON object of ONLY the fields this op touched. */
  payload: string;
}

/** Thrown when an op names an entity that must never cross machines.
 *  Loud by design: silently ignoring one would mean a peer is running
 *  a different notion of what syncs, which is a bug we want reported,
 *  not absorbed. */
export class OpEntityNotSyncedError extends Error {
  constructor(readonly entity: string) {
    super(
      `op entity ${JSON.stringify(entity)} is not synced and must never arrive from a peer ` +
        `(expected one of: ${SYNCED_ENTITIES.join(", ")})`,
    );
    this.name = "OpEntityNotSyncedError";
  }
}

/** Thrown when an op's natural key does not parse for its entity. */
export class OpKeyMalformedError extends Error {
  constructor(
    readonly entity: string,
    readonly key: string,
  ) {
    super(`malformed ${entity} key: ${JSON.stringify(key)}`);
    this.name = "OpKeyMalformedError";
  }
}

/** What `applyOp` did, so callers (and tests) can assert on outcomes
 *  rather than re-querying. */
export interface ApplyResult {
  /** True iff the DB changed. False for a losing op, a duplicate, or a
   *  no-op — all three are legitimate and non-exceptional. */
  changed: boolean;
  /** Fields actually written, for a 'put' on task / workstream. Empty
   *  when every field in the payload lost its HLC comparison. */
  appliedFields: string[];
  /** Why nothing happened, when `changed` is false. */
  skipped?: "older-than-tombstone" | "older-than-current" | "already-present" | "absent";
}

function isSyncedEntity(entity: string): entity is SyncedEntity {
  return (SYNCED_ENTITIES as readonly string[]).includes(entity);
}

// ─── Derived provenance ───────────────────────────────────────────────

/**
 * The newest HLC among ops for `key` that touched `field`, or null if no
 * op ever has. Ops are the provenance (see the module comment), so this
 * is a plain indexed query rather than a lookup in a side table.
 *
 * `json_type(payload, '$.field') IS NOT NULL` is the presence test, NOT
 * `json_extract(...) IS NOT NULL`. json_extract returns SQL NULL both
 * for an absent key and for a key whose value IS null, which would make
 * a set-to-NULL op invisible to its own provenance — the field would
 * then be permanently rewritable by any older op. json_type returns the
 * string 'null' for a present-but-null member and SQL NULL only when
 * the member is genuinely absent, so it distinguishes the two.
 *
 * The `hlc <> @self` exclusion makes re-application idempotent: an op
 * already in the log must not count itself as a competing writer, or a
 * second apply would compare its HLC against itself and lose.
 */
function fieldHlc(db: Db, op: Op, field: string): string | null {
  const row = db
    .prepare(
      `SELECT MAX(hlc) AS hlc
         FROM ops
        WHERE entity = @entity
          AND key    = @key
          AND op     = 'put'
          AND hlc   <> @self
          AND ${LEGACY_LOG_ONLY_SQL_EXCLUSION}
          AND json_type(payload, '$.' || @field) IS NOT NULL`,
    )
    .get({ entity: op.entity, key: op.key, self: op.hlc, field }) as
    | { hlc: string | null }
    | undefined;
  return row?.hlc ?? null;
}

/**
 * The newest tombstone HLC for this key, or null if it was never
 * deleted. This is the whole of tombstone handling: a `del` is an
 * ordinary op, so "has this been deleted, and when" is one MAX().
 */
function tombstoneHlc(db: Db, op: Op): string | null {
  const row = db
    .prepare(
      `SELECT MAX(hlc) AS hlc
         FROM ops
        WHERE entity = @entity AND key = @key AND op = 'del' AND hlc <> @self`,
    )
    .get({ entity: op.entity, key: op.key, self: op.hlc }) as { hlc: string | null } | undefined;
  return row?.hlc ?? null;
}

/** The newest HLC of any op for this key, whatever kind. Used by the
 *  grow-only and element-set paths, which care about the row's
 *  existence rather than individual fields. */
function anyHlc(db: Db, op: Op, kind: "put" | "del"): string | null {
  const row = db
    .prepare(
      `SELECT MAX(hlc) AS hlc
         FROM ops
        WHERE entity = @entity AND key = @key AND op = @kind AND hlc <> @self`,
    )
    .get({ entity: op.entity, key: op.key, kind, self: op.hlc }) as
    | { hlc: string | null }
    | undefined;
  return row?.hlc ?? null;
}

/** True iff `candidate` is strictly newer than `incumbent`. A null
 *  incumbent means "nothing has written this yet", so anything wins. */
function wins(candidate: string, incumbent: string | null): boolean {
  if (incumbent === null) return true;
  return compareHlc(candidate, incumbent) > 0;
}

// ─── Payload decoding ─────────────────────────────────────────────────

/** A payload field and its value. `value` may legitimately be null —
 *  that is a set-to-NULL, not an absent field. */
type PayloadEntry = readonly [field: string, value: string | number | null];

/**
 * Decode a payload into ordered entries.
 *
 * Deliberately hand-rolled over `Object.entries(JSON.parse(...))`
 * only in that it validates shape and narrows types; the important part
 * is what it does NOT do: it never uses `json_patch` to merge a payload
 * into a row. json_patch implements RFC 7396, where a null member means
 * DELETE THIS KEY, so `json_patch('{"owner_id":7}', '{"owner_id":null}')`
 * returns `{}` — the set-to-NULL is silently discarded rather than
 * applied. Since capture emits exactly `{"owner_id":null}` when a claim
 * is released, using json_patch anywhere on the apply path would drop
 * every set-to-NULL transition in the system. Fields are applied one at
 * a time with explicit parameter binding instead.
 */
function decodePayload(payload: string): PayloadEntry[] {
  const parsed: unknown = JSON.parse(payload);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError(`op payload must be a JSON object, got ${payload.slice(0, 40)}`);
  }
  const entries: PayloadEntry[] = [];
  for (const [field, value] of Object.entries(parsed)) {
    if (value === null || typeof value === "string" || typeof value === "number") {
      entries.push([field, value]);
      continue;
    }
    if (typeof value === "boolean") {
      // SQLite has no boolean type; capture never emits one, but a
      // hand-written or future op might.
      entries.push([field, value ? 1 : 0]);
      continue;
    }
    throw new SyntaxError(`op payload field ${JSON.stringify(field)} has unsupported type`);
  }
  return entries;
}

// ─── Natural key parsing ──────────────────────────────────────────────
//
// The inverse of src/capture.ts's key builders. Kept here rather than
// shared with capture because capture composes keys in SQL and this
// decomposes them in TS; a "shared" helper would be two functions in one
// file pretending to be one thing.

/** `<workstream>/<local_id>` -> its parts. Task ids match
 *  `[a-z][a-z0-9_-]*`, so they never contain '/', making the FIRST '/'
 *  the unambiguous separator. */
function parseTaskKey(key: string): { workstream: string; localId: string } {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) throw new OpKeyMalformedError("task", key);
  const workstream = key.slice(0, slash);
  const localId = key.slice(slash + 1);
  if (workstream.length === 0 || localId.length === 0) {
    throw new OpKeyMalformedError("task", key);
  }
  return { workstream, localId };
}

/** `<task-key>#<origin-id>` -> the task key it hangs off. Task ids
 *  cannot contain '#', so the LAST '#' separates. The origin id is
 *  validated as present (a key without one is malformed) but not
 *  returned: it identifies the note on its ORIGIN machine only, and
 *  `applyNotePut` uses content identity instead. See its comment. */
function parseNoteKey(key: string): { taskKey: string } {
  const hash = key.lastIndexOf("#");
  if (hash <= 0 || hash === key.length - 1) throw new OpKeyMalformedError("note", key);
  return { taskKey: key.slice(0, hash) };
}

/** `<blocker>-><blocked>` -> its parts. Task ids MAY end in '-', so
 *  `demo/a-->demo/b` is a valid key for blocker `demo/a-`; splitting on
 *  the FIRST '->' recovers that correctly, whereas a naive split('->')
 *  would produce three fragments. */
function parseEdgeKey(key: string): { blocker: string; blocked: string } {
  const arrow = key.indexOf("->");
  if (arrow <= 0) throw new OpKeyMalformedError("edge", key);
  const blocker = key.slice(0, arrow);
  const blocked = key.slice(arrow + 2);
  if (blocker.length === 0 || blocked.length === 0) throw new OpKeyMalformedError("edge", key);
  return { blocker, blocked };
}

// ─── Row helpers ──────────────────────────────────────────────────────

/**
 * Columns that must never be written from an op.
 *
 *   owner_id  is an FK into the machine-local `agents` table, so
 *             OWNERSHIP DOES NOT SYNC (src/db.ts § MACHINE_LOCAL_TABLES
 *             spells out why). It is CAPTURED, for local history and
 *             undo, but applying a peer's owner_id would at best point
 *             at an unrelated local agent and at worst violate the FK
 *             outright — verified: inserting a task with an owner_id
 *             absent from `agents` fails with 'FOREIGN KEY constraint
 *             failed'. Stripping it structurally is the only correct
 *             move, and it makes the FK a backstop rather than a trap.
 *   local_id / name
 *             are encoded in the natural key. Taking them from the
 *             payload would let a op rename the row out from under its
 *             own key.
 */
const NEVER_APPLY = new Set(["owner_id", "local_id", "name", "id", "workstream_id", "task_id"]);

/** Ensure the workstream row exists, returning its surrogate id. Rows
 *  arrive out of order across entities (a task op can precede its
 *  workstream op), so the apply path creates the parent on demand
 *  rather than rejecting. The subsequent workstream op then fills in
 *  its real fields by ordinary per-field LWW. */
function ensureWorkstreamRow(db: Db, name: string): number {
  const existing = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  db.prepare("INSERT INTO workstreams (name, created_at) VALUES (?, ?)").run(
    name,
    new Date().toISOString(),
  );
  const created = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (!created) throw new Error(`failed to create workstream row for ${name}`);
  return created.id;
}

/** Surrogate id for a task natural key, or null when absent. */
function taskRowId(db: Db, key: string): number | null {
  const { workstream, localId } = parseTaskKey(key);
  const row = db
    .prepare(
      `SELECT t.id AS id
         FROM tasks t
         JOIN workstreams w ON w.id = t.workstream_id
        WHERE w.name = ? AND t.local_id = ?`,
    )
    .get(workstream, localId) as { id: number } | undefined;
  return row?.id ?? null;
}

// ─── Entity appliers ──────────────────────────────────────────────────

/** PER-FIELD LWW for one row of a table with a natural key.
 *
 *  For each field in the payload, apply it only if this op's HLC beats
 *  the newest HLC that previously wrote THAT FIELD. Fields are
 *  independent, so one op can win on `status` and lose on `impact` in
 *  the same call — which is exactly the concurrent-crew case. */
function applyFieldLww(
  db: Db,
  op: Op,
  table: "tasks" | "workstreams",
  rowId: number,
  entries: readonly PayloadEntry[],
): string[] {
  const applied: string[] = [];
  for (const [field, value] of entries) {
    if (NEVER_APPLY.has(field)) continue;
    if (!wins(op.hlc, fieldHlc(db, op, field))) continue;

    // The HLC says this op may write the field. Before doing so, check
    // whether the field ALREADY holds this value.
    //
    // This is what makes re-application a true no-op rather than a
    // redundant rewrite that merely happens to be value-stable. The HLC
    // comparison alone cannot tell "first apply" from "second apply",
    // because provenance deliberately excludes the op's own HLC (so that
    // record-then-apply and apply-then-record behave identically). Value
    // equality is the honest signal: nothing changed, so report nothing
    // changed. Callers use `changed` to decide whether to log or refresh,
    // and a spurious true would make `mu sync` claim work it did not do.
    //
    // Identifier is not user input: `field` is filtered against the
    // table's real column list by `filterAppliable` before we get here.
    const current = db.prepare(`SELECT ${field} AS v FROM ${table} WHERE id = ?`).get(rowId) as
      | { v: string | number | null }
      | undefined;
    if (current !== undefined && current.v === value) continue;

    db.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`).run(value, rowId);
    applied.push(field);
  }
  return applied;
}

/** The columns each portable table will accept from an op. Anything
 *  else in a payload is ignored rather than fatal: a peer on a newer mu
 *  may legitimately send fields we do not know yet, and dropping them
 *  is strictly better than refusing the whole op. */
const APPLIABLE_COLUMNS: Record<"tasks" | "workstreams", readonly string[]> = {
  tasks: ["title", "status", "impact", "effort_days", "created_at", "updated_at"],
  workstreams: ["created_at"],
};

function filterAppliable(
  table: "tasks" | "workstreams",
  entries: readonly PayloadEntry[],
): PayloadEntry[] {
  const allowed = APPLIABLE_COLUMNS[table];
  return entries.filter(([field]) => allowed.includes(field));
}

function applyTaskPut(db: Db, op: Op): ApplyResult {
  const { workstream, localId } = parseTaskKey(op.key);
  // v9 peers and retained history may still carry removed lifecycle
  // values. Normalize only the decoded projection: callers record the
  // original payload unchanged, preserving the historical evidence.
  const entries = filterAppliable("tasks", decodePayload(op.payload)).map(([field, value]) =>
    field === "status" && typeof value === "string"
      ? ([field, normalizeTaskStatus(value)] as const)
      : ([field, value] as const),
  );

  const existing = taskRowId(db, op.key);
  if (existing === null) {
    // Row absent. Either it was never created here, or it was deleted.
    // A tombstone NEWER than this put means the delete wins and the row
    // stays gone; an OLDER tombstone means this is a legitimate
    // resurrection. Identical comparison either way — that is the point
    // of tombstones being ordinary ops.
    const tomb = tombstoneHlc(db, op);
    if (tomb !== null && !wins(op.hlc, tomb)) {
      return { changed: false, appliedFields: [], skipped: "older-than-tombstone" };
    }
    // Create the row, then let per-field LWW fill it in. The insert uses
    // placeholder values for NOT NULL columns so a partial payload
    // cannot fail the insert; every field the op actually carries is
    // written by applyFieldLww below, and any it does not carry will be
    // filled by whichever op does.
    const wsId = ensureWorkstreamRow(db, workstream);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days,
                          owner_id, created_at, updated_at)
       VALUES (?, ?, ?, 'OPEN', 50, 1, NULL, ?, ?)`,
    ).run(wsId, localId, localId, now, now);
    const rowId = taskRowId(db, op.key);
    if (rowId === null) throw new Error(`failed to create task row for ${op.key}`);
    // Force every carried field on: the row was just created, so there
    // is no incumbent value worth preserving, but the HLC comparison
    // still runs so a stale op cannot overwrite a newer one that
    // arrived first and created the row.
    const applied = applyFieldLww(db, op, "tasks", rowId, entries);
    return { changed: true, appliedFields: applied };
  }

  const applied = applyFieldLww(db, op, "tasks", existing, entries);
  return applied.length > 0
    ? { changed: true, appliedFields: applied }
    : { changed: false, appliedFields: [], skipped: "older-than-current" };
}

function applyWorkstreamPut(db: Db, op: Op): ApplyResult {
  const name = op.key;
  if (name.length === 0) throw new OpKeyMalformedError("workstream", name);
  const entries = filterAppliable("workstreams", decodePayload(op.payload));

  const existing = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (!existing) {
    const tomb = tombstoneHlc(db, op);
    if (tomb !== null && !wins(op.hlc, tomb)) {
      return { changed: false, appliedFields: [], skipped: "older-than-tombstone" };
    }
    const id = ensureWorkstreamRow(db, name);
    const applied = applyFieldLww(db, op, "workstreams", id, entries);
    return { changed: true, appliedFields: applied };
  }
  const applied = applyFieldLww(db, op, "workstreams", existing.id, entries);
  return applied.length > 0
    ? { changed: true, appliedFields: applied }
    : { changed: false, appliedFields: [], skipped: "older-than-current" };
}

/** GROW-ONLY SET. A note is written once and never updated, so there is
 *  no conflict to resolve — only "is it already here".
 *
 *  IDENTITY IS THE NOTE'S CONTENT, not a surrogate id. A note's local
 *  `task_notes.id` is assigned by whichever machine inserted it, so the
 *  same logical note has different ids on different machines and the id
 *  cannot be the identity. The op key embeds the ORIGIN id
 *  (`demo/a#12`), which identifies it on its origin machine, but a peer
 *  cannot map that onto a local row without storing a mapping table.
 *
 *  So identity is `(task, author, content)`. Notes are immutable
 *  append-only prose, which makes this sound: if a note with the same
 *  author and text already hangs off the same task, applying again is
 *  genuinely a no-op. The honest cost is that two INDEPENDENTLY authored
 *  notes with byte-identical author and text on one task converge to a
 *  single row. For a grow-only set of immutable human notes that is a
 *  reasonable dedupe rather than data loss, and it is the price of not
 *  carrying an origin-id mapping table purely to distinguish two
 *  indistinguishable strings. */
function applyNotePut(db: Db, op: Op): ApplyResult {
  const { taskKey } = parseNoteKey(op.key);
  const taskId = taskRowId(db, taskKey);
  if (taskId === null) {
    // Parent task not here — either its op has not arrived yet, or it
    // was deleted. Notes are FK-bound to a task, so there is nowhere to
    // put this. Skipped rather than fatal: re-reading the peer's segment
    // replays the task op first and this lands then.
    return { changed: false, appliedFields: [], skipped: "absent" };
  }

  const entries = decodePayload(op.payload);
  const author = entries.find(([f]) => f === "author")?.[1] ?? null;
  const content = entries.find(([f]) => f === "content")?.[1] ?? "";
  const createdAt = entries.find(([f]) => f === "created_at")?.[1] ?? new Date().toISOString();
  const authorText = author === null ? null : String(author);

  const already = db
    .prepare(
      `SELECT 1 AS present FROM task_notes
        WHERE task_id = @taskId AND content = @content
          AND COALESCE(author, '') = COALESCE(@author, '')
        LIMIT 1`,
    )
    .get({ taskId, content: String(content), author: authorText }) as
    | { present: number }
    | undefined;
  if (already) return { changed: false, appliedFields: [], skipped: "already-present" };

  // A note deleted by a NEWER tombstone must not be re-inserted by a
  // late-arriving put. Same comparison as every other entity.
  const tomb = tombstoneHlc(db, op);
  if (tomb !== null && !wins(op.hlc, tomb)) {
    return { changed: false, appliedFields: [], skipped: "older-than-tombstone" };
  }

  db.prepare(
    "INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)",
  ).run(taskId, authorText, String(content), String(createdAt));
  return { changed: true, appliedFields: ["content"] };
}

/** LWW-ELEMENT-SET. An edge is a set member: present or absent, with no
 *  fields worth merging. So add and remove each carry an HLC and the
 *  newer one wins — a remove followed by a re-add converges to present,
 *  and the reverse converges to absent, in either arrival order. */
function applyEdgePut(db: Db, op: Op): ApplyResult {
  const { blocker, blocked } = parseEdgeKey(op.key);
  const fromId = taskRowId(db, blocker);
  const toId = taskRowId(db, blocked);
  if (fromId === null || toId === null) {
    return { changed: false, appliedFields: [], skipped: "absent" };
  }
  const removedAt = anyHlc(db, op, "del");
  if (removedAt !== null && !wins(op.hlc, removedAt)) {
    return { changed: false, appliedFields: [], skipped: "older-than-tombstone" };
  }
  const existing = db
    .prepare("SELECT 1 AS present FROM task_edges WHERE from_task_id = ? AND to_task_id = ?")
    .get(fromId, toId) as { present: number } | undefined;
  if (existing) return { changed: false, appliedFields: [], skipped: "already-present" };

  const entries = decodePayload(op.payload);
  const createdAt = entries.find(([f]) => f === "created_at")?.[1] ?? new Date().toISOString();
  db.prepare("INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)").run(
    fromId,
    toId,
    String(createdAt),
  );
  return { changed: true, appliedFields: ["created_at"] };
}

/** A tombstone. Applies iff it is newer than every put for this key —
 *  the mirror image of the put path's tombstone check, which is why
 *  there is no special casing between them. */
function applyDel(db: Db, op: Op): ApplyResult {
  const newestPut = anyHlc(db, op, "put");
  if (newestPut !== null && !wins(op.hlc, newestPut)) {
    // A put NEWER than this delete already happened: the row is alive
    // and must stay so. The tombstone is still recorded in `ops` (by
    // the caller), so it participates in later comparisons.
    return { changed: false, appliedFields: [], skipped: "older-than-current" };
  }

  switch (op.entity) {
    case "workstream": {
      // FK CASCADE removes the tasks, notes and edges beneath it.
      const r = db.prepare("DELETE FROM workstreams WHERE name = ?").run(op.key);
      return {
        changed: r.changes > 0,
        appliedFields: [],
        ...(r.changes > 0 ? {} : { skipped: "absent" as const }),
      };
    }
    case "task": {
      const rowId = taskRowId(db, op.key);
      if (rowId === null) return { changed: false, appliedFields: [], skipped: "absent" };
      db.prepare("DELETE FROM tasks WHERE id = ?").run(rowId);
      return { changed: true, appliedFields: [] };
    }
    case "note": {
      const { taskKey } = parseNoteKey(op.key);
      const taskId = taskRowId(db, taskKey);
      if (taskId === null) return { changed: false, appliedFields: [], skipped: "absent" };
      // A note's local surrogate id is not the origin's, so delete by
      // the content identity the grow-only insert used.
      const src = db
        .prepare(
          `SELECT payload FROM ops
            WHERE entity = 'note' AND key = @key AND op = 'put'
            ORDER BY hlc DESC LIMIT 1`,
        )
        .get({ key: op.key }) as { payload: string } | undefined;
      if (!src) return { changed: false, appliedFields: [], skipped: "absent" };
      const entries = decodePayload(src.payload);
      const content = entries.find(([f]) => f === "content")?.[1] ?? "";
      const author = entries.find(([f]) => f === "author")?.[1] ?? null;
      const r = db
        .prepare(
          `DELETE FROM task_notes
            WHERE task_id = @taskId AND content = @content
              AND COALESCE(author, '') = COALESCE(@author, '')`,
        )
        .run({
          taskId,
          content: String(content),
          author: author === null ? null : String(author),
        });
      return {
        changed: r.changes > 0,
        appliedFields: [],
        ...(r.changes > 0 ? {} : { skipped: "absent" as const }),
      };
    }
    case "edge": {
      const { blocker, blocked } = parseEdgeKey(op.key);
      const fromId = taskRowId(db, blocker);
      const toId = taskRowId(db, blocked);
      if (fromId === null || toId === null) {
        return { changed: false, appliedFields: [], skipped: "absent" };
      }
      const r = db
        .prepare("DELETE FROM task_edges WHERE from_task_id = ? AND to_task_id = ?")
        .run(fromId, toId);
      return {
        changed: r.changes > 0,
        appliedFields: [],
        ...(r.changes > 0 ? {} : { skipped: "absent" as const }),
      };
    }
    default:
      // 'message' has no portable table to delete from.
      return { changed: false, appliedFields: [], skipped: "absent" };
  }
}

// ─── The seam ─────────────────────────────────────────────────────────

/**
 * Apply one op to the portable tables.
 *
 * SYNCHRONOUS, for the same reason `withOpContext` is: the op context is
 * a per-connection temp table, so two interleaved async apply scopes
 * would clobber each other's `applying` flag with no way to tell whose
 * suppression was in force. Keeping this sync makes that
 * unrepresentable rather than merely discouraged.
 *
 * Runs inside `withCaptureSuppressed`, which is THE echo guard: without
 * it, writing a peer's op to `tasks` would fire the capture trigger,
 * mint a fresh local op, flush that back to the peer, and loop forever.
 *
 * Does NOT insert the op into `ops` — that is the caller's job (v2-sync,
 * which owns segment bookkeeping and the (machine_id, hlc) dedupe). This
 * function is deliberately only "make the tables reflect this op", so it
 * can be called on a replay of ops already in the log without
 * double-recording them. Provenance queries exclude the op's own HLC
 * precisely so the order of those two steps does not matter.
 *
 * Idempotent: applying the same op twice makes no second change, which
 * is what lets `mu sync --repair` be nothing more than "re-read that
 * peer's segment from zero".
 */
export function applyOp(db: Db, op: Op): ApplyResult {
  if (!isSyncedEntity(op.entity)) throw new OpEntityNotSyncedError(op.entity);

  return withCaptureSuppressed(db, () => {
    if (op.op === "del") return applyDel(db, op);

    switch (op.entity) {
      case "workstream":
        return applyWorkstreamPut(db, op);
      case "task":
        return applyTaskPut(db, op);
      case "note":
        return applyNotePut(db, op);
      case "edge":
        return applyEdgePut(db, op);
      case "message":
        // Log lines live in `ops` only; there is no portable table to
        // project them into. Recording the op IS applying it, and that
        // is the caller's step.
        return { changed: false, appliedFields: [] };
      default:
        throw new OpEntityNotSyncedError(op.entity);
    }
  });
}

// ─── Deferred projection: the out-of-order arrival repair ─────────────

/**
 * Re-project note and edge ops that could not land when they arrived.
 *
 * THE BUG THIS EXISTS TO FIX (v2-sync-workflow-integration)
 * ---------------------------------------------------------
 * `applyNotePut` / `applyEdgePut` return `skipped:"absent"` when the
 * task they hang off is not here YET. That is the right answer at that
 * moment — there is genuinely nowhere to put the row — and their
 * comments promised "re-reading the peer's segment replays the task op
 * first and this lands then". It does not. `ingestSegment` counts an
 * `absent` skip as a successful apply and ADVANCES THE WATERMARK past
 * the line, so the segment is never re-read and the note or edge is
 * never projected. The op IS recorded in local `ops`, so the data is
 * not lost — but the live tables silently diverge, permanently.
 *
 * It is not a corner case. `flushSegment` ships only LOCAL ops, so a
 * machine's segment routinely holds `edge`/`note` ops referring to
 * tasks created in ANOTHER machine's segment, and `syncPass` reads
 * peers in `discoverPeers` order — `localeCompare` over random UUID
 * filenames. Whether the parent arrives first is a coin flip. Measured
 * on 8 fresh fleets: 5 dropped the edge, 3 kept it, correlating exactly
 * with segment filename sort order.
 *
 * WHY REPAIR FROM THE LOG RATHER THAN A RETRY QUEUE
 * -------------------------------------------------
 * A queue of "ops to try again" would be a second source of truth that
 * can disagree with `ops` — the same denormalisation this module's
 * header rejects for provenance, and it would be lost across processes
 * (mu is one short-lived process per invocation, so an in-memory list
 * only ever fixes ops deferred within a SINGLE pass; the parent often
 * arrives the next day). The ops log already knows everything needed,
 * so this asks it directly: which note/edge puts are resolvable NOW but
 * are not projected?
 *
 * "Resolvable now" is doing real work in both queries. Restricting to
 * ops whose parent task rows EXIST means an op orphaned for good (its
 * task was deleted) is not retried on every pass forever, and excluding
 * keys with a NEWER `del` means a legitimately removed edge or note is
 * not resurrected. What is left is exactly the bug's footprint, which
 * in a healthy DB is the empty set — so the normal cost is two indexed
 * queries returning zero rows.
 *
 * Returns the number of ops that changed something, so callers can
 * report it and tests can assert the repair actually fired.
 */
export function reprojectDeferredOps(db: Db): number {
  installOpKeyFunctions(db);
  const rows = [
    ...(db
      .prepare(
        `SELECT o.hlc, o.machine_id, o.group_id, o.actor, o.intent, o.entity,
                o.key, o.op, o.payload
           FROM ops o
           JOIN tasks ft ON ft.local_id = edge_local(o.key, 0)
           JOIN workstreams fw ON fw.id = ft.workstream_id AND fw.name = edge_ws(o.key, 0)
           JOIN tasks tt ON tt.local_id = edge_local(o.key, 1)
           JOIN workstreams tw ON tw.id = tt.workstream_id AND tw.name = edge_ws(o.key, 1)
          WHERE o.entity = 'edge' AND o.op = 'put'
            AND NOT EXISTS (SELECT 1 FROM task_edges e
                             WHERE e.from_task_id = ft.id AND e.to_task_id = tt.id)
            AND NOT EXISTS (SELECT 1 FROM ops d
                             WHERE d.entity = 'edge' AND d.key = o.key
                               AND d.op = 'del' AND d.hlc > o.hlc)`,
      )
      .all() as OpRow[]),
    ...(db
      .prepare(
        `SELECT o.hlc, o.machine_id, o.group_id, o.actor, o.intent, o.entity,
                o.key, o.op, o.payload
           FROM ops o
           JOIN tasks t ON t.local_id = note_local(o.key)
           JOIN workstreams w ON w.id = t.workstream_id AND w.name = note_ws(o.key)
          WHERE o.entity = 'note' AND o.op = 'put'
            AND NOT EXISTS (SELECT 1 FROM task_notes n
                             WHERE n.task_id = t.id
                               AND n.content = COALESCE(json_extract(o.payload, '$.content'), '')
                               AND COALESCE(n.author, '')
                                   = COALESCE(json_extract(o.payload, '$.author'), ''))
            AND NOT EXISTS (SELECT 1 FROM ops d
                             WHERE d.entity = 'note' AND d.key = o.key
                               AND d.op = 'del' AND d.hlc > o.hlc)`,
      )
      .all() as OpRow[]),
  ];
  if (rows.length === 0) return 0;

  let changed = 0;
  for (const row of rows.sort((a, b) => compareHlc(a.hlc, b.hlc))) {
    if (applyOp(db, rowToOp(row)).changed) changed += 1;
  }
  return changed;
}

/** Raw `ops` row shape, as the two repair queries above return it. */
interface OpRow {
  hlc: string;
  machine_id: string;
  group_id: string;
  actor: string | null;
  intent: string | null;
  entity: string;
  key: string;
  op: string;
  payload: string;
}

function rowToOp(row: OpRow): Op {
  return {
    hlc: row.hlc,
    machineId: row.machine_id,
    groupId: row.group_id,
    actor: row.actor,
    intent: row.intent,
    entity: row.entity,
    key: row.key,
    op: row.op === "del" ? "del" : "put",
    payload: row.payload,
  };
}

/**
 * Register the four key-splitting SQL functions the repair queries use.
 *
 * Natural keys are structured text (`<ws>/<local_id>`,
 * `<blocker>-><blocked>`, `<taskKey>#<originId>`) and the parsers here
 * already handle the awkward cases — a local_id containing `/`, an id
 * ending in `-` so `a-->b` splits correctly. Rather than reimplement
 * that splitting in SQL string functions (where it would be a second,
 * subtly different parser), the SAME TypeScript parsers are exposed to
 * SQLite. Deterministic, so SQLite may cache and index against them.
 *
 * Registered lazily by `reprojectDeferredOps` rather than by `openDb`,
 * because `db.ts` imports `capture.ts` and `apply.ts` imports `db.ts` —
 * so an `openDb`-side registration would need db.ts to import this
 * module and close a runtime import cycle. (capture.ts's header records
 * what that costs: `node dist/cli.js` printing nothing at all.)
 * Re-registration is a documented no-op-ish overwrite in better-sqlite3,
 * verified, so calling it per repair pass is safe and cheap.
 */
function installOpKeyFunctions(db: Db): void {
  const safe = <T>(f: () => T): T | null => {
    try {
      return f();
    } catch {
      // A malformed key is not this query's problem: return NULL so the
      // JOIN drops the row rather than failing the whole ingest.
      return null;
    }
  };
  const opts = { deterministic: true, varargs: false } as const;
  db.function("edge_ws", opts, (key: unknown, side: unknown) =>
    safe(() => {
      const parts = parseEdgeKey(String(key));
      return parseTaskKey(Number(side) === 0 ? parts.blocker : parts.blocked).workstream;
    }),
  );
  db.function("edge_local", opts, (key: unknown, side: unknown) =>
    safe(() => {
      const parts = parseEdgeKey(String(key));
      return parseTaskKey(Number(side) === 0 ? parts.blocker : parts.blocked).localId;
    }),
  );
  db.function("note_ws", opts, (key: unknown) =>
    safe(() => parseTaskKey(parseNoteKey(String(key)).taskKey).workstream),
  );
  db.function("note_local", opts, (key: unknown) =>
    safe(() => parseTaskKey(parseNoteKey(String(key)).taskKey).localId),
  );
}

/**
 * Apply many ops in HLC order, inside one transaction.
 *
 * HLC order is what makes per-field LWW correct without any extra
 * bookkeeping: process oldest-first and each field simply ends up
 * holding the newest write. Callers may pass ops in arrival order.
 *
 * Grow-only entities are order-insensitive by construction, so a single
 * sort is enough for every rule here.
 */
export function applyOps(db: Db, ops: readonly Op[]): ApplyResult[] {
  const ordered = [...ops].sort((a, b) => compareHlc(a.hlc, b.hlc));
  const run = db.transaction(() => ordered.map((op) => applyOp(db, op)));
  return run();
}
