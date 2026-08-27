// mu — op capture: SQLite triggers that record every change to a
// portable table as an op, inside the SAME TRANSACTION as the mutation.
//
// WHY TRIGGERS AND NOT HAND-EMITTED OPS
// -------------------------------------
// Capture fires inside the same transaction as the row change, in the
// same file. So capture is ATOMIC with the change: the two cannot
// drift, not even on power loss mid-write. Either both landed or
// neither did.
//
// Hand-emitted ops (an `emitOp(...)` next to each mutation) were
// rejected because they can be FORGOTTEN. A forgotten op is no
// longer "sync missed something" — undo, sync and history are
// ALL projections of this one log, so one missing op is silent
// corruption of all four at once. A future SDK function that mutates
// `tasks` must not be ABLE to skip capture. Triggers make that
// structural rather than a convention someone has to remember.
//
// WHY THE TRIGGERS ARE TEMP TRIGGERS (the load-bearing surprise)
// -------------------------------------------------------------
// The triggers need per-invocation context (intent / actor / group /
// the echo guard) which lives in the `_op_ctx` TEMP table. SQLite
// REFUSES to let a main-schema trigger reference the temp schema:
//
//   sqlite> CREATE TRIGGER x AFTER INSERT ON tasks
//        >   WHEN (SELECT applying FROM _op_ctx) = 0 ...
//   Error: no such table: main._op_ctx
//   -- and qualifying it explicitly fails differently:
//   Error: trigger x cannot reference objects in database temp
//
// So the triggers themselves must live in the TEMP schema, where the
// temp table IS visible. Verified empirically (see the probe results in
// this task's note). Consequences, all of them fine:
//
//   * Triggers are (re)created per connection, by `installCapture`,
//     which `openDb` calls on every open. There is no persistent
//     trigger in the DB file, so no stale-DDL-in-file problem and no
//     schema-version churn when the trigger set changes.
//   * A connection that never runs `installCapture` captures nothing.
//     That is only reachable inside this codebase (readonly opens), not
//     by a normal `mu` invocation.
//   * A TEMP trigger cannot write to a qualified `main.ops` —
//     "qualified table names are not allowed on INSERT, UPDATE, and
//     DELETE statements within triggers" — so the INSERTs here are
//     UNQUALIFIED and resolve to `main` because no temp table shadows
//     those names. `_op_ctx` / `_op_clock` / `_op_dying` are prefixed
//     to make that shadowing impossible by accident.
//
// SEMANTIC PARTIAL UPDATES — ONLY CHANGED COLUMNS
// -----------------------------------------------
// The UPDATE triggers compare `NEW.<col> IS NOT OLD.<col>` per column
// and build the payload from just the columns that actually changed, so
// `task.close` carries `{"status":"CLOSED"}` and nothing else. This is
// the single detail that makes per-field merge FREE: "apply in HLC
// order" then converges without column version vectors.
//
// Dumping the whole row instead would look identical in every
// single-machine test and silently regress the design from field-level
// to row-level last-writer-wins. mu runs autonomous agent crews, so a
// devserver crew closing a task while the operator edits that task's
// impact on a laptop is concurrent multi-machine writing BY
// CONSTRUCTION. Field-level merge keeps both edits; row-level LWW
// discards one at random. `IS NOT` (not `<>`) because `<>` is NULL for
// a NULL operand, which would drop every set-to-NULL and
// NULL-to-a-value transition — e.g. releasing a claim
// (`owner_id -> NULL`) would never be captured.

// TYPE-ONLY import: db.ts imports this module, so a value import would
// be a runtime cycle (and an import cycle here shows up as `node
// dist/cli.js` printing nothing at all). `typeof PORTABLE_TABLES` is a
// type position, so this is erased at compile time.
import type { PORTABLE_TABLES } from "./db.js";

/** Sentinel key segment for a natural key whose parent row could not be
 *  resolved. Should be unreachable — the dying-ancestor stash below
 *  exists precisely so cascades can still resolve — but a capture that
 *  records a degraded key is strictly better than one that records
 *  nothing, so this FAILS SAFE rather than failing silent. */
const UNRESOLVED = "<unresolved>";

// ─── The op context temp tables ───────────────────────────────────────

