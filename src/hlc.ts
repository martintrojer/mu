// mu — the hybrid logical clock that orders every op (VOCABULARY § HLC).
//
// WHY NOT A WALL-CLOCK TIMESTAMP
// ------------------------------
// `ops` are merged across machines by last-writer-wins on `hlc`. If that
// key were `new Date().toISOString()`, a laptop that sleeps for three
// days and wakes with a clock skewed BEHIND the devserver would stamp
// every new edit with a time that already passed — so on merge the
// laptop's fresh work looks older than the devserver's stale work and is
// silently discarded. No error, no conflict, just missing edits. That is
// the #1 way homegrown sync corrupts data.
//
// An HLC uses wall time as a HINT and a logical counter as the truth:
// the pair only ever increases, on this machine, forever. A backwards
// clock jump costs ordering PRECISION (ops bunch up on one millisecond)
// but never ordering CORRECTNESS.
//
// SERIALIZATION FORMAT
// --------------------
// A single lexicographically sortable TEXT, because `ORDER BY hlc` must
// equal causal order and SQLite compares TEXT bytewise:
//
//     <wall_ms:15 digits>.<counter:6 digits>.<machine_id>
//
// Example (wall=1780000000123, counter=7):
//
//     001780000000123.000007.9f1c8a2e-4b6d-4f0a-9c31-2f7c5d3e8a10
//
// - Both numeric parts are ZERO-PADDED to a fixed width. Without the
//   padding "9" would sort after "10" and the whole ordering guarantee
//   collapses.
// - 15 digits of wall_ms covers every representable JS timestamp
//   (max 8_640_000_000_000_000 is 16 digits, but that is year 275760;
//   15 digits runs to year 318857 — enough, and checked below).
// - 6 digits of counter allows 1_000_000 ops inside one millisecond
//   before the clock advances. Overflow throws rather than wrapping,
//   because wrapping would silently regress the order.
// - The separator is `.` — it cannot appear in a uuid (hex + `-` only),
//   so parsing is unambiguous and a machine_id can never spill into a
//   numeric field. It sorts below every digit and hex letter, so the
//   field boundary itself never perturbs the order.
// - machine_id is the LAST field and is a tiebreak only: two machines
//   that mint the same (wall, counter) get a stable, arbitrary but
//   total order instead of comparing equal.
//
// PERSISTENCE
// -----------
// Every mu invocation is a separate short-lived process, so an
// in-memory counter would reset constantly and mint duplicates. The
// clock state lives in the singleton `machine_identity` row
// (`last_wall`, `last_counter`), which is also where `machine_id`
// already lives — one row, one read, one write.

import type { Db } from "./db.js";

/** Zero-pad width for the wall-clock millisecond field. */
const WALL_WIDTH = 15;
/** Zero-pad width for the logical counter field. */
const COUNTER_WIDTH = 6;
/** Field separator. Cannot appear in a uuid. */
const SEP = ".";
/** Largest value each fixed-width field can hold. */
const MAX_WALL = 10 ** WALL_WIDTH - 1;
const MAX_COUNTER = 10 ** COUNTER_WIDTH - 1;

/** A parsed HLC. Never construct by hand — use `parseHlc` or `formatHlc`. */
export interface Hlc {
  /** Wall-clock hint, milliseconds since the epoch. */
  wallMs: number;
  /** Logical counter; breaks ties within one `wallMs`. */
  counter: number;
  /** The machine that minted this HLC (`machine_identity.machine_id`). */
  machineId: string;
}

/** Thrown when a TEXT value is not a well-formed HLC. */
export class HlcParseError extends Error {
  constructor(readonly value: string) {
    super(`Malformed HLC: ${JSON.stringify(value)}`);
    this.name = "HlcParseError";
  }
}

/** Thrown when a field would not fit its fixed width. A counter
 *  overflow means >1e6 ops landed in one millisecond; wrapping would
 *  silently regress causal order, so we fail loudly instead. */
export class HlcOverflowError extends Error {
  constructor(
    readonly field: "wall" | "counter",
    readonly value: number,
  ) {
    super(
      field === "counter"
        ? `HLC counter overflow (${value} > ${MAX_COUNTER}): more than ${MAX_COUNTER + 1} ops in one millisecond`
        : `HLC wall-clock overflow (${value} > ${MAX_WALL}): system clock is far in the future`,
    );
    this.name = "HlcOverflowError";
  }
}

/** Thrown when the singleton `machine_identity` row is missing. */
export class MachineIdentityMissingError extends Error {
  constructor() {
    super("machine_identity row (id = 1) is missing; the DB was not opened via openDb()");
    this.name = "MachineIdentityMissingError";
  }
}

/** Serialize `(wall_ms, counter, machine_id)` to the sortable TEXT form.
 *  See the module comment for the exact shape and an example. */
export function formatHlc(hlc: Hlc): string {
  const { wallMs, counter, machineId } = hlc;
  if (!Number.isInteger(wallMs) || wallMs < 0) throw new HlcParseError(String(wallMs));
  if (!Number.isInteger(counter) || counter < 0) throw new HlcParseError(String(counter));
  if (wallMs > MAX_WALL) throw new HlcOverflowError("wall", wallMs);
  if (counter > MAX_COUNTER) throw new HlcOverflowError("counter", counter);
  if (machineId.length === 0 || machineId.includes(SEP)) throw new HlcParseError(machineId);
  return `${String(wallMs).padStart(WALL_WIDTH, "0")}${SEP}${String(counter).padStart(
    COUNTER_WIDTH,
    "0",
  )}${SEP}${machineId}`;
}

