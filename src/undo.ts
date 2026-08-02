// mu — undo: emit INVERSE OPS for one group.
//
// THE CHANGE IN SEMANTICS FROM THE OLD UNDO
// ------------------------------
// The old `mu undo --yes` swapped the whole DB file back to a snapshot. That
// reverts your OTHER workstreams too — on the real dogfood DB, 812 tasks
// across three workstreams — so it was a blunt instrument you hesitated
// to reach for. It also did not sync, so a peer kept the mistake.
//
// `mu undo` emits inverse ops for one `group_id`:
//
//   * GRANULAR   — touches only the rows that action touched.
//   * COMPOSABLE — it is itself an ordinary op, in its own group, so it
//                  syncs to peers and is ITSELF UNDOABLE. There is no
//                  separate redo mechanism and no asymmetry between undo
//                  and redo: undoing an undo is just undoing a group.
//   * NO FILES   — no snapshots, no swap, nothing to prune.
//
// HOW AN INVERSE IS COMPUTED
// --------------------------
// Per op in the group, oldest-first:
//
//   put that CREATED the row   -> inverse is `del`
//   put that CHANGED fields    -> inverse is a put restoring the PRIOR
//                                 value of exactly those fields
//   del                        -> inverse is a put restoring the row
//
// "Did this put create the row" is answered by provenance, not by a flag:
// a put created the row iff no op for that key precedes it. "What was
// this field's prior value" is the newest op before this one that named
// that field — the same shape of query src/apply.ts uses for per-field
// LWW, and deliberately the same helper (`priorFieldValue` below is built
// on the provenance query exported for exactly this reason). A second
// implementation of "what was this field before" is how the two drift
// apart, and drift here would mean undo quietly restoring wrong values.
//
// WHY INVERSES GO THROUGH THE NORMAL WRITE PATH
// ---------------------------------------------
// This module MUTATES THE TABLES inside a `withOpContext` scope and lets
// the capture triggers record the result. It does NOT hand-write rows
// into `ops`, and it does NOT use applyOp (which is capture-SUPPRESSED,
// being the ingest path). Consequences, all of them the point:
//
//   * The inverse gets a fresh HLC from the same clock as any other edit,
//     so it is newest and therefore wins per-field LWW.
//   * It is captured like any other change, so it appears in `mu log`,
//     flushes to this machine's segment, and is visible to the drift
//     check. `mu doctor --deep` stays clean after an undo, which is the
//     strongest end-to-end proof available that undo did not corrupt the
//     projection.
//   * It lands in its own group, which is what makes undoing an undo work
//     with no extra machinery.
//
// THE SUPERSESSION DECISION
// -------------------------
// Undoing a group whose rows were changed AGAIN by a later group is the
// hard case. Because the inverse gets a fresh (newest) HLC, it would WIN
// per-field LWW and silently clobber that newer work. Three options:
//
//   (a) clobber silently        — destroys work the operator did after
//                                 the mistake. Unacceptable.
//   (b) skip superseded fields  — "undo" that partially does nothing,
//                                 silently. Equally unacceptable: the
//                                 operator believes the action is undone.
//   (c) REFUSE, name the conflict, require an explicit flag.
//
// (c) is implemented. `planUndo` detects, per field, whether a LATER op
// (from a different group) has written that field since, and reports it
// as a `supersededBy` conflict. `undoGroup` refuses unless
// `opts.force === true`. So the default is safe and loud, and the
// override exists and says what it will destroy. Fail safe, never fail
// silent — the same rule capture follows.
//
// FK ORDERING
// -----------
// A group can span entities: a cascade close writes N task ops, and a
// workstream destroy writes tombstones for the whole tree. Restoring a
// task before its workstream violates the FK, so inverses are applied in
// DEPENDENCY ORDER (workstream -> task -> note/edge), not merely in
// reverse emission order. See ENTITY_RESTORE_ORDER.

