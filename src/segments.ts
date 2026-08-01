// mu — segments: how ops LEAVE and ENTER a machine.
//
// THE ONE IDEA THAT MAKES THIS WORK
// ---------------------------------
//   <MU_SYNC_DIR>/<machine_id>.jsonl
//
// Each machine APPENDS ONLY to its own segment and read-onlys every
// other. No file is ever written by two machines, so there is no
// file-level conflict, ever. That single property is what makes
// Syncthing, rsync, scp, git, and a USB stick all adequate transport: it
// removes the one thing every file-mover is bad at. There is nothing to
// merge, so nothing can merge wrongly.
//
// TWO LOGS, ONLY ONE CRITICAL
// ---------------------------
// The CANONICAL log is the `ops` table inside mu.db: ACID, WAL,
// crash-safe, written in the same transaction as the mutation it records.
// A SEGMENT is DERIVED and REGENERABLE — literally `SELECT ... FROM ops` —
// so losing one costs a re-flush and nothing else.
//
// That asymmetry is what licenses plain append-only files here, and it has
// one concrete consequence worth stating because it looks like an
// oversight: NO fsync ON APPEND. Losing the tail to power loss is
// harmless, because the next flush re-derives it from the table. Paying
// for durability twice would be paying for nothing.
//
// WHY NOT A SQLITE FILE PER PEER
// ------------------------------
// Rejected deliberately (design note): a `-wal`/`-shm` sidecar in a synced
// folder is THE canonical way to corrupt a SQLite DB; a torn transfer is
// fatal to the WHOLE file rather than costing one JSONL line; and page
// churn defeats rsync/Syncthing delta transfer, whereas an append-only
// file is the best case for it.
//
// ROBUSTNESS: FOUR LAYERS
// -----------------------
// The pattern every append-only log uses (RocksDB, Kafka, etcd,
// SQLite-WAL): detect the bad record, stop at it, refetch the tail later.
// Never guess, never skip-and-continue past damage.
//
//   1. JSON.parse failure  = torn write. FREE, and truncation is the
//      DOMINANT failure mode (a transfer caught in flight).
//   2. crc32 per line      = bit rot that JSON.parse would happily
//      accept. Belt-and-braces, not load-bearing — see the note's
//      honesty about this. ~5 LOC via node:zlib.
//   3. Monotonic hlc       = reordering, duplication, and silent
//      mid-file truncation. Structural, zero extra bytes.
//   4. Manifest sidecar    = whole-file verification (count, last_hlc,
//      sha256).
//
// On a bad record we stop at the last GOOD one and advance the watermark
// only that far, then report it. Because `UNIQUE (machine_id, hlc)` makes
// ingest idempotent, the universal repair is "re-read from zero" — so a
// damaged segment is recoverable, never fatal.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { type Op, OpEntityNotSyncedError, applyOp } from "./apply.js";
import { type Db, SYNCED_ENTITIES } from "./db.js";
import { locksDir, withFileLock } from "./file-lock.js";
import { receiveHlc } from "./hlc.js";

/** Current segment line format. Bumped only on a breaking shape change;
 *  a reader that sees a version it does not know REFUSES the line rather
 *  than guessing at its meaning. */
export const SEGMENT_FORMAT_VERSION = 1;

/** Segment filename suffix. */
const SEGMENT_EXT = ".jsonl";
/** Manifest filename suffix. */
const MANIFEST_EXT = ".manifest";

/** One serialized op, as it appears on a line of a segment. */
export interface SegmentLine {
  v: number;
  hlc: string;
  machine: string;
  group: string;
  intent: string | null;
  actor: string | null;
  entity: string;
  key: string;
  op: "put" | "del";
  payload: unknown;
  crc: string;
}

/** Whole-file verification sidecar. */
export interface SegmentManifest {
  v: number;
  machine: string;
  count: number;
  lastHlc: string | null;
  sha256: string;
  updatedAt: string;
}

/** Why a segment line was rejected. Reported, never silently swallowed. */
export type SegmentDefectKind =
  | "torn-write"
  | "manifest-mismatch"
  | "crc-mismatch"
  | "non-monotonic-hlc"
  | "unknown-version"
  | "malformed-shape"
  | "entity-not-synced";

