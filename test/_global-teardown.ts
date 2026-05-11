// Global vitest setup/teardown hook.
//
// Two layers stacked here, both from bug_test_suite_flake_leaks_isolation:
//
//   LAYER 3 (the real fix) — ONE dedicated `tmux -L <socket>` server per
//   `npm test` invocation. The integration suite never touches the user's
//   default tmux socket (the one `tmux ls` in their interactive shell
//   shows). Two concurrent `npm test` runs (orchestrator + worker agent)
//   pick different sockets and can't possibly contend on session names.
//   The user's interactive sessions are invisible to the suite, and
//   suite-residue is invisible to the user.
//
//   LAYER 2 (round-4 — DB-rooted allowlist) — a safety net for any
//   test that bypasses the private socket and accidentally creates a
//   session on the user's DEFAULT socket. The sweep computes an
//   allowlist of names we MUST NEVER kill — every workstream name in
//   the user's real DB plus the orchestrator's own `$MU_SESSION` — and
//   kills any other `mu-*` session on the default socket.
//
//   Round-3 Part B used the same approach but ALSO captured a snapshot
//   of `mu-*` sessions present at module-load time. That snapshot is
//   gone (round-4 — bug_test_flake_round_4_self_heal): leftover test
//   residue from a partially-broken run on the user's default socket
//   would get "grandfathered in" as protected forever, defeating the
//   self-healing intent of the sweep. The DB is the only source of
//   truth for what the user considers a real workstream; an ad-hoc
//   `tmux new-session -t mu-foo` with no DB row is now killed by the
//   sweep (the user can `mu workstream init foo` to register it,
//   which they'd need to do anyway to use it as a workstream).
//
// CONTRACT
//
// vitest's globalSetup contract: this file exports `setup()` (runs once
// before the suite) and `teardown()` (runs once after). Both are async.
// globalSetup runs in vitest's main thread, BEFORE any worker fork is
// created. Empirically (see `mu-test fork` probe in setup.ts), the env
// vitest mutates inside setup() IS visible to forks — so `setup()`
// is a working seam. BUT the contract is fragile: `process.env`
// mutation in async hooks can race with worker spawn on some
// vitest pool variants. To eliminate the risk entirely (round-3 fix
// for bug_test_flake_round_3 — Part A), we set `MU_TMUX_SOCKET` at
// MODULE LOAD time, before vitest has a chance to do anything else.
// Module load happens before setup() and unambiguously before any
// fork pool spins up. The setup() hook then bootstraps the actual
// tmux server (and reverts the env on bootstrap failure for
// graceful fallback).
//
// The realExecutor in src/tmux.ts reads `MU_TMUX_SOCKET` per-call (see
// `tmuxSocketArgs`) and prepends `-L <socket>` to every tmux invocation
// when set. Production code never sets the var; this file is the only
// caller.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { execa } from "execa";

// ─── Layer 3: dedicated tmux socket ────────────────────────────────

/**
 * Unique socket name per `npm test` run. tmux derives the socket path
 * from this: on Linux it lands at `/tmp/tmux-<uid>/<name>`, on macOS
 * under `$TMPDIR/tmux-<uid>/<name>`. Using a fresh name per run means
 * concurrent runs on the same machine never share a server.
 *
 * Captured at module-load time so setup() and teardown() agree even if
 * something later mutates `process.env.MU_TMUX_SOCKET`.
 */
const TEST_SOCKET = `mu-test-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.floor(
  Math.random() * 36 ** 6,
)
  .toString(36)
  .padStart(6, "0")}`;

// Round-3 Part A: publish the socket name on process.env at MODULE LOAD
// time, BEFORE the vitest pool has a chance to spawn workers. This is
// the belt-and-suspenders fix for the worry that `process.env`
// mutation inside an async setup() hook races with fork spawn on some
// vitest pool variants. test/_setup.ts (per-fork) has
// MU_TMUX_SOCKET on its allowlist, so forks inherit this value as-is.
// If the actual tmux server bootstrap inside setup() FAILS, we
// `delete process.env.MU_TMUX_SOCKET` there to fall back gracefully
// (otherwise forks would route through `-L <socket>` to a non-existent
// server and every tmux call would error).
process.env.MU_TMUX_SOCKET = TEST_SOCKET;