import { type Db, resolveWorkstreamId } from "./db.js";
import { groupIdFromPrefix } from "./logs.js";
import { withOpContext } from "./op-context.js";
import type { HasNextSteps, NextStep } from "./output.js";

/** One op as stored, with the provenance we need to invert it. */
interface GroupOpRow {
  seq: number;
  hlc: string;
  group_id: string;
  intent: string | null;
  actor: string | null;
  entity: string;
  key: string;
  op: string;
  payload: string;
  /** Ops for this key with a strictly older HLC. */
  prior: number;
  /** Kind of the NEWEST op preceding this one for the same key, or null
   *  when there is none. 'del' means this put RESURRECTED the row, which
   *  is a creation for undo purposes even though prior > 0. */
  priorKind: string | null;
}

/** What undoing one op will do. */
export interface InverseOp {
  /** Entity of the row being restored/removed. */
  entity: string;
  /** Natural key of that row. */
  key: string;
  /** The inverse action. */
  op: "put" | "del";
  /** Field -> prior value, for a `put`. Empty for a `del`. */
  fields: Record<string, string | number | null>;
  /** Human summary, for the dry-run listing. */
  summary: string;
  /** Fields that a LATER group has written since, with the group that
   *  did. Non-empty means applying this inverse would clobber newer
   *  work. */
  supersededBy: Array<{ field: string; groupId: string; intent: string | null }>;
}

export interface UndoPlan {
  /** The group being undone. */
  groupId: string;
  /** The intent(s) of the ops in the group — what the operator did. */
  intents: readonly string[];
  /** When the group was written (ISO, from the oldest op). */
  when: string;
  /** Inverse ops, in the order they will be applied (FK-safe). */
  inverses: readonly InverseOp[];
  /** True iff any inverse would clobber a newer edit. */
  superseded: boolean;
  /** Ops in the group that need no inverse (already reverted, or a
   *  no-op), for an honest count. */
  skipped: number;
}

export interface UndoResult {
  plan: UndoPlan;
  /** Group id of the ops the UNDO itself wrote — pass this to
   *  `mu undo` to redo. */
  undoGroupId: string;
  /** Inverse ops that actually changed a row. */
  applied: number;
}

/** Raised when the requested group does not exist. */
export class UndoGroupNotFoundError extends Error implements HasNextSteps {
  constructor(readonly groupId: string) {
    super(`no ops found for group ${JSON.stringify(groupId)}`);
    this.name = "UndoGroupNotFoundError";
  }

  errorNextSteps(): NextStep[] {
    return [
      { intent: "List recent undoable groups", command: "mu undo" },
      { intent: "Inspect a group's ops", command: "mu log --group <id>" },
    ];
  }
}

/** Raised when there is nothing to undo at all. */
export class NothingToUndoError extends Error implements HasNextSteps {
  constructor() {
    super("the ops log is empty; nothing to undo");
    this.name = "NothingToUndoError";
  }

  errorNextSteps(): NextStep[] {
    return [{ intent: "Make a change first", command: "mu task add <id> -t <title>" }];
  }
}

/** Raised when the group's rows were changed by a later group, so
 *  undoing would clobber that newer work. */
export class UndoSupersededError extends Error implements HasNextSteps {
  constructor(
    readonly groupId: string,
    readonly conflicts: readonly { key: string; field: string; groupId: string }[],
  ) {
    const shown = conflicts
      .slice(0, 5)
      .map((c) => `${c.key}.${c.field} (changed by ${c.groupId.slice(0, 8)})`)
      .join(", ");
    super(
      `group ${groupId.slice(0, 8)} has been superseded: ${conflicts.length} field(s) were changed ` +
        `by a later action — ${shown}. Undoing would discard that newer work.`,
    );
    this.name = "UndoSupersededError";
  }

  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Inspect what changed since",
        command: `mu log --group ${this.groupId.slice(0, 8)}`,
      },
      {
        intent: "Undo anyway, discarding the newer edits",
        command: `mu undo ${this.groupId.slice(0, 8)} --yes --force`,
      },
    ];
  }
}