/**
 * DDL for the three per-connection temp tables the triggers read.
 * Created by `installCapture` before the triggers that reference them.
 *
 *   _op_ctx    the **op context** (docs/VOCABULARY.md): group_id /
 *              actor / intent / applying. Exactly ONE row, seeded with
 *              defaults so a mutation occurring outside any SDK context
 *              is still CAPTURED, just with a null intent. Fail safe,
 *              never fail silent.
 *
 *   _op_clock  a one-row scratchpad holding "now" for the current
 *              trigger firing. The HLC advance needs to compare `now`
 *              against `last_wall` and then reuse the SAME `now` to
 *              write it; calling unixepoch() twice could straddle a
 *              millisecond boundary and mint a non-monotonic pair. So
 *              the value is stashed once per op and read from here.
 *
 *   _op_dying  natural keys of rows that are mid-DELETE — see the
 *              DELETE section below. Keyed by (kind, id).
 *
 * Temp tables are per-connection and mu is one connection per
 * short-lived process, so there is no cross-process leakage and no
 * cleanup to schedule.
 */
export const OP_CTX_DDL = `
CREATE TEMP TABLE IF NOT EXISTS _op_ctx (
  group_id TEXT,
  actor    TEXT,
  intent   TEXT,
  applying INTEGER NOT NULL DEFAULT 0
);
CREATE TEMP TABLE IF NOT EXISTS _op_clock (
  now_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TEMP TABLE IF NOT EXISTS _op_dying (
  kind TEXT NOT NULL,
  id   INTEGER NOT NULL,
  key  TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
`;

/** Seed the singleton rows. Separate from the DDL because CREATE TABLE
 *  IF NOT EXISTS is idempotent but INSERT is not. */
const OP_CTX_SEED = `
INSERT INTO _op_ctx (group_id, actor, intent, applying)
  SELECT NULL, NULL, NULL, 0 WHERE NOT EXISTS (SELECT 1 FROM _op_ctx);
INSERT INTO _op_clock (now_ms)
  SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM _op_clock);
`;

// ─── Shared SQL fragments ─────────────────────────────────────────────

/** Echo guard. Every trigger carries it. `applying = 1` means we are
 *  INGESTING a peer's op, where writing a fresh local op would be an
 *  echo that propagates back and never terminates. v2-sync sets it. */
const NOT_APPLYING = "(SELECT applying FROM _op_ctx) = 0";

/** Advance the persisted HLC by one tick, then read it back formatted.
 *  Mirrors `nextHlc` in src/hlc.ts EXACTLY — same monotonic rule (if
 *  now > last_wall take now with counter 0, else hold the wall and step
 *  the counter) and same `%015d.%06d.%s` serialization. It is
 *  reimplemented in SQL rather than called from JS because a trigger
 *  cannot call back into JS, and the whole point is that capture
 *  happens inside the mutation's transaction.
 *
 *  Kept honest by test/capture.test.ts, which asserts the SQL-minted
 *  HLC parses with `parseHlc` and interleaves monotonically with
 *  JS-minted ones. If the format changes in one place the other fails. */
const ADVANCE_CLOCK = `
  UPDATE _op_clock SET now_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER);
  UPDATE machine_identity
     SET last_wall    = MAX(last_wall, (SELECT now_ms FROM _op_clock)),
         last_counter = CASE WHEN (SELECT now_ms FROM _op_clock) > last_wall
                             THEN 0 ELSE last_counter + 1 END
   WHERE id = 1;`;

/** The just-advanced HLC, formatted. Must be read AFTER ADVANCE_CLOCK. */
const HLC = `(SELECT printf('%015d.%06d.%s', last_wall, last_counter, machine_id)
                FROM machine_identity WHERE id = 1)`;

/** Column list shared by every op INSERT. */
const OP_COLS = "(hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)";

/** The context/identity columns, in OP_COLS order after `hlc`.
 *  `group_id` falls back to a per-op random hex string so the column is
 *  never NULL: an op outside any SDK context is its own group of one,
 *  which is exactly right for undo. */
const OP_CTX_VALUES = `
  (SELECT machine_id FROM machine_identity WHERE id = 1),
  COALESCE((SELECT group_id FROM _op_ctx), lower(hex(randomblob(8)))),
  (SELECT actor  FROM _op_ctx),
  (SELECT intent FROM _op_ctx)`;

/** ISO-8601 wall time, matching what the SDK writes elsewhere.
 *  Advisory only — `hlc` is the ordering key, this is for humans. */
const CREATED_AT = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