async function bootstrapPrivateTmuxServer(): Promise<void> {
  // tmux lazily starts the server on the first command; an explicit
  // `start-server` is the lightest no-op call that materialises it.
  // We do this BEFORE setting MU_TMUX_SOCKET on process.env so the
  // bootstrap call itself goes through the explicit -L (not relying
  // on the same env-read path the realExecutor uses).
  //
  // `-f /dev/null` SKIPS the user's ~/.tmux.conf. This matters: a
  // typical config uses `run-shell` for status-bar plugins (TPM,
  // network probes, hostname pills, etc.), each of which adds
  // ~1–4s to the FIRST `new-session` after server startup. On the
  // dev box that motivated this task, a single integration test
  // ballooned 3s→48s before `-f /dev/null` was added. The user's
  // config has zero relevance to test correctness — the suite drives
  // tmux through the documented protocol, not through bound keys.
  const r = await execa("tmux", ["-L", TEST_SOCKET, "-f", "/dev/null", "start-server"], {
    reject: false,
  });
  if (r.exitCode !== 0) {
    // Don't crash the suite — fall back to the user's default socket
    // and rely on Layer 1+2 (unique names + sweep) for isolation.
    // Loud warning so a CI failure stays diagnosable.
    //
    // Round-3 Part A: undo the module-load env publish so forks don't
    // route through `-L <bogus-socket>` and turn every tmux call into
    // a connect-failure.
    const key = "MU_TMUX_SOCKET";
    delete process.env[key];
    console.warn(
      `[mu-test global-setup] failed to bootstrap private tmux socket "${TEST_SOCKET}": ${r.stderr}; falling back to user's default tmux server`,
    );
  }
  // On success: nothing to do — process.env.MU_TMUX_SOCKET is already
  // set from the module-load assignment above.
}

async function killPrivateTmuxServer(): Promise<void> {
  if (process.env.MU_TMUX_SOCKET !== TEST_SOCKET) return;
  // `kill-server` nukes every session/window/pane in one call. No
  // per-session iteration needed; this is what makes Layer 3 the
  // "real fix" — there's literally nothing to leak past this point.
  await execa("tmux", ["-L", TEST_SOCKET, "kill-server"], { reject: false });
  const key = "MU_TMUX_SOCKET";
  delete process.env[key];
}

// ─── Layer 2 (round-4): DB-rooted default-socket sweep ────────────

/**
 * Round-4 replaced round-3's two-source allowlist (pre-existing
 * snapshot + DB) with a DB-only allowlist. The pre-existing snapshot
 * was a self-locking trap: leftover test residue on the user's
 * default socket at module-load time was "grandfathered in" as
 * protected forever, defeating the self-healing intent of the sweep
 * (see bug_test_flake_round_4_self_heal). The orchestrator had to
 * manually `tmux kill-session` 7 leaked sessions because each new
 * test run snapshotted them as preexisting and protected them.
 *
 * The allowlist approach inverts the question: instead of "does this
 * name look like test fixture residue?" we ask "is this name something
 * we KNOW we must protect?" Anything else is killed.
 *
 * The allowlist has two sources, unioned:
 *
 *   1. USER WORKSTREAMS — every workstream name in the user's REAL
 *      mu DB (`~/.local/state/mu/mu.db` or `$XDG_STATE_HOME/mu/mu.db`).
 *      A `mu-<name>` session matching one of these is the user's
 *      workstream session, even if it was created mid-suite by an
 *      orchestrator agent. We can't open the DB through the SDK
 *      `openDb()` because round-2 added a hard guard that REFUSES to
 *      open the user DB during vitest — so we open via better-sqlite3
 *      directly with `{ readonly: true }`. Reading is metadata-only;
 *      the readonly flag enforces "no writes possible" at the SQLite
 *      layer (and the round-2 guard's intent was to prevent test
 *      WRITES, not metadata reads).
 *
 *   2. THE ORCHESTRATOR'S OWN SESSION — `mu-$MU_SESSION` if
 *      `$MU_SESSION` is set in the parent shell. Belt-and-suspenders
 *      protection for the workstream the orchestrator is actively
 *      running in, in case its DB row was somehow not visible at the
 *      moment buildAllowlist() ran (DB locked, schema mismatch, etc).
 *
 * Anything on the default socket starting with `mu-` and NOT in the
 * union of those two sets is, by elimination, test residue — a
 * session our suite created by accidentally bypassing the private
 * `-L <socket>` (legacy hardcoded-name tests, future tests that spawn
 * `execa("tmux", …)` directly without routing through src/tmux.ts,
 * etc). We kill it.
 *
 * Cost: an ad-hoc `tmux new-session -t mu-foo` with no DB row gets
 * killed by the sweep. Workaround: `mu workstream init foo` first
 * (which the user would need to do anyway to use it as a workstream).
 */