// ─── entity ordering ──────────────────────────────────────────────────

/**
 * Dependency order for RESTORING rows. A workstream must exist before its
 * tasks, and a task before its notes and edges, or the FK rejects the
 * insert.
 *
 * Not simply "reverse of emission order": a destroy emits the workstream
 * tombstone FIRST (it is the row the operator deleted; the rest are FK
 * cascade victims), so reversing would try to restore notes before their
 * task. Sorting by entity depth is correct regardless of how the group
 * happened to be emitted.
 */
const ENTITY_RESTORE_ORDER: Record<string, number> = {
  workstream: 0,
  task: 1,
  note: 2,
  edge: 2,
};

/** Deletion is the mirror image: children before parents, so a task's
 *  notes/edges go before the task and the workstream goes last. */
function restoreRank(entity: string): number {
  return ENTITY_RESTORE_ORDER[entity] ?? 3;
}

// ─── provenance ───────────────────────────────────────────────────────

/**
 * The value `field` held for `key` immediately BEFORE `hlc`.
 *
 * This is the provenance query src/apply.ts uses for per-field LWW,
 * pointed backwards: the newest op strictly older than `hlc` that NAMED
 * this field. `json_type(...) IS NOT NULL` rather than
 * `json_extract(...) IS NOT NULL` for the same reason apply does it —
 * json_extract returns SQL NULL both for an absent key and for a
 * present-but-null one, so a set-to-NULL would look absent and we would
 * restore the wrong (older) value.
 *
 * Returns `{ found: false }` when no earlier op named the field, which
 * means the field had no value before this op — so there is nothing to
 * restore and the op must have been part of the row's creation.
 */
export function priorFieldValue(
  db: Db,
  entity: string,
  key: string,
  hlc: string,
  field: string,
): { found: true; value: string | number | null } | { found: false } {
  const row = db
    .prepare(
      `SELECT json_extract(payload, '$.' || @field) AS value
         FROM ops
        WHERE entity = @entity
          AND key    = @key
          AND op     = 'put'
          AND hlc    < @hlc
          AND json_type(payload, '$.' || @field) IS NOT NULL
        ORDER BY hlc DESC
        LIMIT 1`,
    )
    .get({ entity, key, hlc, field }) as { value: string | number | null } | undefined;
  if (row === undefined) return { found: false };
  return { found: true, value: row.value };
}

/** Groups that wrote `field` of `key` AFTER `hlc`. Non-empty means the
 *  field has been superseded since the group we are undoing. */
function laterWriters(
  db: Db,
  entity: string,
  key: string,
  hlc: string,
  field: string,
  excludeGroup: string,
): Array<{ groupId: string; intent: string | null }> {
  return db
    .prepare(
      `SELECT DISTINCT group_id AS groupId, intent
         FROM ops
        WHERE entity   = @entity
          AND key      = @key
          AND op       = 'put'
          AND hlc      > @hlc
          AND group_id <> @excludeGroup
          AND json_type(payload, '$.' || @field) IS NOT NULL`,
    )
    .all({ entity, key, hlc, field, excludeGroup }) as Array<{
    groupId: string;
    intent: string | null;
  }>;
}

/** True iff a later group DELETED this key after `hlc`. Undoing a change
 *  to a row that has since been deleted would resurrect it. */
function laterDeleters(
  db: Db,
  entity: string,
  key: string,
  hlc: string,
  excludeGroup: string,
): Array<{ groupId: string; intent: string | null }> {
  return db
    .prepare(
      `SELECT DISTINCT group_id AS groupId, intent
         FROM ops
        WHERE entity   = @entity
          AND key      = @key
          AND op       = 'del'
          AND hlc      > @hlc
          AND group_id <> @excludeGroup`,
    )
    .all({ entity, key, hlc, excludeGroup }) as Array<{ groupId: string; intent: string | null }>;
}

// ─── group discovery ──────────────────────────────────────────────────

