// mu — drift detection: is the projection still faithful to the ops log?
//
// WHY THIS IS LOAD-BEARING, NOT DIAGNOSTICS GARNISH
// ------------------------------------------------
// mu collapsed four independent change-recording mechanisms into ONE
// ops log. The upside is coherence. The cost, stated plainly in
// docs/VISION.md § 2b, is that a capture bug is no longer "sync is
// broken" — it is undo AND sync AND history broken,
// simultaneously and silently, because all four are projections of the
// same table.
//
// This module is what converts that from a hazard into a DETECTABLE
// CONDITION. It is the reason the consolidation was defensible at all,
// so it is production code: it must name what diverged precisely enough
// to act on at 3am, and it must not cry wolf on shapes that are
// legitimately asymmetric.
//
// HOW IT WORKS
// ------------
// Rebuild the log into a throwaway DB (src/rebuild.ts, whose target path
// is a parameter precisely so this can point it at a temp file), then
// diff the rebuilt tables against the live ones. The log is canonical by
// definition, so any divergence means either capture missed a mutation
// or apply is lossy. Both are bugs; neither is recoverable by guessing.
//
// TWO TIERS, AND WHY
// ------------------
// Measured on this machine (better-sqlite3 3.49, NVMe):
//
//     tasks    ops    rebuild
//       100    353      258ms
//       500   1742     1146ms
//      1000   3461     2178ms
//
// Linear in ops, ~0.6ms per op. `mu doctor` is expected to be fast and
// is run reflexively, so a 2s+ hit on a realistic DB is not acceptable
// as a default. Hence:
//
//   DEFAULT (`mu doctor`)  — `checkCheapDriftInvariant`, ~1ms: every
//                            live row must have at least one op naming
//                            its key. Catches an uncaptured INSERT or a
//                            row that exists with no history at all,
//                            which is the most common shape of a
//                            capture bug (a new mutation path that
//                            bypassed the triggers).
//   DEEP (`mu doctor --deep`) — full rebuild + field-level diff. Catches
//                            everything, including an uncaptured UPDATE,
//                            which the cheap check is structurally blind
//                            to because the key still has ops.
//
// That blindness is real and measured, not assumed: an uncaptured UPDATE
// leaves the cheap invariant reporting zero orphans. So the cheap check
// is a smoke alarm, not a proof, and the default run says so by pointing
// at --deep.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDb } from "./db.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { rebuildInto } from "./rebuild.js";

/** One field-level divergence between the live tables and the rebuild. */
export interface DriftRecord {
  /** Portable table the divergence is in. */
  table: string;
  /** NATURAL key of the row (never a surrogate id), so the report is
   *  meaningful to an operator and stable across machines. */
  key: string;
  /** Field that differs, or a marker for whole-row presence:
   *  '<row>' means the row exists on one side only. */
  field: string;
  /** Value in the LIVE tables — what mu is currently showing. */
  live: string | null;
  /** Value the ops log says it should be. The log is canonical. */
  expected: string | null;
  /** Which side is missing the row entirely, when field is '<row>'. */
  presence?: "missing-in-live" | "missing-in-rebuild";
}

export interface DriftReport {
  /** True iff the projection matches the log exactly. */
  clean: boolean;
  /** Every divergence found, capped (see DRIFT_REPORT_CAP). */
  records: readonly DriftRecord[];
  /** Total divergences found, which may exceed records.length. */
  totalDrift: number;
  /** Rows compared, per table. Context for "clean" — a clean report on
   *  an empty DB proves less than one on 900 rows. */
  rowsCompared: Record<string, number>;
  /** Wall-clock cost, so `mu doctor --deep` can be honest about it. */
  elapsedMs: number;
}

/** Cap on reported records. A systematic capture bug can diverge every
 *  row; printing 900 lines buries the signal. The count is always exact
 *  (`totalDrift`) even when the list is truncated. */
export const DRIFT_REPORT_CAP = 20;

/** Result of the cheap invariant that runs in the DEFAULT doctor. */
export interface CheapDriftReport {
  clean: boolean;
  /** Live rows with NO op naming their key — i.e. rows whose existence
   *  the log cannot explain. */
  unexplainedRows: readonly { table: string; key: string }[];
  totalUnexplained: number;
  elapsedMs: number;
}

