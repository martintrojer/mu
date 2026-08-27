// mu — rebuild: materialize a fresh DB by replaying the ops log.
//
// The third leg of the ops-log substrate, after capture (write side) and
// apply (read side). This is the DISASTER-RECOVERY story that replaces
// the snapshot files mu no longer keeps: given an intact `ops` table, every
// portable row is reconstructable, because the log is the canonical
// record and the tables are a projection of it.
//
// It is also the foundation the doctor drift check stands on. "Is the
// projection still faithful to the log?" is answered by rebuilding into
// a temp DB and diffing — which is why `rebuildInto` takes the target
// path as a PARAMETER and prints nothing. All human output lives in the
// CLI layer (src/cli/rebuild.ts).
//
// REBUILD INTO A NEW FILE, NEVER IN PLACE
// ---------------------------------------
// Locked decision. A rebuild that overwrote the live DB would be a
// destructive operation whose failure mode is "no database at all", and
// it would have to hold a write lock over the whole replay. Writing a
// new file and PRINTING THE SWAP COMMAND keeps the operator in control:
// they can diff, inspect, and swap when ready. It also means a rebuild
// is safe to run at any time, including from the drift check, with no
// risk to live state.
//
// REBUILD IS NOT INGEST
// ---------------------
// The distinction is load-bearing and easy to get backwards.
//
//   ingest  = "absorb a PEER's ops". Only SYNCED_ENTITIES may cross a
//             machine boundary, so ingest filters. A peer's agent rows
//             are meaningless here (`pane_id` '%17' names a pane on
//             their box), so they must never arrive.
//   rebuild = "reconstruct MY OWN database". A local recovery
//             operation, so it must replay EVERYTHING the log knows,
//             including machine-local ops. Dropping them would silently
//             discard this machine's own log history — `mu log` would
//             come back empty after a recovery.
//
// So this module deliberately does NOT filter by SYNCED_ENTITIES. It
// copies every op verbatim and projects the ones that have a portable
// table to project into.
//
// WHAT A REBUILT DB LEGITIMATELY LOSES
// ------------------------------------
// The ops log only contains what capture recorded, and capture has
// triggers on the PORTABLE tables only. `agents` and `vcs_workspaces`
// have no triggers, so they leave no ops and cannot be reconstructed.
//
// That is CORRECT, not a gap. Both tables hold values that are
// meaningless after recovery: `agents.pane_id` names a tmux pane in a
// server that no longer has it, and `vcs_workspaces.path` is an absolute
// path whose working copy may be gone. Resurrecting either would produce
// rows that lie about reality, and `mu doctor` would immediately flag
// them as ghosts.
//
// But it must be REPORTED, never silent. An operator who rebuilds and
// does not realise their agent registry is empty will wonder why
// `mu agent list` is blank. `RebuildReport.machineLocalLost` carries the
// per-table counts so the CLI can say so explicitly and tell them to
// re-spawn.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { applyOp, type Op } from "./apply.js";
import { type Db, openDb, SYNCED_ENTITIES } from "./db.js";
import { compareHlc } from "./hlc.js";
import { withCaptureSuppressed } from "./op-context.js";
import type { HasNextSteps, NextStep } from "./output.js";

/** Raised when the rebuild target already exists. Never overwrite: the
 *  operator may have pointed at their live DB by mistake, and a rebuild
 *  is supposed to be the SAFE recovery path. */
export class RebuildTargetExistsError extends Error implements HasNextSteps {
  constructor(readonly path: string) {
    super(`rebuild target already exists: ${path}`);
    this.name = "RebuildTargetExistsError";
  }

  errorNextSteps(): NextStep[] {
    return [
      { intent: "Pick a path that does not exist", command: "mu rebuild /tmp/mu-rebuilt.db" },
      { intent: "Or remove the stale target first", command: `rm -f ${this.path}` },
    ];
  }
}

/** Raised when the target path resolves to the source DB. Rebuilding a
 *  DB onto itself would truncate the very log being replayed. */
export class RebuildTargetIsSourceError extends Error implements HasNextSteps {
  constructor(readonly path: string) {
    super(`rebuild target is the source DB: ${path}`);
    this.name = "RebuildTargetIsSourceError";
  }

  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Rebuild writes a NEW file; pick a different path",
        command: "mu rebuild /tmp/mu-rebuilt.db",
      },
    ];
  }
}

/** Per-table counts of rows a rebuild cannot reconstruct, because the
 *  table has no capture triggers and therefore leaves no ops. */
export interface MachineLocalLoss {
  table: string;
  /** Rows present in the SOURCE that will be absent from the rebuild. */
  rows: number;
}

/** What a rebuild did. Returned rather than printed so the drift check
 *  can consume it programmatically. */