export interface GroupSummary {
  groupId: string;
  /** Distinct intents in the group, in first-seen order. */
  intents: readonly string[];
  actor: string | null;
  /** Ops in the group. */
  ops: number;
  /** ISO timestamp of the group's oldest op. */
  when: string;
  /** Newest HLC in the group, for ordering. */
  hlc: string;
}

/**
 * Recent groups, newest first. This is how group ids become DISCOVERABLE:
 * `mu undo` with no argument lists these, so the operator never has to
 * know a uuid to use the verb.
 *
 * Only groups that touched a portable table are listed, because those are
 * the only ones with anything to invert.
 */
export function listRecentGroups(db: Db, limit = 10): GroupSummary[] {
  const rows = db
    .prepare(
      `SELECT group_id                    AS groupId,
              MAX(hlc)                    AS hlc,
              MIN(created_at)             AS when_,
              COUNT(*)                    AS ops,
              MAX(actor)                  AS actor
         FROM ops
        WHERE entity IN ('workstream','task','note','edge')
        GROUP BY group_id
        ORDER BY MAX(hlc) DESC
        LIMIT @limit`,
    )
    .all({ limit }) as Array<{
    groupId: string;
    hlc: string;
    when_: string;
    ops: number;
    actor: string | null;
  }>;

  return rows.map((row) => {
    const intents = (
      db
        .prepare(
          `SELECT DISTINCT intent FROM ops
            WHERE group_id = @groupId AND intent IS NOT NULL
            ORDER BY seq`,
        )
        .all({ groupId: row.groupId }) as { intent: string }[]
    ).map((r) => r.intent);
    return {
      groupId: row.groupId,
      intents,
      actor: row.actor,
      ops: row.ops,
      when: row.when_,
      hlc: row.hlc,
    };
  });
}

/** The most recent undoable group, or null when there is none. */
export function mostRecentGroup(db: Db): GroupSummary | null {
  return listRecentGroups(db, 1)[0] ?? null;
}

/**
 * Resolve a possibly-abbreviated group id to a full one, or raise.
 *
 * Delegates to `groupIdFromPrefix` (src/logs.ts) so `mu undo` and
 * `mu log --group` accept EXACTLY the same identifiers. They used to
 * disagree: undo resolved prefixes, `mu log --group` compared the column
 * literally and silently returned nothing
 * (bug_group_id_prefix_asymmetry). One rule, two verbs.
 *
 * Ambiguity surfaces as `GroupIdAmbiguousError` (exit 4, a conflict the
 * operator resolves) rather than being folded into not-found.
 */
export function resolveGroupId(db: Db, prefix: string): string {
  const resolved = groupIdFromPrefix(db, prefix);
  if (resolved === null) throw new UndoGroupNotFoundError(prefix);
  return resolved;
}

// ─── planning ─────────────────────────────────────────────────────────

const CAPTURED_TABLE_FOR: Record<string, string> = {
  workstream: "workstreams",
  task: "tasks",
  note: "task_notes",
  edge: "task_edges",
};

/** Fields never restored by an undo, mirroring apply's NEVER_APPLY.
 *  `local_id` / `name` are encoded in the natural key, and `owner_id` is
 *  an FK into machine-local `agents`. */
const NEVER_RESTORE = new Set(["id", "local_id", "name", "workstream_id", "task_id", "owner_id"]);

/**
 * Compute what undoing `groupId` would do, WITHOUT doing it.
 *
 * Pure with respect to the DB: reads only. `mu undo <group>` calls this
 * for its dry run and `undoGroup` calls it again before applying, so the
 * preview and the action can never diverge.
 */
