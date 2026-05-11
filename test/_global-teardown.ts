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
//   LAYER 2 (legacy belt-and-suspenders) — sweep stale `mu-<test-prefix>-*`
//   sessions left over on the user's DEFAULT socket from a prior run that
//   ran BEFORE Layer 3 was in (i.e. the historical leakage that motivated
//   the task). Without this, a developer who pulls Layer 3 mid-flight
//   still has the old `mu-alpha`/`mu-beta`/etc. residue from yesterday.
//
// CONTRACT
//
// vitest's globalSetup contract: this file exports `setup()` (runs once
// before the suite) and `teardown()` (runs once after). Both are async.
// globalSetup runs in vitest's main thread, BEFORE any worker fork is
// created. So we set `process.env.MU_TMUX_SOCKET` in setup() and the
// worker fork inherits it at fork time.
//
// The realExecutor in src/tmux.ts reads `MU_TMUX_SOCKET` per-call (see
// `tmuxSocketArgs`) and prepends `-L <socket>` to every tmux invocation
// when set. Production code never sets the var; this file is the only
// caller.

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
    console.warn(
      `[mu-test global-setup] failed to bootstrap private tmux socket "${TEST_SOCKET}": ${r.stderr}; falling back to user's default tmux server`,
    );
  } else {
    process.env.MU_TMUX_SOCKET = TEST_SOCKET;
  }
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

// ─── Layer 2: legacy default-socket sweep ─────────────────────────

/**
 * Per-suite prefixes used by `freshWorkstream(prefix)` calls in the
 * integration test files. Kept in sync by hand because the alternative
 * (parsing test files at globalTeardown time) is a worse coupling.
 *
 * If you add a new integration suite that calls `freshWorkstream("foo")`,
 * add `"foo"` here so its leaked sessions get swept on suite-crash.
 *
 * After Layer 3, this list mostly matters for backwards-compat: a stray
 * `mu-acc-...` session on the default socket can only originate from a
 * pre-Layer-3 run. Kept as belt-and-suspenders — costs nothing per run.
 */
const TEST_FIXTURE_PREFIXES: readonly string[] = [
  "acc", // test/acceptance.test.ts
  "claim", // test/claim.integration.test.ts
  "kick", // test/cli-agent-kick.test.ts integration
  "stall", // test/cli-task-wait-on-stall.test.ts (mocked tmux but harmless)
  "t", // test/tmux.integration.test.ts
  "v", // test/verbs.integration.test.ts
  "wait", // test/cli-task-wait.integration.test.ts
  "wxa", // test/cli-task-wait.integration.test.ts (cross-ws)
  "wxb", // test/cli-task-wait.integration.test.ts (cross-ws)
];

/**
 * `^mu-(acc|claim|kick|...)-`. We require the trailing dash so we never
 * accidentally match user workstreams (e.g. `mu-tui-impl` — killing
 * the orchestrator pane mid-run would be catastrophic).
 */
const TEST_SESSION_RE = new RegExp(`^mu-(?:${TEST_FIXTURE_PREFIXES.join("|")})-`);

async function sweepLeakedDefaultSocketSessions(phase: "setup" | "teardown"): Promise<void> {
  // List on the USER's default socket (no -L). Tmux exits 1 with
  // "no server running" when no daemon is up; treat as no-residue.
  const ls = await execa("tmux", ["list-sessions", "-F", "#{session_name}"], {
    reject: false,
  });
  if (ls.exitCode !== 0) return;

  const all = (ls.stdout ?? "").split("\n").filter((l) => l.length > 0);
  const leaked = all.filter((name) => TEST_SESSION_RE.test(name));
  if (leaked.length === 0) return;

  for (const name of leaked) {
    await execa("tmux", ["kill-session", "-t", name], { reject: false });
  }
  console.warn(
    `[mu-test global-${phase}] killed ${leaked.length} leaked tmux session(s) on the default socket: ${leaked.join(", ")}`,
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
