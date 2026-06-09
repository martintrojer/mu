// Cross-process advisory lock for the tmux-topology critical section of
// a spawn.
//
// Why this exists: every `mu` invocation is a separate short-lived
// process, so there is no in-process mutex to lean on. When an operator
// (or the model) fires several spawns in parallel —
//
//   for n in 1 2 3; do mu agent spawn scout-$n -w scratch & done; wait
//
// — each process runs the check-then-act in `createOrReusePane`:
// `sessionExists(mu-scratch)` → all see "no" → all call
// `tmux new-session -d -s mu-scratch`. Exactly one wins; the losers get
// "duplicate session", throw, and `rollbackSpawn` removes their agent
// row. Net effect: agents silently dropped (and sometimes duplicated as
// windows race). bug_parallel_spawn_races_drop_agents.
//
// The fix is a filesystem advisory lock keyed on the tmux SESSION name
// (the shared resource — two spawns into different sessions never
// contend). It wraps ONLY the fast topology + DB-insert section, NOT the
// slow liveness/readiness wait, so genuine parallelism (the whole point
// of `&`) is preserved: process A creates the session and inserts its
// row, releases, then waits for liveness while process B is already
// creating its own window.
//
// Mechanism: `fs.mkdir` is atomic and fails with EEXIST if the directory
// exists — the classic lockfile primitive, no extra dependency (honors
// the ROADMAP anti-feature pledge). A `meta.json` inside records pid +
// acquisition time for stale-lock diagnostics and breaking.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultStateDir } from "../db.js";

/** Sub-directory of the state dir holding spawn lock directories. */
function locksDir(): string {
  return join(defaultStateDir(), "locks");
}

/** Lock directory path for a given tmux session name. The session name
 *  is already validated ([a-z0-9_-] plus the `mu-` prefix), so it is a
 *  safe path segment. */
function lockPathForSession(session: string): string {
  return join(locksDir(), `spawn-${session}.lock`);
}

/** Max time to wait to acquire the lock before giving up (ms). A spawn's
 *  critical section is sub-second; this is generous headroom for a deep
 *  parallel fan-out queued behind one slow tmux server. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;

/** A held lock older than this is presumed abandoned (a crashed `mu`
 *  process that never released) and force-broken. Must comfortably
 *  exceed the critical section's real duration. */
const STALE_LOCK_MS = 30_000;

/** Poll interval while spinning for the lock (ms). */
const RETRY_INTERVAL_MS = 25;

export interface SpawnLockOptions {
  acquireTimeoutMs?: number;
  staleLockMs?: number;
}

function acquireTimeoutMs(opts?: SpawnLockOptions): number {
  const env = process.env.MU_SPAWN_LOCK_TIMEOUT_MS;
  if (env !== undefined && env !== "") {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Best-effort: is the lock at `path` older than `staleMs`? Used to break
 *  a lock left by a crashed process. Errors (race: lock vanished) return
 *  false so the caller just retries the mkdir. */
async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const s = await stat(path);
    return Date.now() - s.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the per-session spawn lock. Acquires (creating
 * `<state>/locks/` lazily), runs `fn`, and releases in a finally so a
 * throwing `fn` never leaks the lock.
 *
 * Lock-acquire failures that are NOT contention (e.g. a read-only state
 * dir) fall through to running `fn` WITHOUT the lock rather than blocking
 * the spawn outright: the lock is a best-effort race-narrowing device,
 * not a correctness gate, and a spawn that can't lock is strictly better
 * than a spawn that can't run. The narrow window it protects only matters
 * under genuine parallel contention.
 */
export async function withSpawnLock<T>(
  session: string,
  fn: () => Promise<T>,
  opts?: SpawnLockOptions,
): Promise<T> {
  const lockPath = lockPathForSession(session);
  const staleMs = opts?.staleLockMs ?? STALE_LOCK_MS;
  const deadline = Date.now() + acquireTimeoutMs(opts);
  let held = false;

  // Ensure the locks/ parent exists. If this fails (read-only FS, etc.)
  // we proceed unlocked — see the docstring rationale.
  try {
    await mkdir(locksDir(), { recursive: true });
  } catch {
    return await fn();
  }

  while (!held) {
    try {
      await mkdir(lockPath); // atomic; throws EEXIST if already held
      held = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Non-contention failure (permissions, etc.): run unlocked.
        return await fn();
      }
      // Contended. Break a stale lock from a crashed process, else
      // spin until the deadline.
      if (await isStale(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        // Timed out waiting. Proceed unlocked rather than fail the spawn;
        // the race is rare and rollback still protects correctness.
        return await fn();
      }
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  // Record holder metadata for diagnostics (best-effort).
  await writeFile(
    join(lockPath, "meta.json"),
    JSON.stringify({ pid: process.pid, session, acquiredAt: new Date().toISOString() }),
  ).catch(() => {});

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

/** Exposed for tests: read a held lock's metadata, or null if unparsable
 *  / absent. */
export async function readSpawnLockMeta(
  session: string,
): Promise<{ pid: number; session: string; acquiredAt: string } | null> {
  try {
    const raw = await readFile(join(lockPathForSession(session), "meta.json"), "utf8");
    return JSON.parse(raw) as { pid: number; session: string; acquiredAt: string };
  } catch {
    return null;
  }
}
