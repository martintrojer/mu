// mu — mixed-fleet hazard detection.
//
// Three environment conditions that silently corrupt or diverge state on
// a multi-machine fleet. All three are cheap, pure-ish checks that run in
// the DEFAULT `mu doctor`, because unlike drift they cost microseconds
// and unlike drift they are PREVENTABLE — the operator can fix each one
// before it costs them data.
//
//   (a) DB inside the sync dir  -> corruption. THE footgun of the design.
//   (b) DB on a network mount   -> broken WAL locking.
//   (c) case-colliding names    -> collide on macOS, coexist on Linux.
//
// MU_SYNC_DIR does not exist yet (v2-sync introduces it). These checks
// read it if set and no-op otherwise, so they are live the moment sync
// lands rather than needing a follow-up.

import { existsSync, statfsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Db } from "./db.js";

export type HazardSeverity = "ok" | "warn" | "fail";

export interface FleetHazard {
  /** Stable token, used as the doctor row label. */
  name: string;
  severity: HazardSeverity;
  /** One-line summary for the row. */
  detail: string;
  /** Multi-line explanation + remediation, shown when non-ok. */
  remediation?: readonly string[];
}

// ─── (a) DB inside the sync dir ───────────────────────────────────────

/**
 * True iff `child` is inside `parent` (or is `parent`).
 *
 * Path-based, deliberately: the check must fire even when the DB file
 * does not exist yet, so it cannot rely on stat/inode identity. Both
 * sides are resolved to absolute form first, and a separator is appended
 * so `/sync-data` does not read as the parent of `/sync-database`.
 */
export function isPathInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * THE footgun of the whole sync design, and the reason it is `fail` rather
 * than `warn`.
 *
 * Sync tools (Syncthing, Dropbox, iCloud, rsync loops) copy files
 * whole-file and out of order. A live SQLite DB in WAL mode is THREE
 * files — `mu.db`, `mu.db-wal`, `mu.db-shm` — whose mutual consistency is
 * the entire basis of durability. A sync daemon that copies the main file
 * while the WAL is mid-checkpoint, or that resurrects a stale `-wal` from
 * another machine, produces a DB that opens fine and is silently corrupt.
 * Two machines writing the same synced file is worse still: last-writer
 * wins on the FILE, so an entire machine's history vanishes.
 *
 * mu's sync design specifically avoids this by shipping append-only
 * per-machine SEGMENTS (one writer per file, never contended) rather than
 * the DB itself. Putting the DB inside the sync dir defeats that on
 * purpose-built-to-be-safe transport, so it is a hard failure.
 */
export function checkDbInsideSyncDir(dbPath: string, syncDir: string | undefined): FleetHazard {
  if (syncDir === undefined || syncDir.trim() === "") {
    return {
      name: "db-vs-sync",
      severity: "ok",
      detail: "MU_SYNC_DIR not set (no sync configured)",
    };
  }
  if (!isPathInside(dbPath, syncDir)) {
    return { name: "db-vs-sync", severity: "ok", detail: "DB is outside the sync dir" };
  }
  return {
    name: "db-vs-sync",
    severity: "fail",
    detail: `DB is INSIDE MU_SYNC_DIR — this WILL corrupt it (${dbPath})`,
    remediation: [
      "The mu database must never live inside the synced folder.",
      "",
      "A live WAL-mode SQLite DB is three files (mu.db, -wal, -shm) whose mutual",
      "consistency is the basis of durability. File-sync tools copy whole files,",
      "out of order, and across machines: a stale -wal resurrected from a peer, or",
      "a main file copied mid-checkpoint, yields a DB that OPENS FINE and is",
      "silently corrupt. Two machines writing the same synced file is worse — last",
      "writer wins on the whole FILE, so one machine's entire history disappears.",
      "",
      "mu syncs append-only per-machine SEGMENTS precisely to avoid this: one",
      "writer per file, never contended, so any file-mover is adequate transport.",
      "",
      "Fix: move the DB out of the sync dir, e.g.",
      "  export MU_DB_PATH=$HOME/.local/state/mu/mu.db",
      "and keep MU_SYNC_DIR pointing at the shared folder for segments only.",
    ],
  };
}

// ─── (b) DB on a network mount ────────────────────────────────────────

/** Linux `statfs.f_type` magic numbers for filesystems where POSIX
 *  advisory locking is unreliable or absent. SQLite's WAL mode needs
 *  working locks AND shared memory; neither is dependable here.
 *
 *  Values from linux/magic.h. Kept as a table rather than inline so the
 *  list is auditable and extendable. */