export function planUndo(db: Db, groupId: string): UndoPlan {
  const rows = db
    .prepare(
      `SELECT o.seq, o.hlc, o.group_id, o.intent, o.actor, o.entity, o.key, o.op, o.payload,
              (SELECT COUNT(*) FROM ops p
                WHERE p.entity = o.entity AND p.key = o.key AND p.hlc < o.hlc) AS prior,
              (SELECT p.op FROM ops p
                WHERE p.entity = o.entity AND p.key = o.key AND p.hlc < o.hlc
                ORDER BY p.hlc DESC LIMIT 1) AS priorKind
         FROM ops o
        WHERE o.group_id = @groupId
          AND o.entity IN ('workstream','task','note','edge')
        ORDER BY o.hlc`,
    )
    .all({ groupId }) as GroupOpRow[];

  if (rows.length === 0) throw new UndoGroupNotFoundError(groupId);

  const inverses: InverseOp[] = [];
  let skipped = 0;

  for (const row of rows) {
    if (row.op === "del") {
      // Inverse of a delete: restore the row from the state the log says
      // it had. Reconstruct it by replaying every put for the key that
      // preceded the tombstone, so a partial-update history still yields
      // a complete row.
      const fields = reconstructRow(db, row.entity, row.key, row.hlc);
      const conflicts = laterWriters(db, row.entity, row.key, row.hlc, "__none__", groupId).map(
        (w) => ({ field: "<row>", groupId: w.groupId, intent: w.intent }),
      );
      inverses.push({
        entity: row.entity,
        key: row.key,
        op: "put",
        fields,
        summary: `${row.entity} ${row.key} (from tombstone)`,
        supersededBy: conflicts,
      });
      continue;
    }

    // A put. Did it CREATE the row, or CHANGE fields?
    //
    // Creation is "no prior op at all" OR "the newest prior op was a
    // tombstone" — the latter is a RESURRECTION, which creates the row
    // just as much as a first insert does. Testing only `prior === 0`
    // gets this wrong for the very common case of undoing an undo of a
    // delete: the undo's restoring put has prior ops (the original add
    // and the delete), so it would be treated as a field change and its
    // inverse would restore fields instead of deleting the row.
    if (row.prior === 0 || row.priorKind === "del") {
      // Created it: the inverse is a delete. A later group that wrote
      // this key is a supersession — deleting would discard that work.
      const later = [...laterWriters(db, row.entity, row.key, row.hlc, "__all__", groupId)];
      inverses.push({
        entity: row.entity,
        key: row.key,
        op: "del",
        fields: {},
        summary: `${row.entity} ${row.key} (it was created by this group)`,
        supersededBy: later.map((w) => ({ field: "<row>", groupId: w.groupId, intent: w.intent })),
      });
      continue;
    }

    // Changed fields: restore the prior value of exactly those fields.
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const fields: Record<string, string | number | null> = {};
    const supersededBy: InverseOp["supersededBy"] = [];
    for (const field of Object.keys(payload)) {
      if (NEVER_RESTORE.has(field)) continue;
      const prior = priorFieldValue(db, row.entity, row.key, row.hlc, field);
      if (!prior.found) {
        // No earlier op named this field, so it had no prior value to go
        // back to. Nothing to restore for it.
        continue;
      }
      fields[field] = prior.value;
      for (const writer of laterWriters(db, row.entity, row.key, row.hlc, field, groupId)) {
        supersededBy.push({ field, groupId: writer.groupId, intent: writer.intent });
      }
    }
    // A later DELETE also supersedes: restoring fields on a row that has
    // since been removed would resurrect it.
    for (const deleter of laterDeleters(db, row.entity, row.key, row.hlc, groupId)) {
      supersededBy.push({ field: "<row>", groupId: deleter.groupId, intent: deleter.intent });
    }

    if (Object.keys(fields).length === 0) {
      skipped += 1;
      continue;
    }
    inverses.push({
      entity: row.entity,
      key: row.key,
      op: "put",
      fields,
      summary: `${row.entity} ${row.key} ${Object.entries(fields)
        .map(([f, v]) => `${f}=${v === null ? "NULL" : String(v)}`)
        .join(" ")}`,
      supersededBy,
    });
  }

  // FK-safe ordering. Restores must go parents-first; deletes
  // children-first. Sorting by entity depth is correct regardless of the
  // order the group happened to be emitted in.
  const ordered = [...inverses].sort((a, b) => {
    if (a.op !== b.op) return a.op === "put" ? -1 : 1; // restores before deletes
    const rank =
      a.op === "put"
        ? restoreRank(a.entity) - restoreRank(b.entity)
        : restoreRank(b.entity) - restoreRank(a.entity);
    return rank;
  });

  const intents = [...new Set(rows.map((r) => r.intent).filter((i): i is string => i !== null))];

  return {
    groupId,
    intents,
    when: groupWhen(db, groupId),
    inverses: ordered,
    superseded: ordered.some((i) => i.supersededBy.length > 0),
    skipped,
  };
}