export interface RebuildReport {
  /** Absolute-ish path written (as given by the caller). */
  targetPath: string;
  /** Ops copied into the target's log. Every op, not just synced ones. */
  opsCopied: number;
  /** Ops that projected into a portable table. Always <= opsCopied:
   *  log-only entities (message / event / broadcast / marker) are
   *  copied but have no table to land in. */
  opsProjected: number;
  /** Ops that changed a row when applied. Lower than opsProjected
   *  whenever later ops superseded earlier ones — which is normal and
   *  is exactly what makes the rebuild a merge rather than a diff. */
  opsChangedRows: number;
  /** Ops skipped as non-projectable, by entity. Diagnostic only. */
  logOnlyByEntity: Record<string, number>;
  /** Row counts per portable table in the rebuilt DB. */
  rebuiltRows: Record<string, number>;
  /** Tables that cannot be rebuilt, with the row counts being lost. */
  machineLocalLost: MachineLocalLoss[];
  /** The machine identity carried across, so the rebuilt DB remains the
   *  SAME peer rather than becoming a new one. */
  machineId: string;
}

/** Tables that hold real state but leave no ops, so a rebuild cannot
 *  reconstruct them. Both are machine-local by nature — see the module
 *  comment for why resurrecting them would be wrong even if we could. */
const UNREBUILDABLE_TABLES = ["agents", "vcs_workspaces"] as const;

/** Entities that exist only in the log: there is no portable table to
 *  project them into, so copying the op IS applying it.
 *
 *  'message' / 'event' / 'broadcast' are log lines (src/logs.ts writes
 *  them). All three are copied verbatim and deliberately not passed to
 *  applyOp, which would reject the log kinds as non-synced. */
const LOG_ONLY_ENTITIES = new Set(["message", "event", "broadcast"]);

/** Ops that `applyOp` knows how to project into a portable table. This
 *  is the intersection of "synced" and "has a table", which excludes
 *  'message' even though it is in SYNCED_ENTITIES.
 *
 *  Every intent `emitEvent` writes is machine-local (`agent.*` /
 *  `workspace.*`), and `entityForIntent` derives the entity from the
 *  intent prefix, so none of them can name a synced entity. That is why
 *  the entity alone is a sufficient classifier here. */
