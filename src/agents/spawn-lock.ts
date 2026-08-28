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

import { join } from "node:path";
import { type FileLockOptions, locksDir, withFileLock } from "../file-lock.js";

/** Lock directory path for a given tmux session name. The session name
 *  is already validated ([a-z0-9_-] plus the `mu-` prefix), so it is a
 *  safe path segment. Exported for tests that need to read the lock's
 *  metadata directly via readFileLockMeta. */
export function lockPathForSession(session: string): string {
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

export interface SpawnLockOptions {
  acquireTimeoutMs?: number;
  staleLockMs?: number;
}

/**
 * Run `fn` while holding the per-session spawn lock.
 *
 * The mechanism (atomic mkdir, stale-lock breaking, release-in-finally,
 * proceed-unlocked-on-non-contention) lives in src/file-lock.ts so
 * segments can reuse it without a second copy. This wrapper owns the
 * session-keyed path and the spawn-specific timeouts.
 */
export async function withSpawnLock<T>(
  session: string,
  fn: () => Promise<T>,
  opts?: SpawnLockOptions,
): Promise<T> {
  const lockOpts: FileLockOptions = {
    acquireTimeoutMs: opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    staleLockMs: opts?.staleLockMs ?? STALE_LOCK_MS,
    timeoutEnvVar: "MU_SPAWN_LOCK_TIMEOUT_MS",
  };
  return withFileLock(lockPathForSession(session), session, fn, lockOpts);
}
