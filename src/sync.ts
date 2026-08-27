// mu — the sync seam: peer status, the ambient hook, and the two power
// tools behind `mu sync`.
//
// WHAT LIVES HERE AND WHAT DOES NOT
// ---------------------------------
// `src/segments.ts` owns the MECHANISM (flush / ingest / watermarks /
// the four robustness layers). This file owns the OPERATOR-FACING
// questions that mechanism cannot answer on its own:
//
//   - who are my peers, how far behind am I, when did I last hear from
//     them (`peerStatuses`)
//   - the AMBIENT hook every mu invocation runs (`ambientIngest` /
//     `ambientFlush`)
//   - a DIFFERENT READER: a peer's `ops` table read straight out of a
//     copied / sshfs-mounted `mu.db` (`ingestFromDb`)
//   - the universal repair: reset a watermark and re-read from zero
//     (`repairPeer`)
//
// AMBIENT, NOT A DAEMON
// ---------------------
// There is no watcher, no background process, and no polling loop that
// outlives the command. Sync happens because you already run `mu`
// constantly: every invocation ingests before the verb body and flushes
// after it. With `MU_SYNC_DIR` unset both halves are a single `if` that
// reads one env var, so the single-machine case pays nothing. With 2-5
// peers it is a handful of `stat`/`read` calls on small append-only
// files.
//
// The TUI is the one long-lived surface, and it hangs the same pass off
// its SLOW tick (10s), never the 1s fast tick — sync is filesystem work
// and has no business on a repaint cadence.
//
// SYNC MUST NEVER FAIL A COMMAND
// ------------------------------
// A truncated segment, an unreadable sync dir, a full disk: all of them
// warn and return. `mu task add` has to work when sync is broken,
// because the alternative is a tool that stops working when a folder you
// do not control misbehaves. Every ambient entry point here is
// try/catch-total by construction (see `ambientIngest`).
//
// TRANSPORT STAYS THE OPERATOR'S
// ------------------------------
// mu reads and writes FILES. It does not shell out to ssh/scp/rsync, and
// it will not grow `--push <host>`: that is a remote backend wearing a
// small hat (ssh config, jump hosts, ProxyCommand, ports, identity
// files, interactive prompts inside a TUI tick, network-vs-auth error
// mapping), and it violates the standing ROADMAP pledge that the user
// owns transport. Instead, when a peer looks stale we PRINT a
// copy-pasteable rsync line through the ordinary NextStep convention and
// let the operator paste it, alias it, or run Syncthing and never see
// it.

import { existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { type Op, reprojectDeferredOps } from "./apply.js";
import { type Db, SYNCED_ENTITIES } from "./db.js";
import { isLegacyLogOnlyIntent } from "./legacy-ops.js";
import type { NextStep } from "./output.js";
import {
  applyIncomingOp,
  discoverPeers,
  type FlushResult,
  flushSegment,
  getWatermark,
  type IngestResult,
  ingestSegment,
  localMachineId,
  resetWatermark,
  type SegmentDefect,
  segmentLineCount,
  syncDir,
} from "./segments.js";

/** No discovered peer matches the operator's `--repair <peer>` ref.
 *  Exit 3 (not found), like every other resolve-time miss. */
export class SyncPeerNotFoundError extends Error {
  override readonly name = "SyncPeerNotFoundError";
  constructor(
    readonly ref: string,
    readonly known: readonly string[],
  ) {
    super(
      `no peer matches ${JSON.stringify(ref)}${
        known.length === 0 ? " (no peers discovered)" : ` (known peers: ${known.join(", ")})`
      }`,
    );
  }
}

/** A `--repair <peer>` prefix matched several peers. A conflict (exit 4),
 *  never a guess — the same rule `mu undo <group>` follows for
 *  abbreviated group ids. */
export class SyncPeerRefAmbiguousError extends Error {
  override readonly name = "SyncPeerRefAmbiguousError";
  constructor(
    readonly ref: string,
    readonly candidates: readonly string[],
  ) {
    super(
      `peer ref ${JSON.stringify(ref)} matches ${candidates.length} peers (${candidates.join(", ")}); pass more characters`,
    );
  }
}

/** `mu sync --from <path>` pointed at a file that is not there. Exit 3. */
export class SyncSourceNotFoundError extends Error {
  override readonly name = "SyncSourceNotFoundError";
  constructor(readonly path: string) {
    super(`--from: no such file: ${path}`);
  }
}

/** A peer whose segment has not moved in this long is reported STALE.
 *  A fixed constant, not an env var: it is a display threshold, and mu's
 *  whole cluster configuration is deliberately ONE env var. */
export const PEER_STALE_MS = 24 * 60 * 60 * 1000;

/** How many characters of a `machine_id` uuid we show. Peers are known
 *  only by uuid — `machine_identity.hostname` is machine-LOCAL and never
 *  ships, so mu genuinely cannot render a peer's hostname without
 *  inventing a membership file. A short prefix is the honest display,
 *  and every verb that takes one accepts any unique prefix (the
 *  affordance git gives for shas). */
export const PEER_SHORT_LEN = 8;

export interface PeerStatus {
  machineId: string;
  /** First `PEER_SHORT_LEN` chars of the machine id, for display. */
  short: string;
  path: string;
  /** True for a Syncthing-style `*.sync-conflict-*.jsonl` copy. */
  conflictCopy: boolean;
  /** Lines of this peer's segment already applied. */
  watermark: number;
  /** GOOD lines currently in the segment (a defect stops the count). */
  total: number;
  /** `total - watermark`: how much of what we HOLD is not yet applied.
   *  Non-zero after a defect stopped an ingest short, or mid-transfer. */
  behind: number;
  /** Segment mtime in epoch ms — when transport last delivered. */
  lastSeenMs: number | null;
  /** Age of the segment file, ms. Null when it does not exist. */
  ageMs: number | null;
  stale: boolean;
}

/** Peer table for the sync dir, newest contact first. Pure read: it
 *  neither flushes nor ingests, so `mu sync` can call it after its own
 *  pass and the TUI could call it on a tick. */
export function peerStatuses(db: Db, dir: string): PeerStatus[] {
  const self = localMachineId(db);
  const now = Date.now();
  const rows = discoverPeers(dir, self).map((peer) => {
    let lastSeenMs: number | null = null;
    try {
      lastSeenMs = statSync(peer.path).mtimeMs;
    } catch {
      lastSeenMs = null;
    }
    const total = segmentLineCount(peer.path);
    const watermark = getWatermark(db, peer.machineId);
    const ageMs = lastSeenMs === null ? null : Math.max(0, now - lastSeenMs);
    return {
      machineId: peer.machineId,
      short: peer.machineId.slice(0, PEER_SHORT_LEN),
      path: peer.path,
      conflictCopy: peer.conflictCopy,
      watermark,
      total,
      behind: Math.max(0, total - watermark),
      lastSeenMs,
      ageMs,
      stale: ageMs === null || ageMs > PEER_STALE_MS,
    };
  });
  return rows.sort((a, b) => (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0));
}

/** Resolve an operator-typed peer reference (full machine id, or any
 *  unique prefix) against the discovered peers. Ambiguity is a
 *  UsageError, never a guess — repairing the wrong peer would re-read a
 *  whole segment for nothing and confuse the report. */
export function resolvePeerRef(peers: readonly PeerStatus[], ref: string): PeerStatus {
  const exact = peers.find((p) => p.machineId === ref);
  if (exact !== undefined) return exact;
  const matches = peers.filter((p) => p.machineId.startsWith(ref));
  const first = matches[0];
  if (first === undefined) {
    throw new SyncPeerNotFoundError(
      ref,
      peers.map((p) => p.short),
    );
  }
  if (matches.length > 1) {
    throw new SyncPeerRefAmbiguousError(
      ref,
      matches.map((p) => p.short),
    );
  }
  return first;
}

/** Reset a peer's watermark so the next ingest re-reads its segment from
 *  zero. Safe by construction: apply is idempotent and `ops` dedupes on
 *  `UNIQUE (machine_id, hlc)`. */
export function repairPeer(db: Db, ref: string, dir: string): PeerStatus {
  const peer = resolvePeerRef(peerStatuses(db, dir), ref);
  resetWatermark(db, peer.machineId);
  return peer;
}

// ─── the ambient hook ─────────────────────────────────────────────────

/** Is sync configured at all? THE single `if` the no-sync case pays.
 *  Callers check this before awaiting anything, so an unconfigured
 *  machine allocates no promise and touches no filesystem. */
export function syncEnabled(): boolean {
  return syncDir() !== null;
}

export interface AmbientResult {
  /** Peers whose segments were read. Empty when sync is off. */
  ingested: readonly IngestResult[];
  /** Non-fatal problems, already warned about. */
  warnings: readonly string[];
}

export interface AmbientOptions {
  /** Suppress the stderr warnings. Set by the TUI, which owns the
   *  alternate screen — a stray write there paints garbage over the
   *  dashboard. The warnings are still returned, and the Doctor card
   *  is where a TUI operator learns about a broken sync dir. */
  quiet?: boolean;
}

/** Format one non-fatal sync problem for stderr. Prefixed so it is
 *  unmistakably mu's own aside and not the verb's output. */
function warn(message: string, opts?: AmbientOptions): void {
  if (opts?.quiet === true) return;
  // Deliberately stderr: stdout is the verb's contract (and may be JSON).
  process.stderr.write(`mu: sync: ${message}\n`);
}

function describeDefects(peerShort: string, defects: readonly SegmentDefect[]): string {
  const first = defects[0];
  const detail = first === undefined ? "unknown defect" : `${first.kind} at line ${first.line}`;
  const more = defects.length > 1 ? ` (+${defects.length - 1} more)` : "";
  return `peer ${peerShort}: ${detail}${more} — re-read with \`mu sync --repair ${peerShort}\``;
}

/**
 * INGEST half of the ambient hook: pull every peer segment before the
 * verb body runs, so the command sees the freshest state the filesystem
 * can offer.
 *
 * Total: no input can make this throw. A per-peer failure is isolated so
 * one broken segment cannot hide the others.
 */
export async function ambientIngest(db: Db, opts?: AmbientOptions): Promise<AmbientResult> {
  const dir = syncDir();
  if (dir === null) return { ingested: [], warnings: [] };
  const warnings: string[] = [];
  const ingested: IngestResult[] = [];
  try {
    const self = localMachineId(db);
    for (const peer of discoverPeers(dir, self)) {
      try {
        const result = ingestSegment(db, peer);
        ingested.push(result);
        if (result.defects.length > 0) {
          const message = describeDefects(peer.machineId.slice(0, PEER_SHORT_LEN), result.defects);
          warnings.push(message);
          warn(message, opts);
        }
      } catch (err) {
        const message = `peer ${peer.machineId.slice(0, PEER_SHORT_LEN)}: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(message);
        warn(message, opts);
      }
    }
    // Every peer is in; now project anything that arrived before its
    // parent task did. Deliberately outside the per-peer loop, and
    // deliberately inside the outer try: a repair failure must not fail
    // the verb any more than a torn segment does.
    reprojectDeferredOps(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(message);
    warn(message, opts);
  }
  // `await` nothing above: ingest is synchronous better-sqlite3 work.
  // The async signature exists so the caller's seam is uniform with
  // ambientFlush (which takes a file lock).
  return { ingested, warnings };
}

/**
 * FLUSH half of the ambient hook: append this invocation's own ops to
 * this machine's segment AFTER the verb body has committed them.
 *
 * Order matters and is the whole reason the hook is split in two: a
 * flush before the body would leave the ops the operator just wrote
 * sitting unflushed until the NEXT invocation, so `mu task add` on the
 * laptop followed by `mu sync` on the devserver would show nothing —
 * exactly the no-hands claim, broken.
 *
 * Runs under the cross-process file lock inside `flushSegment`, so two
 * concurrent mu processes cannot interleave partial lines.
 */
export async function ambientFlush(db: Db, opts?: AmbientOptions): Promise<FlushResult | null> {
  const dir = syncDir();
  if (dir === null) return null;
  try {
    const result = await flushSegment(db, dir);
    if (result.selfRepaired !== null) {
      const d = result.selfRepaired;
      warn(
        `own segment truncated back to its last good line: ${d.kind} at line ${d.line} (${d.detail}) — regenerated from the ops table`,
        opts,
      );
    }
    return result;
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err), opts);
    return null;
  }
}

/**
 * Both halves in one call, for a caller that has no before/after seam to
 * straddle — today the TUI's SLOW tick (10s; never the 1s fast tick,
 * which is a repaint cadence and has no business doing filesystem work).
 *
 * Ingest first, then flush: the same order the CLI hook uses, so a
 * long-lived TUI converges on exactly the same schedule as a shell that
 * runs one verb every ten seconds.
 */
export async function ambientSyncPass(
  db: Db,
  opts?: AmbientOptions,
): Promise<{ ingested: readonly IngestResult[]; flushed: FlushResult | null }> {
  if (!syncEnabled()) return { ingested: [], flushed: null };
  const { ingested } = await ambientIngest(db, opts);
  const flushed = await ambientFlush(db, opts);
  return { ingested, flushed };
}

// ─── `mu sync --from <peer.db>`: a different READER ───────────────────

export interface IngestFromDbResult {
  path: string;
  /** Ops read out of the peer's `ops` table (already filtered). */
  read: number;
  /** Ops that changed a row here. */
  changed: number;
  /** Ops skipped because their entity is machine-local. */
  skippedLocal: number;
}

/**
 * Ingest straight from a peer's `mu.db`, reading its `ops` table with
 * SQLite instead of parsing a JSONL segment.
 *
 * WHY THIS EARNS A FLAG when `MU_SYNC_DIR=/mnt/whatever mu state` covers
 * the one-off-directory case: it is a DIFFERENT READER, and nothing
 * about an env var can express it. The file you have is a database, not
 * a segment — because you scp'd it, or because you have the devserver's
 * state dir on sshfs and would rather read the real thing than wait for
 * a flush.
 *
 * Opened `readonly` so mu cannot write to a file it does not own, and
 * `fileMustExist` so a typo'd path is an error rather than a freshly
 * created empty DB.
 *
 * Filters exactly as flush does — `SYNCED_ENTITIES` only, and never the
 * peer's copy of OUR ops (we already have those; `UNIQUE (machine_id,
 * hlc)` would dedupe them anyway, but not reading them is cheaper and
 * keeps the reported count honest). Ops the peer itself ingested from a
 * THIRD machine are read, which is how transitive convergence falls out
 * for free.
 *
 * Watermarks are deliberately untouched: a watermark counts LINES of a
 * segment, and a DB has no such coordinate. The next segment ingest for
 * that peer re-reads from wherever it was, applies the same ops again,
 * and changes nothing — idempotence is what makes leaving it alone safe.
 */
export function ingestFromDb(db: Db, path: string): IngestFromDbResult {
  if (!existsSync(path)) throw new SyncSourceNotFoundError(path);
  const self = localMachineId(db);
  const source = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = source
      .prepare(
        `SELECT hlc, machine_id, group_id, actor, intent, entity, key, op, payload
           FROM ops
          WHERE machine_id != ?
          ORDER BY hlc`,
      )
      .all(self) as Array<{
      hlc: string;
      machine_id: string;
      group_id: string;
      actor: string | null;
      intent: string | null;
      entity: string;
      key: string;
      op: string;
      payload: string;
    }>;

    const synced = new Set<string>(SYNCED_ENTITIES);
    let read = 0;
    let changed = 0;
    let skippedLocal = 0;
    const run = db.transaction(() => {
      for (const row of rows) {
        if (!synced.has(row.entity) || isLegacyLogOnlyIntent(row.intent)) {
          skippedLocal += 1;
          continue;
        }
        const op: Op = {
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
        const result = applyIncomingOp(db, op);
        read += 1;
        if (result.changed) changed += 1;
      }
    });
    run();
    // Same out-of-order repair the segment path runs: a peer's `ops`
    // table can hold an edge whose task op we only got from a THIRD
    // machine, in either order.
    changed += reprojectDeferredOps(db);
    return { path, read, changed, skippedLocal };
  } finally {
    try {
      source.close();
    } catch {
      // best effort
    }
  }
}

// ─── transport hints ──────────────────────────────────────────────────

/**
 * Copy-pasteable transport for a stale peer, via the ordinary NextStep
 * convention. This is what mu does INSTEAD of moving bytes itself.
 *
 * `<host>` is a literal placeholder on purpose: mu has no host list and
 * is not growing one (a peer list would be a config file with extra
 * steps, and one that must be kept consistent on every machine — the
 * very drift it looks like it solves).
 */
export function transportNextSteps(dir: string, peers: readonly PeerStatus[]): NextStep[] {
  const stale = peers.filter((p) => p.stale);
  if (stale.length === 0) return [];
  return [
    {
      intent: `Pull fresh segments (${stale.length} stale peer${stale.length === 1 ? "" : "s"})`,
      command: `rsync -av <host>:${dir}/ ${dir}/`,
    },
    {
      intent: "Or stop doing it by hand",
      command: `# share ${dir} with Syncthing on every machine`,
    },
  ];
}