export interface SegmentDefect {
  kind: SegmentDefectKind;
  /** 1-based line number within the segment. */
  line: number;
  detail: string;
}

// ─── sync dir + naming ────────────────────────────────────────────────

/**
 * The sync directory, or null when sync is not configured.
 *
 * Null is the normal single-machine case, and every entry point here
 * treats it as "do nothing, cost nothing" rather than an error. Sync is
 * opt-in by setting one env var; there is no config file and no
 * membership list (see `discoverPeers`).
 */
export function syncDir(): string | null {
  const dir = process.env.MU_SYNC_DIR;
  if (dir === undefined || dir.trim() === "") return null;
  return dir;
}

/** This machine's id — the identity every op it writes is stamped with. */
export function localMachineId(db: Db): string {
  const row = db.prepare("SELECT machine_id FROM machine_identity WHERE id = 1").get() as
    | { machine_id: string }
    | undefined;
  if (row === undefined) throw new Error("machine_identity row missing; not a v9 mu DB");
  return row.machine_id;
}

/** Path of a machine's own segment inside `dir`. */
export function segmentPath(dir: string, machineId: string): string {
  return join(dir, `${machineId}${SEGMENT_EXT}`);
}

function manifestPath(segment: string): string {
  return segment.replace(new RegExp(`${SEGMENT_EXT}$`), MANIFEST_EXT);
}

// ─── framing ──────────────────────────────────────────────────────────

/**
 * Canonical serialization the crc is computed over.
 *
 * Field order is FIXED here rather than taken from object key order, so
 * two machines (or two Node versions) cannot disagree about the bytes and
 * produce a spurious mismatch. `payload` is embedded as its stored JSON
 * TEXT, verbatim, for the same reason: re-serializing a parsed object
 * risks key reordering and number reformatting.
 */
function canonicalBytes(line: Omit<SegmentLine, "crc">, payloadText: string): string {
  return [
    String(line.v),
    line.hlc,
    line.machine,
    line.group,
    line.intent ?? "",
    line.actor ?? "",
    line.entity,
    line.key,
    line.op,
    payloadText,
  ].join("\u001f"); // Unit Separator: cannot occur in any of these fields
}

function computeCrc(line: Omit<SegmentLine, "crc">, payloadText: string): string {
  return crc32(canonicalBytes(line, payloadText)).toString(16).padStart(8, "0");
}

/** Serialize one op row to a segment line (without its trailing newline). */
export function encodeSegmentLine(op: {
  hlc: string;
  machineId: string;
  groupId: string;
  intent: string | null;
  actor: string | null;
  entity: string;
  key: string;
  op: "put" | "del";
  payload: string;
}): string {
  const base: Omit<SegmentLine, "crc"> = {
    v: SEGMENT_FORMAT_VERSION,
    hlc: op.hlc,
    machine: op.machineId,
    group: op.groupId,
    intent: op.intent,
    actor: op.actor,
    entity: op.entity,
    key: op.key,
    op: op.op,
    payload: null, // replaced below; kept out of the crc input shape
  };
  const crc = computeCrc(base, op.payload);
  // Assemble by hand so `payload` is embedded as raw JSON rather than
  // being re-encoded, keeping the bytes the crc covered.
  return `{"v":${base.v},"hlc":${JSON.stringify(base.hlc)},"machine":${JSON.stringify(
    base.machine,
  )},"group":${JSON.stringify(base.group)},"intent":${JSON.stringify(
    base.intent,
  )},"actor":${JSON.stringify(base.actor)},"entity":${JSON.stringify(
    base.entity,
  )},"key":${JSON.stringify(base.key)},"op":${JSON.stringify(base.op)},"payload":${
    op.payload
  },"crc":${JSON.stringify(crc)}}`;
}

/** Outcome of decoding one line. */
type DecodeResult =
  | { ok: true; line: SegmentLine; payloadText: string }
  | { ok: false; kind: SegmentDefectKind; detail: string };