// ─── Natural keys ─────────────────────────────────────────────────────
//
// `ops.key` is ALWAYS the natural key, never a surrogate id. This is
// exactly why mu's keys don't collide across machines the way an
// AUTOINCREMENT rowid would: two machines both minting `tasks.id = 7`
// is inevitable and meaningless, whereas `demo/fix-auth` denotes the
// same task everywhere.
//
//   workstream   <name>                        demo
//   task         <workstream>/<local_id>       demo/fix-auth
//   note         <workstream>/<local_id>#<id>  demo/fix-auth#12
//   edge         <blocker> -> <blocked>        demo/a->demo/b
//
// Notes keep their surrogate `id` as a suffix because a note has no
// natural identity of its own — same author and text twice is two
// notes. Notes are append-only and never edited, so the suffix only
// needs to be locally unique, and `<task-key>#<id>` is.

/** Workstream name for a workstream id, or the dying-stash value if the
 *  workstream row is already gone (FK cascade). */
const wsKey = (idExpr: string): string => `COALESCE(
  (SELECT w.name FROM workstreams w WHERE w.id = ${idExpr}),
  (SELECT d.key FROM _op_dying d WHERE d.kind = 'workstream' AND d.id = ${idExpr}),
  '${UNRESOLVED}')`;

/** `<workstream>/<local_id>` for a task id, falling back to the dying
 *  stash when the task row itself is already gone. */
const taskKey = (idExpr: string): string => `COALESCE(
  (SELECT ${wsKey("t.workstream_id")} || '/' || t.local_id
     FROM tasks t WHERE t.id = ${idExpr}),
  (SELECT d.key FROM _op_dying d WHERE d.kind = 'task' AND d.id = ${idExpr}),
  '${UNRESOLVED}')`;

// ─── Per-table trigger DDL ────────────────────────────────────────────

/** Build the changed-columns-only payload expression for an UPDATE.
 *
 *  Nests one CASE per column around a `json_insert` so a column lands
 *  in the payload only when it actually changed:
 *
 *    CASE WHEN NEW.impact IS NOT OLD.impact
 *         THEN json_insert(<inner>, '$.impact', NEW.impact)
 *         ELSE <inner> END
 *
 *  With six columns and one change that yields a 1-key object. */
function changedPayload(cols: readonly string[]): string {
  let expr = "'{}'";
  for (const col of cols) {
    expr = `CASE WHEN NEW.${col} IS NOT OLD.${col}
                 THEN json_insert(${expr}, '$.${col}', NEW.${col})
                 ELSE ${expr} END`;
  }
  return expr;
}

/** Whole-row payload for an INSERT: an insert changes every column by
 *  definition, so there is nothing to diff against. */
function fullPayload(cols: readonly string[]): string {
  const pairs = cols.map((c) => `'${c}', NEW.${c}`).join(", ");
  return `json_object(${pairs})`;
}

/** `WHEN` clause restricting an UPDATE trigger to real changes. A
 *  no-op UPDATE (SET x = x, or rewriting identical values) produces NO
 *  op at all, which keeps the log free of churn that would otherwise
 *  make every `mu log` read noisy and every sync flush bigger. */
function anyChanged(cols: readonly string[]): string {
  return cols.map((c) => `NEW.${c} IS NOT OLD.${c}`).join("\n        OR ");
}

/** Emit one op. `keyExpr`/`payloadExpr` are SQL expressions. */
function emitOp(
  entity: string,
  opKind: "put" | "del",
  keyExpr: string,
  payloadExpr: string,
): string {
  return `${ADVANCE_CLOCK}
  INSERT INTO ops ${OP_COLS} VALUES (
    ${HLC},${OP_CTX_VALUES},
    '${entity}',
    ${keyExpr},
    '${opKind}',
    ${payloadExpr},
    ${CREATED_AT}
  );`;
}

/** Columns captured per portable table. Deliberately EXCLUDES surrogate
 *  ids and FK columns that are already encoded in the natural key
 *  (`tasks.workstream_id`, `task_notes.task_id`, the edge endpoints),
 *  because shipping a peer our local rowids would be worse than
 *  useless. `tasks.owner_id` IS captured: it is an FK into the
 *  machine-local `agents` table, so it never syncs (see
 *  MACHINE_LOCAL_TABLES), but it must still be captured for local
 *  history and undo of a claim/release. */
const CAPTURED_COLUMNS = {
  workstreams: ["name", "created_at"],
  tasks: [
    "local_id",
    "title",
    "status",
    "impact",
    "effort_days",
    "owner_id",
    "created_at",
    "updated_at",
  ],
  task_notes: ["author", "content", "created_at"],
  task_edges: ["created_at"],
} as const satisfies Record<(typeof PORTABLE_TABLES)[number], readonly string[]>;

