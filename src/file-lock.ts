// mu — generic cross-process advisory lock, via atomic `fs.mkdir`.
//
// Extracted from src/agents/spawn-lock.ts, which had exactly this logic
// keyed to a tmux session name. Segments need the same primitive keyed to
// a sync directory, and two copies of a lock implementation is how they
// drift — so the mechanism lives here once and both callers name their own
// resource. spawn-lock.ts keeps its session-specific wrapper and its
// tests; only the body moved.
//
// Why a lockfile at all: every `mu` invocation is a separate short-lived
// process, so there is no in-process mutex to lean on. `fs.mkdir` is
// atomic and fails EEXIST when the directory exists — the classic
// primitive, no dependency (honours the ROADMAP anti-feature pledge).
//
// BEST-EFFORT BY DESIGN. A lock-acquire failure that is not contention (a
// read-only state dir, say) falls through to running the body UNLOCKED
// rather than failing the command. The lock narrows a race; it is not a
// correctness gate. For segments specifically, correctness comes from
// single-writer-per-file plus `UNIQUE (machine_id, hlc)` on ingest — the
// lock only stops two concurrent local flushes from interleaving lines in
// the same file.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultStateDir } from "./db.js";

/** Sub-directory of the state dir holding lock directories. */
export function locksDir(): string {
  return join(defaultStateDir(), "locks");
}

/** Default: max time to wait to acquire before proceeding unlocked. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;
/** A held lock older than this is presumed abandoned (crashed process). */
const DEFAULT_STALE_LOCK_MS = 30_000;
/** Poll interval while spinning. */
const RETRY_INTERVAL_MS = 25;

export interface FileLockOptions {
  acquireTimeoutMs?: number;
  staleLockMs?: number;
  /** Env var consulted for the acquire timeout, if any. */
  timeoutEnvVar?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function resolveTimeout(opts?: FileLockOptions): number {
  const envVar = opts?.timeoutEnvVar;
  if (envVar !== undefined) {
    const raw = process.env[envVar];
    if (raw !== undefined && raw !== "") {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return opts?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
}

/** Best-effort staleness probe. A vanished lock returns false so the
 *  caller simply retries the mkdir. */
async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const s = await stat(path);
    return Date.now() - s.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the lock directory at `lockPath`.
 *
 * Releases in a `finally`, so a throwing `fn` never leaks the lock.
 * Records pid + acquisition time in `meta.json` for stale-lock
 * diagnostics.
 */
export async function withFileLock<T>(
  lockPath: string,
  label: string,
  fn: () => Promise<T>,
  opts?: FileLockOptions,
): Promise<T> {
  const staleMs = opts?.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const deadline = Date.now() + resolveTimeout(opts);
  let held = false;

  try {
    await mkdir(locksDir(), { recursive: true });
  } catch {
    // Cannot even create the locks dir: run unlocked rather than refuse.
    return await fn();
  }

  while (!held) {
    try {
      await mkdir(lockPath); // atomic; EEXIST if already held
      held = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return await fn();
      if (await isStale(lockPath, staleMs)) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) return await fn();
      await sleep(RETRY_INTERVAL_MS);
    }
  }

  await writeFile(
    join(lockPath, "meta.json"),
    JSON.stringify({ pid: process.pid, label, acquiredAt: new Date().toISOString() }),
  ).catch(() => {});

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

/** Read a held lock's metadata, or null. Exposed for tests. */
export async function readFileLockMeta(
  lockPath: string,
): Promise<{ pid: number; label: string; acquiredAt: string } | null> {
  try {
    const raw = await readFile(join(lockPath, "meta.json"), "utf8");
    return JSON.parse(raw) as { pid: number; label: string; acquiredAt: string };
  } catch {
    return null;
  }
}