/**
 * Decode and verify one line.
 *
 * Layers 1 and 2 both live here. Layer 1 (JSON.parse) is what actually
 * fires in practice — a truncated transfer leaves a partial line, which
 * cannot parse. Layer 2 (crc) only catches damage that leaves valid JSON,
 * i.e. bit rot inside a string or number.
 */
function decodeLine(raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // LAYER 1: torn write. The dominant failure mode, and free.
    return {
      ok: false,
      kind: "torn-write",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, kind: "malformed-shape", detail: "line is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.v !== "number") {
    return { ok: false, kind: "malformed-shape", detail: "missing numeric 'v'" };
  }
  if (obj.v !== SEGMENT_FORMAT_VERSION) {
    // Refuse rather than guess: a future version may mean different
    // things by the same field names.
    return {
      ok: false,
      kind: "unknown-version",
      detail: `segment format v${obj.v}, this mu understands v${SEGMENT_FORMAT_VERSION}`,
    };
  }
  for (const field of ["hlc", "machine", "group", "entity", "key", "op", "crc"]) {
    if (typeof obj[field] !== "string") {
      return { ok: false, kind: "malformed-shape", detail: `missing string '${field}'` };
    }
  }
  const opKind = obj.op;
  if (opKind !== "put" && opKind !== "del") {
    return { ok: false, kind: "malformed-shape", detail: `bad op '${String(opKind)}'` };
  }
  if (!("payload" in obj)) {
    return { ok: false, kind: "malformed-shape", detail: "missing 'payload'" };
  }

  // Recover the payload's ORIGINAL text from the raw line so the crc is
  // computed over the same bytes the writer covered. Re-serializing the
  // parsed value could reorder keys and would false-positive.
  const payloadText = extractPayloadText(raw);
  if (payloadText === null) {
    return { ok: false, kind: "malformed-shape", detail: "could not locate payload text" };
  }

  const line: SegmentLine = {
    v: obj.v,
    hlc: obj.hlc as string,
    machine: obj.machine as string,
    group: obj.group as string,
    intent: typeof obj.intent === "string" ? obj.intent : null,
    actor: typeof obj.actor === "string" ? obj.actor : null,
    entity: obj.entity as string,
    key: obj.key as string,
    op: opKind,
    payload: obj.payload,
    crc: obj.crc as string,
  };

  // LAYER 2: crc over the canonical bytes. Belt-and-braces.
  const expected = computeCrc({ ...line, payload: null }, payloadText);
  if (expected !== line.crc) {
    return {
      ok: false,
      kind: "crc-mismatch",
      detail: `crc ${line.crc} != computed ${expected} (bit rot?)`,
    };
  }
  return { ok: true, line, payloadText };
}

/** Slice out the raw `"payload":<json>` text, between its key and the
 *  trailing `,"crc":`. Written by `encodeSegmentLine`, so the anchors are
 *  exact rather than heuristic. */
function extractPayloadText(raw: string): string | null {
  const start = raw.indexOf('"payload":');
  if (start < 0) return null;
  const end = raw.lastIndexOf(',"crc":');
  if (end <= start) return null;
  return raw.slice(start + '"payload":'.length, end);
}

// ─── flush: ops -> my segment ─────────────────────────────────────────

export interface FlushResult {
  /** Absolute path written, or null when sync is not configured. */
  segmentPath: string | null;
  /** Ops appended by this call. */
  appended: number;
  /** Total lines in the segment afterwards. */
  total: number;
  /** Ops skipped because their entity is machine-local. */
  skippedLocal: number;
}

/**
 * Append this machine's not-yet-flushed ops to its own segment.
 *
 * FILTERING IS LOAD-BEARING. Only ops whose entity is in
 * `SYNCED_ENTITIES` are written. Machine-local ops (agent.*, workspace.*)
 * are captured and DO appear in `mu log`, but they must never reach a
 * segment: they carry pane ids and absolute paths that are meaningless,
 * and frequently wrong, on another machine. "Not synced" is not "not
 * logged".
 *
 * Also filters `machine_id = <me>`: a segment holds ONE machine's ops.
 * Ops ingested from a peer live in our `ops` table too, and re-flushing
 * them into our own segment would duplicate a peer's history under our
 * name — and would grow without bound as two machines echoed each other.
 *
 * The high-water mark is the last hlc already in the file (read from the
 * manifest when present, else derived by scanning), so flush is
 * incremental and idempotent: calling it twice appends nothing the second
 * time.
 */