/**
 * THE DELETE SUBTLETY
 * -------------------
 * Every other op can resolve its natural key lazily, because the row is
 * still there. DELETE cannot: by the time anything downstream looks,
 * the row is gone. So the key is captured INLINE, in the trigger, while
 * the row still exists.
 *
 * That alone is not enough, because of FK CASCADE. Empirically (this
 * was the thing most worth checking): SQLite FK `ON DELETE CASCADE`
 * DOES fire triggers on the cascaded child rows — and it does so
 * regardless of the `recursive_triggers` pragma, which governs only
 * trigger-initiated recursion, not FK actions. Good: destroying a
 * workstream captures its tasks, notes and edges without any explicit
 * walk in the SDK.
 *
 * The trap is ORDERING. With AFTER DELETE triggers, cascaded children
 * fire after the parent row is already deleted, so joining to the
 * parent to build the child's key yields nothing:
 *
 *   DELETE FROM workstreams WHERE id = 1
 *     -> edge  op key "<unresolved>-><unresolved>"
 *     -> note  op key "<unresolved>#100"
 *     -> task  op key "<unresolved>/t1"
 *
 * Two mechanisms fix it together:
 *
 *   1. BEFORE DELETE, not AFTER. The row and its ancestors are all
 *      still present when the trigger body runs, so `OLD.*` plus a
 *      normal join resolves the key.
 *   2. The `_op_dying` stash. BEFORE DELETE fixes the FIRST level only:
 *      cascade children still fire after their parent's row is gone.
 *      So each parent's BEFORE DELETE trigger records its own natural
 *      key into `_op_dying` before emitting, and the child key
 *      resolvers (`wsKey` / `taskKey`) consult the stash when the live
 *      join misses. Rows are never removed from the stash: it is a
 *      per-connection temp table on a short-lived process, ids are not
 *      reused within a transaction, and an INSERT OR REPLACE keyed on
 *      (kind, id) keeps it correct even if an id is recycled later.
 *
 * The alternative — having the parent trigger emit ops for its whole
 * subtree and suppressing the cascade triggers — also works and was
 * prototyped, but it duplicates the subtree walk in SQL four times and
 * breaks the moment a new FK is added. The stash is smaller and
 * self-maintaining.
 */
const DYING_STASH = (kind: "workstream" | "task", keyExpr: string): string =>
  `INSERT OR REPLACE INTO _op_dying (kind, id, key) VALUES ('${kind}', OLD.id, ${keyExpr});`;