// ─── the cheap invariant (default doctor) ─────────────────────────────

/**
 * Every live row must have at least one op naming its natural key.
 *
 * ~1ms on a 200-task DB: four indexed NOT EXISTS scans, no rebuild, no
 * temp file. Cheap enough to run on every `mu doctor`.
 *
 * WHAT IT CATCHES: a row that exists with no history — an uncaptured
 * INSERT, or a mutation path that bypassed the triggers entirely.
 *
 * WHAT IT CANNOT CATCH, by construction: an uncaptured UPDATE. The key
 * still has ops from the original insert, so the invariant holds while
 * the field value has silently diverged. Verified empirically. Only the
 * full rebuild-diff finds that, which is exactly why `--deep` exists and
 * why the default run points at it rather than claiming to be a proof.
 */
export function checkCheapDriftInvariant(db: Db): CheapDriftReport {
  const started = Date.now();
  const unexplained: { table: string; key: string }[] = [];

  // One query per portable table, each resolving the row to its natural
  // key so the report is actionable.
  const probes: Array<{ table: string; sql: string }> = [
    {
      table: "workstreams",
      sql: `SELECT w.name AS key FROM workstreams w
             WHERE NOT EXISTS (
               SELECT 1 FROM ops o WHERE o.entity = 'workstream' AND o.key = w.name)`,
    },
    {
      table: "tasks",
      sql: `SELECT w.name || '/' || t.local_id AS key
              FROM tasks t JOIN workstreams w ON w.id = t.workstream_id
             WHERE NOT EXISTS (
               SELECT 1 FROM ops o
                WHERE o.entity = 'task' AND o.key = w.name || '/' || t.local_id)`,
    },
    {
      table: "task_edges",
      sql: `SELECT wf.name || '/' || f.local_id || '->' || wt.name || '/' || t.local_id AS key
              FROM task_edges e
              JOIN tasks f ON f.id = e.from_task_id
              JOIN tasks t ON t.id = e.to_task_id
              JOIN workstreams wf ON wf.id = f.workstream_id
              JOIN workstreams wt ON wt.id = t.workstream_id
             WHERE NOT EXISTS (
               SELECT 1 FROM ops o
                WHERE o.entity = 'edge'
                  AND o.key = wf.name || '/' || f.local_id || '->' || wt.name || '/' || t.local_id)`,
    },
    {
      // Notes are keyed <task-key>#<origin-id> and the origin id is the
      // AUTHORING machine's surrogate id, which need not match ours (see
      // src/apply.ts § applyNotePut). So match on the task-key PREFIX
      // rather than the exact key: the question here is "does the log
      // know about a note on this task at all", not "which note".
      table: "task_notes",
      sql: `SELECT w.name || '/' || t.local_id || '#' || n.id AS key
              FROM task_notes n
              JOIN tasks t ON t.id = n.task_id
              JOIN workstreams w ON w.id = t.workstream_id
             WHERE NOT EXISTS (
               SELECT 1 FROM ops o
                WHERE o.entity = 'note'
                  AND o.key LIKE w.name || '/' || t.local_id || '#%')`,
    },
  ];

  for (const probe of probes) {
    const rows = db.prepare(probe.sql).all() as { key: string }[];
    for (const row of rows) unexplained.push({ table: probe.table, key: row.key });
  }

  return {
    clean: unexplained.length === 0,
    unexplainedRows: unexplained.slice(0, DRIFT_REPORT_CAP),
    totalUnexplained: unexplained.length,
    elapsedMs: Date.now() - started,
  };
}

// ─── the deep check (rebuild + diff) ──────────────────────────────────

/** Columns compared per table, keyed by natural key.
 *
 *  DELIBERATE OMISSIONS, each of which would otherwise be a false
 *  positive:
 *
 *    surrogate ids     (`tasks.id`, `task_notes.id`) — assigned by
 *                      AUTOINCREMENT in replay order, which need not
 *                      match the original insert order. The natural key
 *                      is the identity; the rowid is an implementation
 *                      detail.
 *    owner_id          — an FK into machine-local `agents`, so it is
 *                      captured but never APPLIED (src/apply.ts strips
 *                      it: a peer's value would violate the FK). A
 *                      rebuild therefore legitimately has NULL owners
 *                      while the live DB has claims. Comparing it would
 *                      make every claimed task report drift.
 *    created_at on
 *    task_notes/edges  — kept, since capture records it and apply
 *                      replays it verbatim.
 */