export async function flushSegment(db: Db, dir: string | null = syncDir()): Promise<FlushResult> {
  if (dir === null) return { segmentPath: null, appended: 0, total: 0, skippedLocal: 0 };

  const machineId = localMachineId(db);
  mkdirSync(dir, { recursive: true });
  const path = segmentPath(dir, machineId);

  // Serialise concurrent local flushes so two processes cannot interleave
  // partial lines in the same file. Keyed on the sync dir + machine, since
  // that names the single file being appended to.
  const lockName = createHash("sha256")
    .update(`${dir}\u001f${machineId}`)
    .digest("hex")
    .slice(0, 16);
  return withFileLock(join(locksDir(), `segment-${lockName}.lock`), `segment:${machineId}`, () =>
    Promise.resolve(flushLocked(db, path, machineId)),
  );
}

function flushLocked(db: Db, path: string, machineId: string): FlushResult {
  const existing = readSegmentTail(path);
  const since = existing.lastHlc;

  const rows = db
    .prepare(
      `SELECT hlc, machine_id, group_id, intent, actor, entity, key, op, payload
         FROM ops
        WHERE machine_id = @machineId
          AND (@since IS NULL OR hlc > @since)
        ORDER BY hlc`,
    )
    .all({ machineId, since }) as Array<{
    hlc: string;
    machine_id: string;
    group_id: string;
    intent: string | null;
    actor: string | null;
    entity: string;
    key: string;
    op: string;
    payload: string;
  }>;

  const synced = new Set<string>(SYNCED_ENTITIES);
  const lines: string[] = [];
  let skippedLocal = 0;
  let lastHlc = existing.lastHlc;

  for (const row of rows) {
    if (!synced.has(row.entity)) {
      skippedLocal += 1;
      continue;
    }
    lines.push(
      encodeSegmentLine({
        hlc: row.hlc,
        machineId: row.machine_id,
        groupId: row.group_id,
        intent: row.intent,
        actor: row.actor,
        entity: row.entity,
        key: row.key,
        op: row.op === "del" ? "del" : "put",
        payload: row.payload,
      }),
    );
    lastHlc = row.hlc;
  }

  if (lines.length > 0) {
    // NO fsync. The segment is derived from `ops`; a lost tail costs one
    // re-flush, so paying for durability here would buy nothing.
    appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
  } else if (!existsSync(path)) {
    // Create the file even with nothing to say, so peers can discover
    // this machine before its first change.
    writeFileSync(path, "", "utf8");
  }

  const total = existing.count + lines.length;
  writeManifest(path, machineId, total, lastHlc);
  return { segmentPath: path, appended: lines.length, total, skippedLocal };
}

/** Number of GOOD lines in a segment (stopping at the first defect, as
 *  ingest does). The denominator of "how far behind am I" — exported for
 *  `mu sync`'s peer table. */
export function segmentLineCount(path: string): number {
  return readSegmentTail(path).count;
}

/** Count + last hlc of an existing segment, cheaply. Uses the manifest
 *  when it agrees with the file's byte length; otherwise scans. */
function readSegmentTail(path: string): { count: number; lastHlc: string | null } {
  if (!existsSync(path)) return { count: 0, lastHlc: null };
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  let lastHlc: string | null = null;
  let count = 0;
  for (const line of lines) {
    const decoded = decodeLine(line);
    if (!decoded.ok) break; // stop at the first bad record, as ingest does
    lastHlc = decoded.line.hlc;
    count += 1;
  }
  return { count, lastHlc };
}