/** All capture triggers, as one idempotent DDL string. */
function buildTriggerDdl(): string {
  const wsCols = CAPTURED_COLUMNS.workstreams;
  const taskCols = CAPTURED_COLUMNS.tasks;
  const noteCols = CAPTURED_COLUMNS.task_notes;
  const edgeCols = CAPTURED_COLUMNS.task_edges;

  const taskKeyNew = `${wsKey("NEW.workstream_id")} || '/' || NEW.local_id`;
  const taskKeyOld = `${wsKey("OLD.workstream_id")} || '/' || OLD.local_id`;
  const edgeKeyNew = `${taskKey("NEW.from_task_id")} || '->' || ${taskKey("NEW.to_task_id")}`;
  const edgeKeyOld = `${taskKey("OLD.from_task_id")} || '->' || ${taskKey("OLD.to_task_id")}`;

  return `
-- ─── workstreams ────────────────────────────────────────────────────
CREATE TEMP TRIGGER IF NOT EXISTS _cap_workstreams_ins
AFTER INSERT ON workstreams WHEN ${NOT_APPLYING}
BEGIN
  ${emitOp("workstream", "put", "NEW.name", fullPayload(wsCols))}
END;

CREATE TEMP TRIGGER IF NOT EXISTS _cap_workstreams_upd
AFTER UPDATE ON workstreams WHEN ${NOT_APPLYING}
  AND (${anyChanged(wsCols)})
BEGIN
  ${emitOp("workstream", "put", "NEW.name", changedPayload(wsCols))}
END;

CREATE TEMP TRIGGER IF NOT EXISTS _cap_workstreams_del
BEFORE DELETE ON workstreams WHEN ${NOT_APPLYING}
BEGIN
  ${DYING_STASH("workstream", "OLD.name")}
  ${emitOp("workstream", "del", "OLD.name", "'{}'")}
END;

-- ─── tasks ──────────────────────────────────────────────────────────
CREATE TEMP TRIGGER IF NOT EXISTS _cap_tasks_ins
AFTER INSERT ON tasks WHEN ${NOT_APPLYING}
BEGIN
  ${emitOp("task", "put", taskKeyNew, fullPayload(taskCols))}
END;

CREATE TEMP TRIGGER IF NOT EXISTS _cap_tasks_upd
AFTER UPDATE ON tasks WHEN ${NOT_APPLYING}
  AND (${anyChanged(taskCols)})
BEGIN
  ${emitOp("task", "put", taskKeyNew, changedPayload(taskCols))}
END;

CREATE TEMP TRIGGER IF NOT EXISTS _cap_tasks_del
BEFORE DELETE ON tasks WHEN ${NOT_APPLYING}
BEGIN
  ${DYING_STASH("task", taskKeyOld)}
  ${emitOp("task", "del", taskKeyOld, "'{}'")}
END;

-- ─── task_notes ─────────────────────────────────────────────────────
CREATE TEMP TRIGGER IF NOT EXISTS _cap_task_notes_ins
AFTER INSERT ON task_notes WHEN ${NOT_APPLYING}
BEGIN
  ${emitOp("note", "put", `${taskKey("NEW.task_id")} || '#' || NEW.id`, fullPayload(noteCols))}
END;

CREATE TEMP TRIGGER IF NOT EXISTS _cap_task_notes_upd
AFTER UPDATE ON task_notes WHEN ${NOT_APPLYING}
  AND (${anyChanged(noteCols)})
BEGIN
  ${emitOp("note", "put", `${taskKey("NEW.task_id")} || '#' || NEW.id`, changedPayload(noteCols))}
END;

CREATE TEMP TRIGGER IF NOT EXISTS _cap_task_notes_del
BEFORE DELETE ON task_notes WHEN ${NOT_APPLYING}
BEGIN
  ${emitOp("note", "del", `${taskKey("OLD.task_id")} || '#' || OLD.id`, "'{}'")}
END;

-- ─── task_edges ─────────────────────────────────────────────────────
CREATE TEMP TRIGGER IF NOT EXISTS _cap_task_edges_ins
AFTER INSERT ON task_edges WHEN ${NOT_APPLYING}
BEGIN
  ${emitOp("edge", "put", edgeKeyNew, fullPayload(edgeCols))}
END;

CREATE TEMP TRIGGER IF NOT EXISTS _cap_task_edges_upd
AFTER UPDATE ON task_edges WHEN ${NOT_APPLYING}
  AND (${anyChanged(edgeCols)})
BEGIN
  ${emitOp("edge", "put", edgeKeyNew, changedPayload(edgeCols))}
END;

CREATE TEMP TRIGGER IF NOT EXISTS _cap_task_edges_del
BEFORE DELETE ON task_edges WHEN ${NOT_APPLYING}
BEGIN
  ${emitOp("edge", "del", edgeKeyOld, "'{}'")}
END;
`;
}

/** The capture trigger DDL. Built once at module load; pure string. */
export const CAPTURE_TRIGGER_DDL = buildTriggerDdl();

// ─── Installation ─────────────────────────────────────────────────────

/**
 * Create the op-context temp tables and the capture triggers on this
 * connection. Called by `openDb` on every non-readonly open.
 *
 * Everything here is idempotent (CREATE TEMP TABLE / TRIGGER IF NOT
 * EXISTS + guarded seed INSERTs) so calling it twice is harmless.
 *
 * No transaction and no 'already exists' swallow, unlike
 * `applySchema`: the temp schema is PRIVATE to this connection, so the
 * concurrent-openDb race that forced those measures on the main schema
 * cannot occur here. Two processes opening the same file each build
 * their own temp schema without contending.
 */
export function installCapture(db: CaptureDb): void {
  db.exec(OP_CTX_DDL);
  db.exec(OP_CTX_SEED);
  db.exec(CAPTURE_TRIGGER_DDL);
}

/** The slice of better-sqlite3's Database that capture needs. Declared
 *  structurally rather than importing `Db` from db.ts, because db.ts
 *  imports THIS module — a nominal import would be a cycle, and an
 *  import cycle here silently breaks `node dist/cli.js`. */
export interface CaptureDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: readonly unknown[]): unknown;
    get(...params: readonly unknown[]): unknown;
  };
}