const NETWORK_FS_MAGIC = new Map<number, string>([
  // Every value here is transcribed from linux/magic.h, not recalled.
  // An invented magic is worse than a missing one: it would either never
  // match (silent no-op) or match the wrong filesystem and warn falsely.
  [0x6969, "NFS"], // NFS_SUPER_MAGIC
  [0xff534d42, "CIFS/SMB"], // CIFS_SUPER_MAGIC
  [0xfe534d42, "SMB2"], // SMB2_SUPER_MAGIC
  [0x517b, "SMBFS"], // SMB_SUPER_MAGIC
  [0x65735546, "FUSE (may be sshfs/rclone/cloud drive)"], // FUSE_SUPER_MAGIC
  [0x00c36400, "Ceph"], // CEPH_SUPER_MAGIC
]);

/** Result of a filesystem probe. `unknown` is a first-class outcome:
 *  telling the operator "cannot determine" is honest, whereas claiming
 *  "ok" on a platform we cannot inspect would be a false assurance. */
export interface FsProbe {
  kind: "local" | "network" | "unknown";
  /** Human label for the detected fs, when known. */
  label: string;
}

/**
 * Classify the filesystem a path lives on.
 *
 * PORTABILITY, and why this degrades rather than guesses:
 *
 *   Linux   — `statfsSync().type` is a documented magic number, so the
 *             classification is exact.
 *   macOS   — `f_type` is a small driver INDEX, not a stable magic, so
 *             the same number means different things across releases.
 *             Comparing it would produce confident nonsense, so we do
 *             not; macOS falls through to `unknown`.
 *   Other   — `unknown`.
 *
 * Exported separately from the check so it can be unit-tested against
 * SYNTHETIC input: mounting NFS in a test suite is not feasible, so the
 * tests exercise `classifyFsType` (pure, takes the magic number) rather
 * than the syscall. Stated plainly because an untested detector is worse
 * than no detector.
 */
export function classifyFsType(magic: number, platform: string = process.platform): FsProbe {
  if (platform !== "linux") {
    // See above: f_type is not a portable magic off Linux.
    return { kind: "unknown", label: `unrecognised (${platform})` };
  }
  const network = NETWORK_FS_MAGIC.get(magic);
  if (network !== undefined) return { kind: "network", label: network };
  return { kind: "local", label: `local (0x${magic.toString(16)})` };
}

/** Probe the real filesystem for a path, falling back to `unknown` when
 *  the syscall is unavailable or the path does not exist yet. */
export function probeFilesystem(path: string): FsProbe {
  try {
    // Probe the nearest existing ancestor: the DB file may not exist on a
    // first run, but its directory tells us the same thing.
    let probeTarget = resolve(path);
    while (!existsSync(probeTarget)) {
      const parent = resolve(probeTarget, "..");
      if (parent === probeTarget) break;
      probeTarget = parent;
    }
    const stats = statfsSync(probeTarget);
    return classifyFsType(Number(stats.type));
  } catch {
    return { kind: "unknown", label: "probe failed" };
  }
}

/**
 * WARN rather than fail on a network mount.
 *
 * Warn, not fail, because it is not always fatal: a single machine using
 * an NFS home with no concurrent access often works, and refusing
 * outright would lock such an operator out of their own tool. But it IS
 * the second-most-common corruption cause after (a), because WAL needs
 * both advisory locking and a shared-memory file, and NFS/SMB/sshfs
 * deliver neither reliably. Symptoms are 'database is locked' under no
 * contention, or silent corruption under real contention.
 */
export function checkNetworkMount(
  dbPath: string,
  probe: FsProbe = probeFilesystem(dbPath),
): FleetHazard {
  if (probe.kind === "network") {
    return {
      name: "db-filesystem",
      severity: "warn",
      detail: `DB is on a network mount (${probe.label}) — WAL locking is unreliable there`,
      remediation: [
        `The DB appears to live on ${probe.label}.`,
        "",
        "SQLite's WAL mode needs working POSIX advisory locks AND a shared-memory",
        "file. NFS, SMB/CIFS and FUSE mounts (sshfs, rclone, cloud drives) provide",
        "neither dependably. Expect 'database is locked' with no contention, or",
        "silent corruption with real contention from parallel mu invocations.",
        "",
        "Fix: keep the DB on local disk and sync SEGMENTS instead —",
        "  export MU_DB_PATH=$HOME/.local/state/mu/mu.db",
        "That is what the segment design is for: append-only, single-writer files",
        "that any file-mover can carry safely.",
      ],
    };
  }
  if (probe.kind === "unknown") {
    return {
      name: "db-filesystem",
      severity: "ok",
      detail: `filesystem not classifiable on this platform (${probe.label}); assuming local`,
    };
  }
  return { name: "db-filesystem", severity: "ok", detail: `DB is on ${probe.label}` };
}