function groupWhen(db: Db, groupId: string): string {
  const row = db
    .prepare("SELECT MIN(created_at) AS when_ FROM ops WHERE group_id = ?")
    .get(groupId) as { when_: string | null } | undefined;
  return row?.when_ ?? "";
}

/**
 * Rebuild the full field set a row had just before `beforeHlc`, by
 * folding every put for that key in HLC order.
 *
 * Necessary because ops are SEMANTIC PARTIAL UPDATES: the tombstone
 * carries no payload and the creating put may have been amended by later
 * partial puts, so no single op holds the whole row. Folding is the only
 * correct reconstruction, and it is the same fold the rebuild path does —
 * just bounded to one key and one point in time.
 */
function reconstructRow(
  db: Db,
  entity: string,
  key: string,
  beforeHlc: string,
): Record<string, string | number | null> {
  const puts = db
    .prepare(
      `SELECT payload FROM ops
        WHERE entity = @entity AND key = @key AND op = 'put' AND hlc < @hlc
        ORDER BY hlc`,
    )
    .all({ entity, key, hlc: beforeHlc }) as { payload: string }[];
  const fields: Record<string, string | number | null> = {};
  for (const put of puts) {
    const parsed = JSON.parse(put.payload) as Record<string, unknown>;
    for (const [field, value] of Object.entries(parsed)) {
      if (NEVER_RESTORE.has(field)) continue;
      if (value === null || typeof value === "string" || typeof value === "number") {
        fields[field] = value;
      }
    }
  }
  return fields;
}

// ─── applying ─────────────────────────────────────────────────────────

export interface UndoOptions {
  /** Apply even when the group has been superseded, discarding the
   *  newer edits to those fields. */
  force?: boolean;
  /** Actor recorded on the undo's own ops. */
  actor?: string | undefined;
}

/**
 * Apply the inverse of `groupId`.
 *
 * Everything happens inside ONE `withOpContext` scope with
 * `group: "new"`, so:
 *   * every inverse write lands in a single new group (making the undo
 *     itself one undoable unit), and
 *   * the capture triggers record each write with a fresh HLC, so the
 *     undo is an ordinary op that syncs and shows up in `mu log`.
 *
 * Wrapped in one transaction: a half-applied undo is worse than none,
 * because the operator would not know which half.
 */
export function undoGroup(db: Db, groupId: string, opts: UndoOptions = {}): UndoResult {
  const plan = planUndo(db, groupId);

  if (plan.superseded && opts.force !== true) {
    const conflicts = plan.inverses.flatMap((inv) =>
      inv.supersededBy.map((s) => ({ key: inv.key, field: s.field, groupId: s.groupId })),
    );
    throw new UndoSupersededError(groupId, conflicts);
  }

  let applied = 0;
  let undoGroupId = "";

  const run = db.transaction(() => {
    withOpContext(
      db,
      { intent: "undo", group: "new", ...(opts.actor !== undefined ? { actor: opts.actor } : {}) },
      () => {
        const ctx = db.prepare("SELECT group_id FROM _op_ctx").get() as
          | { group_id: string | null }
          | undefined;
        undoGroupId = ctx?.group_id ?? "";

        for (const inverse of plan.inverses) {
          if (applyInverse(db, inverse)) applied += 1;
        }
      },
    );
  });
  run();

  return { plan, undoGroupId, applied };
}

/** Apply one inverse by MUTATING THE TABLE, letting capture record it.
 *  Returns true iff a row changed. */