function isProjectable(entity: string): boolean {
  if (LOG_ONLY_ENTITIES.has(entity)) return false;
  return (SYNCED_ENTITIES as readonly string[]).includes(entity);
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

function opFromRow(row: RawOpRow): Op {
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

export interface RebuildOptions {
  /** Path for the new DB. Must not exist. */
  targetPath: string;
  /** Overwrite an existing target. Off by default so a mistyped path
   *  cannot clobber a real file; the drift check sets it because it
   *  owns a temp path it just created. */
  force?: boolean;
}

/**
 * Replay `source`'s ops log into a brand-new DB at `opts.targetPath`.
 *
 * Prints nothing and returns a report, so both `mu rebuild` and the
 * (forthcoming) doctor drift check can use it — the latter rebuilds into
 * a temp path and diffs rather than showing a human anything.
 *
 * SYNCHRONOUS, matching applyOp and withOpContext: the op context is a
 * per-connection temp table, so interleaved async scopes would clobber
 * each other's suppression flag.
 */
export function rebuildInto(source: Db, opts: RebuildOptions): RebuildReport {
  const { targetPath } = opts;

  // Refuse to touch the source. `sqlite_master`-level identity is not
  // enough — the caller may pass a different string for the same file —
  // so compare the resolved filename SQLite itself reports.
  const sourceFile = (source.pragma("database_list") as Array<{ name: string; file: string }>).find(
    (row) => row.name === "main",
  )?.file;
  if (sourceFile !== undefined && sourceFile.length > 0) {
    const sameFile =
      sourceFile === targetPath ||
      (existsSync(targetPath) && existsSync(sourceFile) && sameInode(sourceFile, targetPath));
    if (sameFile) throw new RebuildTargetIsSourceError(targetPath);
  }
  if (existsSync(targetPath) && opts.force !== true) {
    throw new RebuildTargetExistsError(targetPath);
  }

  mkdirSync(dirname(targetPath), { recursive: true });

  // Read everything we need from the source FIRST, so the target is only
  // opened once we know the replay can proceed.
  const identity = source
    .prepare(
      "SELECT machine_id, hostname, created_at, last_wall, last_counter FROM machine_identity WHERE id = 1",
    )
    .get() as
    | {
        machine_id: string;
        hostname: string | null;
        created_at: string;
        last_wall: number;
        last_counter: number;
      }
    | undefined;
  if (!identity) throw new Error("source DB has no machine_identity row; not a v9 mu DB");

  const opRows = source
    .prepare(
      `SELECT hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at
         FROM ops`,
    )
    .all() as RawOpRow[];

  // HLC ORDER, not seq order. seq is a local append cursor, so it
  // reflects the order ops were RECORDED, which for ingested peer ops is
  // arrival order rather than causal order. Replaying in HLC order is
  // what makes per-field LWW resolve correctly (see src/apply.ts), and
  // it is why the rebuild converges to the same state regardless of how
  // the log happened to be assembled.
  opRows.sort((a, b) => compareHlc(a.hlc, b.hlc));

  const peerRows = source
    .prepare("SELECT machine_id, last_applied_seq, last_seen_at FROM sync_peers")
    .all() as Array<{
    machine_id: string;
    last_applied_seq: number;
    last_seen_at: string | null;
  }>;

  const machineLocalLost: MachineLocalLoss[] = [];
  for (const table of UNREBUILDABLE_TABLES) {
    const row = source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    if (row.n > 0) machineLocalLost.push({ table, rows: row.n });
  }

  const target = openDb({ path: targetPath });
  try {
    // Carry the machine identity across BEFORE replaying.
    //
    // A fresh openDb seeds a NEW uuid, which would make the rebuilt DB a
    // DIFFERENT PEER: its own historical ops would look foreign to it,
    // the UNIQUE (machine_id, hlc) identity of every op would no longer
    // match its author, and peers tracking watermarks against the old id
    // would treat it as an unknown machine. Recovery must preserve who
    // this machine IS.
    //
    // The HLC clock (last_wall / last_counter) comes too. Without it the
    // rebuilt DB starts at 0 and the next local edit would mint an HLC
    // BELOW every op already in its log — so a brand-new change would
    // sort as older than history and lose every LWW comparison against
    // it. Monotonicity is a property of the machine, not of the file.
    target
      .prepare(
        `UPDATE machine_identity
            SET machine_id = @machineId, hostname = @hostname, created_at = @createdAt,
                last_wall = @lastWall, last_counter = @lastCounter
          WHERE id = 1`,
      )
      .run({
        machineId: identity.machine_id,
        hostname: identity.hostname,
        createdAt: identity.created_at,
        lastWall: identity.last_wall,
        lastCounter: identity.last_counter,
      });

    const insertOp = target.prepare(
      `INSERT OR IGNORE INTO ops
         (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
       VALUES (@hlc, @machineId, @groupId, @actor, @intent, @entity, @key, @op, @payload, @createdAt)`,
    );
    const insertPeer = target.prepare(
      `INSERT OR REPLACE INTO sync_peers (machine_id, last_applied_seq, last_seen_at)
       VALUES (@machineId, @lastAppliedSeq, @lastSeenAt)`,
    );

    const logOnlyByEntity: Record<string, number> = {};
    let opsProjected = 0;
    let opsChangedRows = 0;

    // ONE transaction for the whole replay. A rebuild is all-or-nothing:
    // a half-replayed DB is worse than no DB, because it looks usable.
    const replay = target.transaction(() => {
      // Capture-suppressed for the entire replay. Without this, applying
      // each op would fire the capture triggers and mint a SECOND op per
      // row, so the rebuilt log would be roughly double the original and
      // full of ops with fresh HLCs that never happened. The suppression
      // wraps the op INSERTs too, so nothing here can mint.
      withCaptureSuppressed(target, () => {
        for (const row of opRows) {
          // Copy the op verbatim, whatever its entity. This is the
          // rebuild-is-not-ingest rule: the log is this machine's own
          // history and every row of it survives recovery, including
          // machine-local entities that would never cross a peer
          // boundary.
          insertOp.run({
            hlc: row.hlc,
            machineId: row.machine_id,
            groupId: row.group_id,
            actor: row.actor,
            intent: row.intent,
            entity: row.entity,
            key: row.key,
            op: row.op,
            payload: row.payload,
            createdAt: row.created_at,
          });

          if (!isProjectable(row.entity)) {
            logOnlyByEntity[row.entity] = (logOnlyByEntity[row.entity] ?? 0) + 1;
            continue;
          }
          // Project through the SAME apply path sync ingest uses. Not a
          // second implementation of the merge rules: tombstone
          // ordering, per-field LWW and grow-only sets all come from
          // src/apply.ts, so a rebuild and an ingest can never disagree.
          opsProjected += 1;
          if (applyOp(target, opFromRow(row)).changed) opsChangedRows += 1;
        }

        for (const peer of peerRows) {
          insertPeer.run({
            machineId: peer.machine_id,
            lastAppliedSeq: peer.last_applied_seq,
            lastSeenAt: peer.last_seen_at,
          });
        }
      });
    });
    replay();

    const rebuiltRows: Record<string, number> = {};
    for (const table of ["workstreams", "tasks", "task_edges", "task_notes", "ops"]) {
      const row = target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      rebuiltRows[table] = row.n;
    }

    return {
      targetPath,
      opsCopied: rebuiltRows.ops ?? 0,
      opsProjected,
      opsChangedRows,
      logOnlyByEntity,
      rebuiltRows,
      machineLocalLost,
      machineId: identity.machine_id,
    };
  } finally {
    target.close();
  }
}

/** True iff both paths name the same file on disk. Guards the
 *  rebuild-onto-itself case when the caller passes a different string
 *  for the same file (a symlink, or ./x vs x). */
function sameInode(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    // A path we cannot stat is not the source by definition.
    return false;
  }
}