/**
 * Compute the user's REAL DB path the same way src/db.ts does, but
 * WITHOUT going through `defaultDbPath()` (which honours `MU_DB_PATH`
 * and would land on a per-test temp DB) and WITHOUT going through
 * `openDb()` (which has a hard guard refusing to open the user DB
 * under vitest). We need the user DB specifically and metadata-only.
 */
function userDbPath(): string {
  const home = process.env.HOME ?? homedir();
  const xdg = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
  return join(xdg, "mu", "mu.db");
}

function readUserWorkstreamsFromDb(): ReadonlySet<string> {
  const path = userDbPath();
  if (!existsSync(path)) return new Set();
  let db: Database.Database | undefined;
  try {
    // readonly: true — SQLite refuses every write at the storage
    //   layer, so even a buggy query can't mutate user state.
    // fileMustExist: true — don't accidentally CREATE the user DB.
    db = new Database(path, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT name FROM workstreams").all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  } catch (err) {
    // Schema mismatch (DB on a newer version), permission denied,
    // SQLite locked, etc. We fail OPEN — better to leave a stray
    // session than to nuke the user's workstreams.
    console.warn(
      `[mu-test global-setup] could not read user workstreams from ${path}: ${err instanceof Error ? err.message : String(err)}; allowlist falls back to $MU_SESSION only`,
    );
    return new Set();
  } finally {
    db?.close();
  }
}

/**
 * The protected allowlist of `mu-*` session names that the sweep
 * MUST NEVER kill. Computed lazily at sweep time so we always pick
 * up workstreams the user added to their DB DURING the suite
 * (e.g. an orchestrator agent's `mu workstream init` mid-run).
 */
function buildAllowlist(): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const ws of readUserWorkstreamsFromDb()) {
    allowed.add(`mu-${ws}`);
  }
  const orchSession = process.env.MU_SESSION;
  if (orchSession !== undefined && orchSession.length > 0) {
    allowed.add(`mu-${orchSession}`);
  }
  return allowed;
}

/**
 * Pure helper: given a list of `mu-*` sessions on the default socket
 * and the protected allowlist, return the names to kill. Exposed for
 * unit testing of the policy without poking real tmux.
 */
export function sessionsToKill(
  allMuSessions: readonly string[],
  allowlist: ReadonlySet<string>,
): readonly string[] {
  return allMuSessions.filter((name) => !allowlist.has(name));
}

async function sweepLeakedDefaultSocketSessions(phase: "setup" | "teardown"): Promise<void> {
  // List on the USER's default socket (no -L). Tmux exits 1 with
  // "no server running" when no daemon is up; treat as no-residue.
  const ls = await execa("tmux", ["list-sessions", "-F", "#{session_name}"], {
    reject: false,
  });
  if (ls.exitCode !== 0) return;

  const all = (ls.stdout ?? "").split("\n").filter((l) => l.length > 0);
  const muSessions = all.filter((name) => name.startsWith("mu-"));
  const allowlist = buildAllowlist();
  const leaked = sessionsToKill(muSessions, allowlist);
  if (leaked.length === 0) return;

  for (const name of leaked) {
    await execa("tmux", ["kill-session", "-t", name], { reject: false });
  }
  console.warn(
    `[mu-test global-${phase}] killed ${leaked.length} leaked tmux session(s) on the default socket (allowlist of ${allowlist.size} protected names): ${leaked.join(", ")}`,
  );
}

// ─── Hooks ─────────────────────────────────────────────────────────

export async function setup(): Promise<void> {
  // Layer 3 first: stand up the private tmux server. If this succeeds
  // every subsequent test invocation routes through `-L <socket>` and
  // can't see the user's tmux. If it FAILS we fall back gracefully.
  await bootstrapPrivateTmuxServer();
  // Layer 2: clean any leftovers on the user's default socket from a
  // prior non-Layer-3 run.
  await sweepLeakedDefaultSocketSessions("setup");
}

export async function teardown(): Promise<void> {
  // Layer 3: nuke the entire private server in one call. After this,
  // every session/window/pane the suite ever touched is gone.
  await killPrivateTmuxServer();
  // Layer 2: also sweep the default socket in case a test
  // accidentally bypassed our executor (e.g. a future test spawning
  // `execa("tmux", ...)` directly without going through src/tmux.ts).
  await sweepLeakedDefaultSocketSessions("teardown");
}