function applyInverse(db: Db, inverse: InverseOp): boolean {
  const table = CAPTURED_TABLE_FOR[inverse.entity];
  if (table === undefined) return false;

  if (inverse.op === "del") return deleteRow(db, inverse);
  return restoreRow(db, inverse, table);
}

function deleteRow(db: Db, inverse: InverseOp): boolean {
  switch (inverse.entity) {
    case "workstream":
      return db.prepare("DELETE FROM workstreams WHERE name = ?").run(inverse.key).changes > 0;
    case "task": {
      const id = taskIdForKey(db, inverse.key);
      if (id === null) return false;
      return db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes > 0;
    }
    case "note": {
      const parsed = parseNoteKey(inverse.key);
      if (parsed === null) return false;
      const taskId = taskIdForKey(db, parsed.taskKey);
      if (taskId === null) return false;
      // Notes have no natural identity beyond their content, so delete by
      // the content the log says this note had.
      const content = db
        .prepare(
          `SELECT json_extract(payload, '$.content') AS content FROM ops
            WHERE entity = 'note' AND key = ? AND op = 'put'
            ORDER BY hlc DESC LIMIT 1`,
        )
        .get(inverse.key) as { content: string | null } | undefined;
      if (content?.content === undefined || content.content === null) return false;
      return (
        db
          .prepare("DELETE FROM task_notes WHERE task_id = ? AND content = ?")
          .run(taskId, content.content).changes > 0
      );
    }
    case "edge": {
      const parsed = parseEdgeKey(inverse.key);
      if (parsed === null) return false;
      const from = taskIdForKey(db, parsed.blocker);
      const to = taskIdForKey(db, parsed.blocked);
      if (from === null || to === null) return false;
      return (
        db.prepare("DELETE FROM task_edges WHERE from_task_id = ? AND to_task_id = ?").run(from, to)
          .changes > 0
      );
    }
    default:
      return false;
  }
}