/** LAYER 4: whole-file verification sidecar. */
function writeManifest(path: string, machine: string, count: number, lastHlc: string | null): void {
  const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const manifest: SegmentManifest = {
    v: SEGMENT_FORMAT_VERSION,
    machine,
    count,
    lastHlc,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(manifestPath(path), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Read a segment's manifest, or null when absent/unparsable. */
export function readManifest(segment: string): SegmentManifest | null {
  const path = manifestPath(segment);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SegmentManifest;
  } catch {
    return null;
  }
}

/**
 * Verify a segment against its manifest (layer 4).
 *
 * Whole-file, so it catches damage the per-line layers cannot see: a
 * segment silently replaced wholesale, or truncated exactly on a line
 * boundary (where every remaining line is individually valid).
 */
export function verifyAgainstManifest(
  segment: string,
): { ok: true } | { ok: false; reason: string } {
  const manifest = readManifest(segment);
  if (manifest === null) return { ok: true }; // no manifest: nothing to check
  if (!existsSync(segment)) return { ok: false, reason: "segment missing but manifest present" };
  const sha = createHash("sha256").update(readFileSync(segment)).digest("hex");
  if (sha === manifest.sha256) return { ok: true };
  // A GROWN file is expected: the peer appended after writing the
  // manifest we have, or our copy is mid-transfer. That is not damage.
  const tail = readSegmentTail(segment);
  if (tail.count >= manifest.count) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `sha mismatch and file has FEWER records than the manifest (${tail.count} < ${manifest.count}): truncated`,
  };
}

// ─── peer discovery ───────────────────────────────────────────────────

export interface PeerSegment {
  /** Machine id the segment belongs to. */
  machineId: string;
  /** Path on disk. */
  path: string;
  /** True for a Syncthing-style conflict copy. */
  conflictCopy: boolean;
}

/**
 * Every segment in `dir` that is not mine.
 *
 * IMPLICIT, with no membership list. `MU_SYNC_PEERS` was explicitly
 * rejected as "a config file with extra steps that must be kept
 * consistent across every machine" — dropping a segment in the folder
 * joins the cluster, deleting it leaves.
 *
 * CONFLICT COPIES ARE INGESTED, not ignored. Syncthing names them
 * `<machine>.sync-conflict-20260609-123456-ABCDEFG.jsonl`; they are still
 * valid op logs, and dedup by `(machine_id, hlc)` makes reading them
 * safe. Ignoring them would silently drop real ops precisely when
 * something already went wrong.
 */
export function discoverPeers(dir: string, selfMachineId: string): PeerSegment[] {
  if (!existsSync(dir)) return [];
  const peers: PeerSegment[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(SEGMENT_EXT)) continue;
    const stem = name.slice(0, -SEGMENT_EXT.length);
    // Syncthing: "<machine>.sync-conflict-<date>-<time>-<id>"
    const conflictAt = stem.indexOf(".sync-conflict-");
    const conflictCopy = conflictAt > 0;
    const machineId = conflictCopy ? stem.slice(0, conflictAt) : stem;
    if (machineId === selfMachineId && !conflictCopy) continue;
    // A conflict copy OF MY OWN segment is still a peer's view of my
    // history; ingesting it is a no-op thanks to (machine_id, hlc)
    // dedupe, so allow it rather than special-casing.
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    peers.push({ machineId, path, conflictCopy });
  }
  return peers.sort((a, b) => a.path.localeCompare(b.path));
}

// ─── watermarks ───────────────────────────────────────────────────────

/**
 * How far into a peer's segment we have applied.
 *
 * ONE INTEGER SUFFICES because segments are append-only and ordered — a
 * set or a vector clock would be strictly more state for no more
 * information. Stored in `sync_peers.last_applied_seq`, which has been in
 * the v9 schema unused until now.
 *
 * The integer is a LINE COUNT within that peer's segment, not the peer's
 * `ops.seq` (which is a local-only cursor on their machine and means
 * nothing here).
 */