/** Inverse of `formatHlc`. Throws `HlcParseError` on anything else —
 *  including the v1 placeholder `<iso>|<uuid>` shape. */
export function parseHlc(value: string): Hlc {
  const parts = value.split(SEP);
  if (parts.length !== 3) throw new HlcParseError(value);
  const [wall, counter, machineId] = parts;
  if (wall === undefined || counter === undefined || machineId === undefined) {
    throw new HlcParseError(value);
  }
  if (wall.length !== WALL_WIDTH || counter.length !== COUNTER_WIDTH || machineId.length === 0) {
    throw new HlcParseError(value);
  }
  if (!/^\d+$/.test(wall) || !/^\d+$/.test(counter)) throw new HlcParseError(value);
  return { wallMs: Number(wall), counter: Number(counter), machineId };
}

/** Total order over serialized HLCs: -1 / 0 / 1. Identical to bytewise
 *  string comparison (that is the whole point of the format), so
 *  `ORDER BY hlc` in SQL and `.sort(compareHlc)` in JS agree. */
export function compareHlc(a: string, b: string): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface ClockRow {
  machine_id: string;
  last_wall: number;
  last_counter: number;
}

/**
 * Mint the next HLC for this machine and persist the advance.
 *
 *     now = wall clock ms
 *     if now > last_wall:  wall = now,       counter = 0
 *     else:                wall = last_wall, counter = last_counter + 1
 *
 * The `else` branch is the monotonicity guarantee: when the clock
 * stalls, jumps backwards, or two ops land in the same millisecond, the
 * counter carries the order instead.
 *
 * ATOMICITY — a SINGLE `UPDATE … RETURNING` statement, not an explicit
 * transaction. SQLite makes one statement atomic and takes the write
 * lock for its duration, so the read-modify-write cannot interleave
 * with a competing `mu` process; `busy_timeout = 5000` (set by openDb)
 * makes the loser wait rather than fail. A read-then-write pair inside
 * BEGIN DEFERRED would be upgrade-deadlock prone under the parallel
 * spawn fan-out, and BEGIN IMMEDIATE would be a strictly bigger lock
 * for the same effect. `receiveHlc` cannot use this trick (its
 * three-way max is not expressible as one clean statement) so it does
 * take BEGIN IMMEDIATE.
 *
 * @param now Injectable clock, for tests. Defaults to `Date.now()`.
 */
export function nextHlc(db: Db, now: number = Date.now()): string {
  const row = db
    .prepare(
      `UPDATE machine_identity
          SET last_wall    = MAX(last_wall, @now),
              last_counter = CASE WHEN @now > last_wall THEN 0 ELSE last_counter + 1 END
        WHERE id = 1
        RETURNING machine_id, last_wall, last_counter`,
    )
    .get({ now: Math.floor(now) }) as ClockRow | undefined;
  if (!row) throw new MachineIdentityMissingError();
  return formatHlc({ wallMs: row.last_wall, counter: row.last_counter, machineId: row.machine_id });
}

/**
 * Advance the local clock past a peer's HLC while INGESTING their op,
 * and return the local HLC that now dominates it. This is what makes
 * "laptop edits after seeing the devserver's op" order correctly: the
 * laptop's next mint is guaranteed greater than anything it has seen,
 * even if its own wall clock is days behind.
 *
 *     wall = max(local_wall, remote_wall, now)
 *
 * The counter has three explicit cases, by which of the three won:
 *   - `now` strictly won            -> counter = 0 (fresh millisecond)
 *   - local and remote tie at max   -> counter = max(local_c, remote_c) + 1
 *   - only local is at max          -> counter = local_c + 1
 *   - only remote is at max         -> counter = remote_c + 1
 *
 * A remote HLC from the PAST therefore never drags the local clock
 * backwards — `max` keeps `local_wall`, and the counter still steps.
 *
 * ATOMICITY — BEGIN IMMEDIATE (`.immediate()`), because the three-way
 * max needs the old row in JS before the new value can be computed, so
 * unlike `nextHlc` it genuinely is a read-then-write pair.
 *
 * @param now Injectable clock, for tests. Defaults to `Date.now()`.
 */
export function receiveHlc(db: Db, remoteHlc: string, now: number = Date.now()): string {
  const remote = parseHlc(remoteHlc);
  const wallNow = Math.floor(now);
  const read = db.prepare(
    "SELECT machine_id, last_wall, last_counter FROM machine_identity WHERE id = 1",
  );
  const write = db.prepare(
    "UPDATE machine_identity SET last_wall = @wall, last_counter = @counter WHERE id = 1",
  );

  const advance = db.transaction((): string => {
    const row = read.get() as ClockRow | undefined;
    if (!row) throw new MachineIdentityMissingError();
    const wall = Math.max(row.last_wall, remote.wallMs, wallNow);
    const localAtMax = row.last_wall === wall;
    const remoteAtMax = remote.wallMs === wall;
    let counter: number;
    if (!localAtMax && !remoteAtMax) {
      counter = 0; // `now` strictly won: a genuinely fresh millisecond.
    } else if (localAtMax && remoteAtMax) {
      counter = Math.max(row.last_counter, remote.counter) + 1;
    } else if (localAtMax) {
      counter = row.last_counter + 1;
    } else {
      counter = remote.counter + 1;
    }
    if (counter > MAX_COUNTER) throw new HlcOverflowError("counter", counter);
    write.run({ wall, counter });
    return formatHlc({ wallMs: wall, counter, machineId: row.machine_id });
  });

  return advance.immediate();
}