const COMPARED: Record<string, readonly string[]> = {
  workstreams: ["created_at"],
  tasks: ["title", "status", "impact", "effort_days", "created_at", "updated_at"],
  task_notes: ["author", "content", "created_at"],
  task_edges: ["created_at"],
};

/** SELECTs that project each portable table to (key, ...COMPARED) so
 *  both sides can be compared by natural key. */
const SNAPSHOT_SQL: Record<string, string> = {
  workstreams: `SELECT w.name AS key, w.created_at
                  FROM workstreams w`,
  tasks: `SELECT w.name || '/' || t.local_id AS key,
                 t.title, t.status, t.impact, t.effort_days, t.created_at, t.updated_at
            FROM tasks t JOIN workstreams w ON w.id = t.workstream_id`,
  // Notes are a GROW-ONLY SET whose local surrogate id is not portable,
  // so identity for diffing is (task, author, content) — exactly the
  // identity applyNotePut uses for its insert-if-absent check. Using the
  // '#<id>' key here would report drift on every note that replayed to a
  // different rowid, which is normal and not drift.
  //
  // char(31) (ASCII Unit Separator) joins the parts: it cannot occur in a
  // workstream/task id and is vanishingly unlikely in note prose, so two
  // distinct notes cannot collide into one composite key. A literal NUL
  // would be the textbook choice but SQLite truncates TEXT at NUL.
  task_notes: `SELECT w.name || '/' || t.local_id || char(31) ||
                      COALESCE(n.author, '') || char(31) || n.content AS key,
                      n.author, n.content, n.created_at
                 FROM task_notes n
                 JOIN tasks t ON t.id = n.task_id
                 JOIN workstreams w ON w.id = t.workstream_id`,
  task_edges: `SELECT wf.name || '/' || f.local_id || '->' || wt.name || '/' || t.local_id AS key,
                      e.created_at
                 FROM task_edges e
                 JOIN tasks f ON f.id = e.from_task_id
                 JOIN tasks t ON t.id = e.to_task_id
                 JOIN workstreams wf ON wf.id = f.workstream_id
                 JOIN workstreams wt ON wt.id = t.workstream_id`,
};

type Row = Record<string, string | number | null>;

function snapshot(db: Db, table: string): Map<string, Row> {
  const sql = SNAPSHOT_SQL[table];
  if (sql === undefined) throw new Error(`no drift snapshot defined for table ${table}`);
  const out = new Map<string, Row>();
  for (const row of db.prepare(sql).all() as Row[]) {
    const key = row.key;
    if (typeof key !== "string") continue;
    out.set(key, row);
  }
  return out;
}

/** Render a value for the report. Distinguishes SQL NULL from the string
 *  "null", which matters when the drift IS a set-to-NULL. */