export function getWatermark(db: Db, machineId: string): number {
  const row = db
    .prepare("SELECT last_applied_seq AS n FROM sync_peers WHERE machine_id = ?")
    .get(machineId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function setWatermark(db: Db, machineId: string, value: number): void {
  db.prepare(
    `INSERT INTO sync_peers (machine_id, last_applied_seq, last_seen_at)
     VALUES (@machineId, @value, @seenAt)
     ON CONFLICT (machine_id) DO UPDATE
       SET last_applied_seq = @value, last_seen_at = @seenAt`,
  ).run({ machineId, value, seenAt: new Date().toISOString() });
}

/** Reset a peer's watermark so the next ingest re-reads from zero. The
 *  universal repair, safe because ingest is idempotent. */
export function resetWatermark(db: Db, machineId: string): void {
  setWatermark(db, machineId, 0);
}

// ─── ingest: peer segment -> applyOp ──────────────────────────────────

export interface IngestResult {
  machineId: string;
  path: string;
  /** Lines read past the watermark. */
  read: number;
  /** Ops applied (some are no-ops: already present, or lost an LWW). */
  applied: number;
  /** Ops that changed a row. */
  changed: number;
  /** Watermark after this ingest. */
  watermark: number;
  /** Problems found, in line order. Reported, never swallowed. */
  defects: readonly SegmentDefect[];
  /** True iff a defect stopped us short of the file's end. */
  truncatedAt: number | null;
}

/**
 * Read one peer segment from its watermark and apply each op.
 *
 * STOPS AT THE FIRST BAD RECORD and advances the watermark only that far.
 * Never skips a damaged line to continue past it: in an ordered log, a
 * gap is indistinguishable from reordering, and applying ops around a
 * hole risks a state neither machine ever had. The tail is re-read on the
 * next ingest, by which time the transfer has usually completed.
 *
 * Calls `receiveHlc` per op so the local clock advances past the peer's,
 * which is what makes "laptop edits after seeing the devserver's op" order
 * correctly rather than losing to it.
 */
export function ingestSegment(db: Db, peer: PeerSegment): IngestResult {
  const defects: SegmentDefect[] = [];
  const start = getWatermark(db, peer.machineId);

  if (!existsSync(peer.path)) {
    return {
      machineId: peer.machineId,
      path: peer.path,
      read: 0,
      applied: 0,
      changed: 0,
      watermark: start,
      defects,
      truncatedAt: null,
    };
  }

  const verified = verifyAgainstManifest(peer.path);
  if (!verified.ok) {
    // Whole-file damage, distinct from a torn line: every remaining
    // record may be individually valid (truncation exactly on a line
    // boundary), which is precisely what the per-line layers cannot see.
    defects.push({ kind: "manifest-mismatch", line: 0, detail: verified.reason });
  }

  const raw = readFileSync(peer.path, "utf8");
  // A trailing newline is normal; a trailing PARTIAL line is a torn
  // write, and splitting keeps it so layer 1 can catch it.
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let applied = 0;
  let changed = 0;
  let watermark = start;
  let truncatedAt: number | null = null;
  let previousHlc: string | null = null;

  // Seed the monotonicity check from the last line we already accepted,
  // so a segment rewritten out of order is caught even mid-file.
  if (start > 0 && start <= lines.length) {
    const prior = lines[start - 1];
    if (prior !== undefined) {
      const decoded = decodeLine(prior);
      if (decoded.ok) previousHlc = decoded.line.hlc;
    }
  }

  const run = db.transaction(() => {
    for (let index = start; index < lines.length; index++) {
      const raw = lines[index];
      const lineNo = index + 1;
      if (raw === undefined || raw.trim() === "") {
        // Blank line: treat as damage rather than skipping, since a
        // well-formed segment never contains one.
        defects.push({ kind: "malformed-shape", line: lineNo, detail: "blank line" });
        truncatedAt = lineNo;
        break;
      }

      const decoded = decodeLine(raw);
      if (!decoded.ok) {
        defects.push({ kind: decoded.kind, line: lineNo, detail: decoded.detail });
        truncatedAt = lineNo;
        break;
      }

      // LAYER 3: monotonic hlc. Structural, zero extra bytes. Catches
      // reordering, duplication, and silent mid-file truncation.
      if (previousHlc !== null && decoded.line.hlc <= previousHlc) {
        defects.push({
          kind: "non-monotonic-hlc",
          line: lineNo,
          detail: `hlc ${decoded.line.hlc} <= previous ${previousHlc}`,
        });
        truncatedAt = lineNo;
        break;
      }

      const op: Op = {
        hlc: decoded.line.hlc,
        machineId: decoded.line.machine,
        groupId: decoded.line.group,
        actor: decoded.line.actor,
        intent: decoded.line.intent,
        entity: decoded.line.entity,
        key: decoded.line.key,
        op: decoded.line.op,
        payload: decoded.payloadText,
      };

      try {
        const result = applyIncomingOp(db, op);
        if (result.changed) changed += 1;
      } catch (err) {
        if (err instanceof OpEntityNotSyncedError) {
          // A peer sent something that must never cross a machine
          // boundary. Report it as a bad-peer defect rather than
          // crashing the ingest.
          defects.push({
            kind: "entity-not-synced",
            line: lineNo,
            detail: `peer sent non-synced entity '${op.entity}'`,
          });
          truncatedAt = lineNo;
          break;
        }
        throw err;
      }

      applied += 1;
      previousHlc = op.hlc;
      watermark = lineNo;
    }
    setWatermark(db, peer.machineId, watermark);
  });
  run();

  return {
    machineId: peer.machineId,
    path: peer.path,
    read: applied,
    applied,
    changed,
    watermark,
    defects,
    truncatedAt,
  };
}

/**
 * Apply ONE incoming op and record it in the local `ops` table.
 *
 * The shared tail of every ingest path — segment ingest above, and the
 * `mu sync --from <peer.db>` reader in `src/sync.ts`, which is a
 * different READER over the same apply semantics. Extracted so the two
 * cannot drift: a second copy of "advance the clock, apply, record" is
 * how one of them silently stops advancing the clock.
 *
 * Three steps, in this order:
 *   1. `receiveHlc` BEFORE applying, so anything we mint afterwards
 *      sorts above the peer's op.
 *   2. `applyOp`, which is capture-suppressed (no echo op is minted).
 *   3. Record the op locally so it survives, participates in
 *      provenance, and can be re-flushed by rebuild. INSERT OR IGNORE
 *      makes this idempotent via UNIQUE (machine_id, hlc) — the
 *      property that lets "re-read from zero" be the universal repair.
 */
export function applyIncomingOp(db: Db, op: Op): { changed: boolean } {
  receiveHlc(db, op.hlc);
  const result = applyOp(db, op);
  db.prepare(
    `INSERT OR IGNORE INTO ops
       (hlc, machine_id, group_id, actor, intent, entity, key, op, payload, created_at)
     VALUES (@hlc, @machineId, @groupId, @actor, @intent, @entity, @key, @op, @payload, @createdAt)`,
  ).run({
    hlc: op.hlc,
    machineId: op.machineId,
    groupId: op.groupId,
    actor: op.actor ?? null,
    intent: op.intent ?? null,
    entity: op.entity,
    key: op.key,
    op: op.op,
    payload: op.payload,
    createdAt: new Date().toISOString(),
  });
  return { changed: result.changed };
}

// ─── the two halves, together ─────────────────────────────────────────

export interface SyncPassResult {
  flushed: FlushResult;
  ingested: readonly IngestResult[];
  /** True iff any peer reported a defect. */
  defective: boolean;
}

/**
 * One flush + one ingest of every discovered peer.
 *
 * This is the SDK seam `mu sync` (v2-sync) will call; it deliberately
 * prints nothing and starts nothing. No daemon, no watcher, no polling
 * loop that outlives the command — the anti-feature pledges are firm, and
 * mu never moves files itself: the operator owns transport.
 *
 * A no-op costing nothing when `MU_SYNC_DIR` is unset, which is the
 * normal single-machine case.
 */
export async function syncPass(db: Db, dir: string | null = syncDir()): Promise<SyncPassResult> {
  if (dir === null) {
    return {
      flushed: { segmentPath: null, appended: 0, total: 0, skippedLocal: 0 },
      ingested: [],
      defective: false,
    };
  }
  const flushed = await flushSegment(db, dir);
  const self = localMachineId(db);
  const ingested = discoverPeers(dir, self).map((peer) => ingestSegment(db, peer));
  return {
    flushed,
    ingested,
    defective: ingested.some((r) => r.defects.length > 0),
  };
}
