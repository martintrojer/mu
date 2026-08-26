// mu — `mu archive restore`: replay a workstream's ops up to a marker.
//
// This is where "an archive is a marker" pays off. The old restore copied a
// column subset out of five `archived_*` tables, so anything those
// columns missed was simply lost. Replaying ops reproduces every column
// the capture triggers recorded, which makes restore strictly MORE
// faithful than the thing it replaces — and it needs no storage at all.
//
// It also works on a DESTROYED workstream, because `workstream destroy`
// writes TOMBSTONES rather than erasing history: the puts below the
// marker are still in the log. We stop AT the marker, so the tombstones
// that came after it are never replayed.

import { randomUUID } from "node:crypto";
import { applyOp, type Op } from "../apply.js";
import {
  type ArchiveMarker,
  ArchiveNotFoundError,
  ArchiveRestoreTargetExistsError,
  getArchive,
  markerFor,
} from "../archives.js";
import type { Db } from "../db.js";
import { nextHlc } from "../hlc.js";
import { LOG_ONLY_INTENTS } from "../rebuild.js";
import { isValidWorkstreamName } from "../workstream.js";

export interface RestoreArchiveOptions {
  label: string;
  /** Which pinned workstream to restore. Optional when the label covers
   *  exactly one, so the common case needs no flag. */
  workstream?: string;
  /** New workstream name. Restore never writes onto an existing one. */
  as: string;
  /** Report what would be replayed without writing. */
  dryRun?: boolean;
}

export interface RestoreArchiveReport {
  label: string;
  /** The workstream the marker pinned. */
  sourceWorkstream: string;
  /** Where it landed. */
  restoredAs: string;
  markerHlc: string;
  /** Ops considered (at or below the marker, for this workstream). */
  opsReplayed: number;
  tasks: number;
  edges: number;
  notes: number;
  dryRun: boolean;
  /** True when the source workstream no longer exists — the property
   *  that an archive OUTLIVES destroy. */
  sourceDestroyed: boolean;
}

interface RawOpRow {
  hlc: string;
  machine_id: string;
  group_id: string;
  actor: string | null;
  intent: string | null;
  entity: string;
  key: string;
  op: string;
  payload: string;
  created_at: string;
}

/** Re-key an op from the archived workstream onto the restore name.
 *
 *  `ops.key` is the NATURAL key, so every key carrying the workstream
 *  has to be rewritten or the replay would collide with (or resurrect)
 *  the original. Shapes handled, matching src/log-render.ts's parser:
 *
 *    'ws'                  workstream row
 *    'ws/t1'               task
 *    'ws/t1#3'             note
 *    'ws/a->ws/b'          edge (BOTH sides)
 */
export function rekey(key: string, from: string, to: string): string {
  const one = (k: string): string => {
    if (k === from) return to;
    if (k.startsWith(`${from}/`)) return `${to}/${k.slice(from.length + 1)}`;
    return k;
  };
  const arrow = key.indexOf("->");
  if (arrow === -1) return one(key);
  return `${one(key.slice(0, arrow))}->${one(key.slice(arrow + 2))}`;
}

/** Does this op belong to `workstream`? Compares on the natural key,
 *  which is the only workstream identity an op carries. */
function belongsTo(key: string, workstream: string): boolean {
  if (key === workstream) return true;
  if (key.startsWith(`${workstream}/`)) return true;
  // Edges name both endpoints; a cross-workstream edge cannot exist, so
  // testing the left side is sufficient.
  const arrow = key.indexOf("->");
  if (arrow !== -1) return belongsTo(key.slice(0, arrow), workstream);
  return false;
}

/**
 * Replay the archived workstream under a new name.
 *
 * SYNCHRONOUS, matching applyOp / withOpContext: the op context is a
 * per-connection temp table, so interleaved async scopes would clobber
 * each other's suppression flag.
 */