// ─── (c) case-colliding workstream names ──────────────────────────────

export interface CaseCollision {
  /** The names, as stored, that fold to the same lowercase form. */
  names: readonly string[];
  /** The shared case-folded form. */
  folded: string;
}

/**
 * Workstream names differing only by case.
 *
 * On ext4 these coexist happily. On APFS (macOS default,
 * case-INSENSITIVE though case-preserving) and on NTFS they collide, so
 * the same fleet reaches different states depending on which machine
 * applies an op first. Concretely: `workstreams.name` is UNIQUE and IS
 * the tmux session name, so on a Mac 'Foo' and 'foo' are one session and
 * one directory but two DB rows — and every workspace path derived from
 * the name aliases onto one directory.
 *
 * Detected in the DB rather than at write time on purpose: the rows may
 * have been created on Linux and only become a hazard when the fleet
 * gains a Mac, so this must be a standing check rather than a validation.
 *
 * SQL-side `LOWER()` is ASCII-only in SQLite, which is the right
 * comparison here: workstream names are already constrained to
 * `[a-z0-9_-]` by `isValidWorkstreamName`, so any collision within the
 * legal charset is ASCII. Names that predate the rule (or were inserted
 * via `mu sql`) still get caught because we fold in JS too.
 */
export function findCaseCollisions(db: Db): CaseCollision[] {
  const rows = db.prepare("SELECT name FROM workstreams ORDER BY name").all() as {
    name: string;
  }[];
  const byFolded = new Map<string, string[]>();
  for (const row of rows) {
    // toLocaleLowerCase would be locale-dependent (Turkish dotless i);
    // toLowerCase is stable, which is what a cross-machine check needs.
    const folded = row.name.toLowerCase();
    const bucket = byFolded.get(folded);
    if (bucket === undefined) byFolded.set(folded, [row.name]);
    else bucket.push(row.name);
  }
  const collisions: CaseCollision[] = [];
  for (const [folded, names] of byFolded) {
    if (names.length > 1) collisions.push({ folded, names });
  }
  return collisions;
}

export function checkCaseCollisions(db: Db): FleetHazard {
  const collisions = findCaseCollisions(db);
  if (collisions.length === 0) {
    return {
      name: "name-case",
      severity: "ok",
      detail: "no case-colliding workstream names",
    };
  }
  const shown = collisions
    .slice(0, 5)
    .map((c) => c.names.join(" / "))
    .join(", ");
  return {
    name: "name-case",
    severity: "warn",
    detail: `${collisions.length} case-colliding workstream name(s): ${shown}`,
    remediation: [
      "These workstream names differ only by letter case:",
      ...collisions.map((c) => `  ${c.names.join("  /  ")}`),
      "",
      "They coexist on Linux (ext4 is case-sensitive) but COLLIDE on macOS (APFS",
      "is case-insensitive) and on Windows (NTFS). Because a workstream name IS a",
      "tmux session name and seeds every workspace path, a Mac in the fleet sees",
      "one session and one directory where Linux sees two — so the fleet reaches",
      "different states depending on which machine applies an op first.",
      "",
      "Fix: rename one side to a distinct name before adding a Mac to the fleet.",
      "There is no in-place rename verb; back the DB up, re-init under the new",
      "name, and destroy the old one:",
      "  mu db backup <file>",
      "  mu workstream init <new-name>",
      "  mu workstream destroy <old-name>",
    ],
  };
}

// ─── the aggregate ────────────────────────────────────────────────────

/**
 * Run all three mixed-fleet checks. Cheap enough for the default doctor:
 * two path/string comparisons, one statfs, one indexed table scan.
 */
export function checkFleetHazards(
  db: Db,
  opts: { dbPath: string; syncDir?: string | undefined } = { dbPath: "" },
): FleetHazard[] {
  const syncDir = opts.syncDir !== undefined ? opts.syncDir : process.env.MU_SYNC_DIR;
  return [
    checkDbInsideSyncDir(opts.dbPath, syncDir),
    checkNetworkMount(opts.dbPath),
    checkCaseCollisions(db),
  ];
}