function restoreRow(db: Db, inverse: InverseOp, table: string): boolean {
  switch (inverse.entity) {
    case "workstream": {
      const exists = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(inverse.key) as
        | { id: number }
        | undefined;
      if (!exists) {
        db.prepare("INSERT INTO workstreams (name, created_at) VALUES (?, ?)").run(
          inverse.key,
          String(inverse.fields.created_at ?? new Date().toISOString()),
        );
        return true;
      }
      return updateFields(db, "workstreams", "id", exists.id, inverse.fields);
    }
    case "task": {
      const parsed = parseTaskKey(inverse.key);
      if (parsed === null) return false;
      const id = taskIdForKey(db, inverse.key);
      if (id === null) {
        // The task row is gone, so this is a restore-from-tombstone. The
        // parent workstream must exist first; it will have been restored
        // already by the entity ordering, but create it if the group
        // only deleted the task.
        const wsId = ensureWorkstream(db, parsed.workstream);
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO tasks (workstream_id, local_id, title, status, impact, effort_days,
                              owner_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run(
          wsId,
          parsed.localId,
          String(inverse.fields.title ?? parsed.localId),
          String(inverse.fields.status ?? "OPEN"),
          Number(inverse.fields.impact ?? 50),
          Number(inverse.fields.effort_days ?? 1),
          String(inverse.fields.created_at ?? now),
          String(inverse.fields.updated_at ?? now),
        );
        return true;
      }
      return updateFields(db, "tasks", "id", id, inverse.fields);
    }
    case "note": {
      const parsed = parseNoteKey(inverse.key);
      if (parsed === null) return false;
      const taskId = taskIdForKey(db, parsed.taskKey);
      if (taskId === null) return false;
      const content = inverse.fields.content;
      if (content === undefined || content === null) return false;
      const exists = db
        .prepare("SELECT id FROM task_notes WHERE task_id = ? AND content = ?")
        .get(taskId, String(content)) as { id: number } | undefined;
      if (exists) return false; // grow-only: already there
      db.prepare(
        "INSERT INTO task_notes (task_id, author, content, created_at) VALUES (?, ?, ?, ?)",
      ).run(
        taskId,
        inverse.fields.author === undefined || inverse.fields.author === null
          ? null
          : String(inverse.fields.author),
        String(content),
        String(inverse.fields.created_at ?? new Date().toISOString()),
      );
      return true;
    }
    case "edge": {
      const parsed = parseEdgeKey(inverse.key);
      if (parsed === null) return false;
      const from = taskIdForKey(db, parsed.blocker);
      const to = taskIdForKey(db, parsed.blocked);
      if (from === null || to === null) return false;
      const exists = db
        .prepare("SELECT 1 AS x FROM task_edges WHERE from_task_id = ? AND to_task_id = ?")
        .get(from, to) as { x: number } | undefined;
      if (exists) return false;
      db.prepare(
        "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
      ).run(from, to, String(inverse.fields.created_at ?? new Date().toISOString()));
      return true;
    }
    default:
      void table;
      return false;
  }
}

/**
 * Restore the named fields in ONE UPDATE.
 *
 * One statement, not one per field, and that matters: each UPDATE fires
 * the capture trigger once, so a per-field loop would emit N ops for a
 * single logical inverse. They would share the undo's group so undo/redo
 * still worked, but `mu log` would show one action as several and the
 * op count would misrepresent what happened. One statement, one op.
 *
 * Fields already holding the target value are dropped from the statement
 * first, so a fully-redundant inverse issues no UPDATE at all and
 * therefore produces no op (matching the capture WHEN guard). Returns
 * true iff a row actually changed, so `applied` never overstates the work.
 */
function updateFields(
  db: Db,
  table: string,
  idColumn: string,
  id: number,
  fields: Record<string, string | number | null>,
): boolean {
  const names = Object.keys(fields).filter((f) => !NEVER_RESTORE.has(f));
  if (names.length === 0) return false;

  const current = db.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ?`).get(id) as
    | Record<string, string | number | null>
    | undefined;

  // Only fields whose value actually differs. Comparing here rather than
  // relying on the trigger keeps `changed` honest for the caller.
  const pending = names.filter((name) => {
    const target = fields[name] ?? null;
    if (current === undefined) return true;
    return current[name] !== target;
  });
  if (pending.length === 0) return false;

  const setClause = pending.map((name) => `${name} = @${name}`).join(", ");
  const params: Record<string, string | number | null> = { id };
  for (const name of pending) params[name] = fields[name] ?? null;
  db.prepare(`UPDATE ${table} SET ${setClause} WHERE ${idColumn} = @id`).run(params);
  return true;
}

function ensureWorkstream(db: Db, name: string): number {
  const existing = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  db.prepare("INSERT INTO workstreams (name, created_at) VALUES (?, ?)").run(
    name,
    new Date().toISOString(),
  );
  return resolveWorkstreamId(db, name);
}

// ─── key parsing (mirrors src/apply.ts) ───────────────────────────────

function parseTaskKey(key: string): { workstream: string; localId: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { workstream: key.slice(0, slash), localId: key.slice(slash + 1) };
}

function parseNoteKey(key: string): { taskKey: string } | null {
  const hash = key.lastIndexOf("#");
  if (hash <= 0) return null;
  return { taskKey: key.slice(0, hash) };
}

function parseEdgeKey(key: string): { blocker: string; blocked: string } | null {
  const arrow = key.indexOf("->");
  if (arrow <= 0) return null;
  return { blocker: key.slice(0, arrow), blocked: key.slice(arrow + 2) };
}

function taskIdForKey(db: Db, key: string): number | null {
  const parsed = parseTaskKey(key);
  if (parsed === null) return null;
  const row = db
    .prepare(
      `SELECT t.id AS id FROM tasks t
         JOIN workstreams w ON w.id = t.workstream_id
        WHERE w.name = ? AND t.local_id = ?`,
    )
    .get(parsed.workstream, parsed.localId) as { id: number } | undefined;
  return row?.id ?? null;
}