export function restoreArchive(db: Db, opts: RestoreArchiveOptions): RestoreArchiveReport {
  const summary = getArchive(db, opts.label);

  // Which pinned workstream? Explicit wins; otherwise the label must
  // cover exactly one, since guessing between several would restore the
  // wrong data under a name the operator chose for the other.
  let sourceWorkstream = opts.workstream;
  if (sourceWorkstream === undefined) {
    if (summary.workstreams.length !== 1) {
      throw new ArchiveNotFoundError(
        `${opts.label} covers ${summary.workstreams.length} workstreams (${summary.workstreams.join(", ")}); pass -w to choose one`,
      );
    }
    sourceWorkstream = summary.workstreams[0];
  }
  if (sourceWorkstream === undefined) throw new ArchiveNotFoundError(opts.label);

  const marker: ArchiveMarker | null = markerFor(db, opts.label, sourceWorkstream);
  if (marker === null) {
    throw new ArchiveNotFoundError(`${opts.label} does not pin workstream ${sourceWorkstream}`);
  }

  if (!isValidWorkstreamName(opts.as)) {
    // Reuse the workstream-name rule rather than inventing a second one.
    throw new ArchiveRestoreTargetExistsError(opts.as);
  }
  const existing = db.prepare("SELECT 1 AS x FROM workstreams WHERE name = ?").get(opts.as) as
    | { x: number }
    | undefined;
  if (existing !== undefined) throw new ArchiveRestoreTargetExistsError(opts.as);

  // Everything at or below the pin. HLCs are bytewise-sortable, which is
  // the whole point of the format, so `<=` in SQL is the same total order
  // compareHlc gives in JS.
  const rows = db
    .prepare(
      `SELECT hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at
         FROM ops
        WHERE hlc <= ? AND entity IN ('workstream','task','note','edge')
        ORDER BY hlc ASC`,
    )
    .all(marker.hlc) as RawOpRow[];

  // Drop log-only ops whose ENTITY collides with a projectable one.
  // `emitEvent` derives an op's entity from its intent prefix, so
  // 'workstream.export' lands on entity='workstream' while carrying a
  // PROSE payload; replaying it drives applyOp's JSON.parse into
  // 'Unexpected token w'. `rebuild.ts` already excludes these by INTENT
  // (§ LOG_ONLY_INTENTS) and restore has to make the same exclusion, or
  // the two projections of one log disagree. Reachable in practice
  // because destroy's pre-destroy auto-export writes exactly this op,
  // and re-pinning after it puts the op BELOW the marker.
  const mine = rows.filter(
    (r) => belongsTo(r.key, sourceWorkstream) && !LOG_ONLY_INTENTS.has(r.intent ?? ""),
  );
  const sourceDestroyed =
    (db.prepare("SELECT 1 AS x FROM workstreams WHERE name = ?").get(sourceWorkstream) as
      | { x: number }
      | undefined) === undefined;

  if (opts.dryRun === true) {
    return {
      label: opts.label,
      sourceWorkstream,
      restoredAs: opts.as,
      markerHlc: marker.hlc,
      opsReplayed: mine.length,
      ...countEntities(mine),
      dryRun: true,
      sourceDestroyed,
    };
  }

  // One group for the whole restore, so `mu undo <group>` reverts it as a
  // unit — a mis-aimed restore is one command to take back.
  const groupId = randomUUID();
  const machineId = (
    db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as {
      machine_id: string;
    }
  ).machine_id;
  const insertOp = db.prepare(
    `INSERT INTO ops (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const row of mine) {
      const op: Op = {
        hlc: row.hlc,
        machineId: row.machine_id,
        groupId: row.group_id,
        actor: row.actor,
        intent: row.intent,
        entity: row.entity,
        key: rekey(row.key, sourceWorkstream, opts.as),
        op: row.op === "del" ? "del" : "put",
        payload: rewritePayload(row.entity, row.payload, sourceWorkstream, opts.as),
      };

      // RECORD, then APPLY, with the SAME hlc in both.
      //
      // `applyOp` deliberately does not write to `ops` ("that is the
      // caller's job") because it is built for INGESTING ops that already
      // exist in the log. A restore is new LOCAL history under a new key,
      // so applying alone leaves live rows the log cannot explain —
      // exactly what `mu doctor --deep` reports as drift (measured: 6
      // divergences).
      //
      // The hlc must be the one we apply. `applyOp`'s provenance queries
      // exclude the op's OWN hlc and take the newest competing op for
      // each field; recording under a DIFFERENT (fresher) hlc makes the
      // row we just wrote look like a newer authority than the op being
      // applied, so every field loses to a bare insert default (measured:
      // 12 divergences, live title='design' vs log title='Design the
      // API'). A fresh hlc per op, applied under the original, is the
      // subtly wrong version of this fix.
      const hlc = nextHlc(db);
      const recorded: Op = { ...op, hlc, machineId };
      insertOp.run(
        hlc,
        machineId,
        groupId,
        "user",
        "archive.restore",
        op.entity,
        op.key,
        op.op,
        op.payload,
        new Date().toISOString(),
      );
      applyOp(db, recorded);
    }
  })();

  return {
    label: opts.label,
    sourceWorkstream,
    restoredAs: opts.as,
    markerHlc: marker.hlc,
    opsReplayed: mine.length,
    ...countEntities(mine),
    dryRun: false,
    sourceDestroyed,
  };
}

/** The workstream put's payload carries `name`, which must follow the
 *  re-key or the restored row would re-create the ORIGINAL name. */
function rewritePayload(entity: string, payload: string, from: string, to: string): string {
  if (entity !== "workstream") return payload;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return payload;
    const bag = parsed as Record<string, unknown>;
    if (bag.name === from) return JSON.stringify({ ...bag, name: to });
    return payload;
  } catch {
    return payload;
  }
}

function countEntities(rows: readonly RawOpRow[]): { tasks: number; edges: number; notes: number } {
  // Distinct KEYS, not ops: a task updated five times is one task. Counts
  // are net of tombstones, so a task deleted before the marker is not
  // reported as restored.
  const live = new Map<string, string>();
  for (const r of rows) {
    if (r.op === "del") live.delete(`${r.entity}\u0000${r.key}`);
    else live.set(`${r.entity}\u0000${r.key}`, r.entity);
  }
  let tasks = 0;
  let edges = 0;
  let notes = 0;
  for (const entity of live.values()) {
    if (entity === "task") tasks++;
    else if (entity === "edge") edges++;
    else if (entity === "note") notes++;
  }
  return { tasks, edges, notes };
}