function show(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

/**
 * Rebuild the log into a temp DB and diff it against the live tables.
 *
 * Any divergence is a bug in capture (a mutation that left no op) or in
 * apply (an op that does not reproduce its mutation). The log is
 * canonical, so `expected` is always the rebuilt value.
 *
 * SYNCHRONOUS, matching rebuildInto / applyOp: the op context is a
 * per-connection temp table, so interleaved async scopes would clobber
 * each other's capture-suppression flag.
 *
 * Cleans up its temp directory even on throw — a doctor run that leaked
 * a DB copy per invocation into /tmp would be its own bug.
 */
export function checkDrift(db: Db): DriftReport {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "mu-drift-"));
  const target = join(dir, "rebuilt.db");

  try {
    rebuildInto(db, { targetPath: target });
    const rebuilt = openDb({ path: target });
    try {
      const records: DriftRecord[] = [];
      const rowsCompared: Record<string, number> = {};
      let total = 0;

      const push = (record: DriftRecord): void => {
        total += 1;
        if (records.length < DRIFT_REPORT_CAP) records.push(record);
      };

      for (const table of Object.keys(SNAPSHOT_SQL)) {
        const live = snapshot(db, table);
        const expected = snapshot(rebuilt, table);
        rowsCompared[table] = live.size;

        for (const [key, liveRow] of live) {
          const expectedRow = expected.get(key);
          if (expectedRow === undefined) {
            // Live has a row the log cannot account for: capture missed
            // its creation, or a tombstone that should not have applied.
            push({
              table,
              key,
              field: "<row>",
              live: "present",
              expected: null,
              presence: "missing-in-rebuild",
            });
            continue;
          }
          for (const field of COMPARED[table] ?? []) {
            const a = liveRow[field];
            const b = expectedRow[field];
            // Compare rendered values so 1 and 1.0 (INTEGER vs REAL
            // affinity across a replay) do not read as drift.
            if (show(a) !== show(b)) {
              push({ table, key, field, live: show(a), expected: show(b) });
            }
          }
        }

        for (const key of expected.keys()) {
          if (live.has(key)) continue;
          // The log says this row should exist but it is gone from live:
          // a delete that left no tombstone.
          push({
            table,
            key,
            field: "<row>",
            live: null,
            expected: "present",
            presence: "missing-in-live",
          });
        }
      }

      return {
        clean: total === 0,
        records,
        totalDrift: total,
        rowsCompared,
        elapsedMs: Date.now() - started,
      };
    } finally {
      rebuilt.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
}

/** One-line-per-record rendering shared by the CLI and the TUI popup, so
 *  the wording of a drift report lives in exactly one place. */
export function formatDriftRecord(record: DriftRecord): string {
  if (record.field === "<row>") {
    return record.presence === "missing-in-live"
      ? `${record.table} ${record.key}: row MISSING from live tables (the log says it exists)`
      : `${record.table} ${record.key}: row present in live tables but the log cannot explain it`;
  }
  const live = record.live === null ? "NULL" : record.live;
  const expected = record.expected === null ? "NULL" : record.expected;
  return `${record.table} ${record.key}.${record.field}: live=${live} log=${expected}`;
}

/** What an operator should DO about drift. Detection without remediation
 *  is just an alarm; this is the part that matters at 3am.
 *
 *  Deliberately does NOT tell them to swap the rebuild in blindly. Drift
 *  means one of the two sides is wrong and we cannot know which from
 *  here: if capture missed a mutation, the LIVE tables hold the truth and
 *  the log is incomplete, so rebuilding would DISCARD real work. If apply
 *  is lossy, the log is right. So the guidance is: capture the evidence,
 *  then choose deliberately. */
export function driftRemediation(): readonly string[] {
  return [
    "Drift means the ops log and the live tables disagree. One of them is wrong.",
    "",
    "  * If CAPTURE missed a mutation, the LIVE tables hold work the log never",
    "    recorded. Rebuilding would DISCARD it. Do not rebuild reflexively.",
    "  * If APPLY is lossy, the log is authoritative and a rebuild is the fix.",
    "",
    "Do this, in order:",
    "  1. Back up first, before anything else:  mu db backup /tmp/mu-drift-evidence.db",
    "  2. Materialize what the log believes:    mu rebuild /tmp/mu-rebuilt.db",
    "  3. Compare the two by hand for the keys named above, and decide which",
    "     side is correct. `mu sql` against both files is the fastest way.",
    "  4. Report it: drift is a capture/apply BUG, not operator error. The",
    "     named table/key/field above is the reproduction.",
  ];
}

// ─── the typed error ──────────────────────────────────────────────────

/**
 * Thrown by `mu doctor` when drift is found, so the verb exits non-zero
 * and a CI job or a wrapper script notices.
 *
 * Drift is not operator error and not a transient condition: it means the
 * ops log and the tables disagree, which is a capture or apply BUG. An
 * exit code is how that reaches automation; the printed report is how it
 * reaches a human.
 */
export class DriftDetectedError extends Error implements HasNextSteps {
  constructor(
    readonly totalDrift: number,
    readonly records: readonly DriftRecord[],
  ) {
    super(
      `ops-log drift: ${totalDrift} divergence${totalDrift === 1 ? "" : "s"} between the live tables and the ops log`,
    );
    this.name = "DriftDetectedError";
  }

  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Back up the current state FIRST",
        command: "mu db backup /tmp/mu-drift-evidence.db",
      },
      { intent: "Materialize what the log believes", command: "mu rebuild /tmp/mu-rebuilt.db" },
      {
        intent: "Compare the named keys by hand before choosing a side",
        command: 'mu sql "SELECT local_id, title, status, impact FROM tasks"',
      },
    ];
  }
}
