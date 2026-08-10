// The mux test seam: pick a backend, get its executor stubbed, get one
// restore function back.
//
// ─── Why this exists ───────────────────────────────────────────────────
//
// Two backends means two executor seams (`setTmuxExecutor`,
// `setHerdrExecutor`) plus a backend selector (`setMuxForTests`). Before
// this file, a test that wanted herdr had to know to call
// setMuxForTests + setHerdrExecutor TOGETHER, in that order, and reset
// BOTH. Forgetting the reset leaks a stubbed executor into the next
// file in the fork; forgetting the selector runs the assertions against
// tmux while stubbing herdr, which passes for the wrong reason.
//
// `installMux()` collapses all of that into one call and one teardown.
// A test says which backend it is testing; the harness knows which
// executor that implies.
//
// ─── Which tier does my mux test belong to? ────────────────────────────
//
// See test/README.md § "Mux tests". Short version: if you call
// `installMux()` you are in the FAST tier and must stay pure. If you
// need a real multiplexer you are writing an `*.integration.test.ts`
// and must gate on `tmuxIntegrationAvailable()` /
// `herdrIntegrationAvailable()`.

import { execa } from "execa";
import {
  type MuxBackend,
  type MuxBackendName,
  muxByName,
  resetHerdrExecutor,
  resetMux,
  setHerdrExecutor,
  setMuxForTests,
} from "../src/mux.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";

// ─── Shared executor shape ─────────────────────────────────────────────
//
// `TmuxExecResult` and `HerdrExecResult` are structurally identical, and
// so are the two executor types. One local alias lets the harness treat
// both backends uniformly instead of branching on types that are the
// same shape.

export interface MuxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type MuxExecutor = (args: readonly string[]) => Promise<MuxExecResult>;

/** A canned response: either a full exec result or just stdout (exit 0). */
export type MuxResponse = MuxExecResult | string;

/**
 * Prefix-matched routing table. The first entry whose key is a prefix of
 * the space-joined args vector wins, so `["pane get w1:p1", …]` can be
 * narrower than `["pane get", …]` when order says so. An empty-string
 * key matches everything (catch-all).
 */
export type MuxRoutes = ReadonlyArray<readonly [string, MuxResponse]>;

export interface MuxHarness {
  /** Every args vector the code under test passed to the backend, in order. */
  readonly calls: readonly (readonly string[])[];
  /** Args of call `n`, or undefined. Sugar over `calls[n]`. */
  argsOf(n: number): readonly string[] | undefined;
  /** Restore the previous backend + real executor. Call in afterEach. */
  restore(): void;
}

function respond(response: MuxResponse): MuxExecResult {
  return typeof response === "string"
    ? { stdout: response, stderr: "", exitCode: 0 }
    : { ...response };
}

/**
 * Install `backend` as the active mux AND stub its executor.
 *
 * ```ts
 * let mux: MuxHarness;
 * afterEach(() => mux.restore());
 *
 * it("lists sessions", async () => {
 *   mux = installMux("herdr", [["workspace list", WORKSPACE_LIST]]);
 *   expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
 *   expect(mux.argsOf(0)).toEqual(["workspace", "list"]);
 * });
 * ```
 *
 * An unrouted call returns exit 1 with an `unrouted: <cmd>` stderr
 * rather than throwing, because that is what a real substrate failure
 * looks like to the code under test — and it names the missing route in
 * the assertion diff.
 *
 * Pass a function instead of a routing table when the test needs
 * arbitrary behaviour (throwing to prove no shell-out happens, counting,
 * stateful responses).
 */
export function installMux(
  backend: MuxBackendName,
  routes: MuxRoutes | MuxExecutor = [],
): MuxHarness {
  const calls: string[][] = [];
  const impl: MuxExecutor =
    typeof routes === "function"
      ? routes
      : async (args) => {
          const key = args.join(" ");
          for (const [prefix, response] of routes) {
            if (key.startsWith(prefix)) return respond(response);
          }
          return { stdout: "", stderr: `unrouted: ${key}`, exitCode: 1 };
        };

  const executor: MuxExecutor = async (args) => {
    calls.push([...args]);
    return await impl(args);
  };

  const previousBackend = setMuxForTests(muxByName(backend));
  if (backend === "herdr") {
    setHerdrExecutor(executor);
  } else {
    setTmuxExecutor(executor);
  }

  let restored = false;
  return {
    calls,
    argsOf: (n) => calls[n],
    restore() {
      // Idempotent: an afterEach that runs after an explicit in-test
      // restore() must not clobber the NEXT test's harness.
      if (restored) return;
      restored = true;
      setMuxForTests(previousBackend);
      resetMux();
      if (backend === "herdr") {
        resetHerdrExecutor();
      } else {
        resetTmuxExecutor();
      }
    },
  };
}

/**
 * Install a backend whose every method rejects, modelling a box with no
 * reachable multiplexer. `reject` supplies the error (typically
 * `NoMultiplexerError`), so call-site tests can prove load-bearing
 * paths propagate and best-effort paths degrade.
 */
export function installUnreachableMux(
  backend: MuxBackendName,
  reject: () => Error,
): { restore(): void } {
  const real = muxByName(backend);
  const boom = async (): Promise<never> => {
    throw reject();
  };
  const stub: Record<string, unknown> = { name: backend };
  for (const key of Object.keys(real)) {
    if (key === "name") continue;
    stub[key] = boom;
  }
  const previousBackend = setMuxForTests(stub as unknown as MuxBackend);
  return {
    restore() {
      setMuxForTests(previousBackend);
      resetMux();
    },
  };
}

// ─── Integration-tier gates ────────────────────────────────────────────

/**
 * tmux integration tests self-skip when `$TMUX` is unset — the
 * long-standing convention (see AGENTS.md § Tests). Isolation itself is
 * STRUCTURAL for tmux: `test/_global-teardown.ts` points the whole
 * suite at a private `-L <socket>` server, so the user's sessions are
 * invisible and suite residue dies with `kill-server`.
 */
export function tmuxIntegrationAvailable(): boolean {
  return Boolean(process.env.TMUX);
}

// ─── The herdr blast shield ────────────────────────────────────────────
//
// READ THIS BEFORE WRITING A HERDR INTEGRATION TEST.
//
// tmux gets a private socket. herdr does NOT have an equivalent: its
// only isolation is `--session <name>` (a named server under
// ~/.config/herdr/sessions/<name>/), which mu routes to via
// MU_HERDR_SESSION. That difference matters enormously:
//
//   - tmux: worst case, a buggy test kills a session on the wrong
//     SOCKET, and the DB-rooted sweep in _global-teardown.ts catches it.
//   - herdr: worst case, a buggy test talks to the DEFAULT session and
//     destroys the user's real panes — with the agents and unsaved work
//     inside them. There is no undo and no sweep that can tell a user
//     pane from test residue.
//
// So the guard here is EXPLICIT rather than structural, and it is a
// runtime assertion rather than a comment:
//
//   1. `assertHerdrIsolated()` REFUSES to proceed unless
//      MU_HERDR_SESSION names a non-default session.
//   2. `herdrTestExec()` REFUSES the fatal verbs outright — no
//      `server stop`, no `server kill`, no killing the main process —
//      even inside a correctly isolated session, because a stopped
//      server is shared-fate: `herdr server stop` is not
//      session-scoped in any way mu can rely on.
//
// Cleanup for herdr integration tests is therefore per-entity (close
// the workspaces you created), never "nuke the server".

/** Sessions that are the user's real work, never a test's to drive. */
const FORBIDDEN_SESSIONS: ReadonlySet<string> = new Set(["default", ""]);

/**
 * Verb prefixes that can take down the user's whole herdr — checked
 * against the space-joined args vector. `server stop` / `server
 * restart` are shared-fate regardless of `--session`.
 */
const FORBIDDEN_COMMANDS: readonly string[] = ["server stop", "server restart", "server kill"];

export class HerdrTestSafetyError extends Error {
  constructor(message: string) {
    super(`herdr test safety: ${message}`);
    this.name = "HerdrTestSafetyError";
  }
}

/**
 * Throw unless we are pointed at an isolated, named herdr session.
 *
 * Call this at the top of any herdr integration test's beforeEach — and
 * note `herdrTestExec()` calls it on EVERY command, so a test that
 * forgets still cannot touch the default session.
 */
export function assertHerdrIsolated(): string {
  const session = process.env.MU_HERDR_SESSION;
  if (session === undefined || FORBIDDEN_SESSIONS.has(session)) {
    throw new HerdrTestSafetyError(
      `MU_HERDR_SESSION must name a private test session, got ${JSON.stringify(session)}. ` +
        "Refusing to drive the user's default herdr server — that would destroy their real panes. " +
        'Set MU_HERDR_SESSION="mu-test-<unique>" first (see test/_mux.ts).',
    );
  }
  return session;
}

/**
 * Run a real `herdr` command against the ISOLATED test session.
 *
 * The only sanctioned way for a test to reach the herdr binary. It
 * asserts isolation and refuses server-fatal verbs before spawning
 * anything. Every herdr integration test should route its fixture
 * setup/teardown through here rather than calling execa directly.
 */
export async function herdrTestExec(args: readonly string[]): Promise<MuxExecResult> {
  const session = assertHerdrIsolated();
  const key = args.join(" ");
  for (const forbidden of FORBIDDEN_COMMANDS) {
    if (key.startsWith(forbidden)) {
      throw new HerdrTestSafetyError(
        `refusing to run "herdr ${key}" — it takes down the server the user's real panes live in. ` +
          "Clean up per-entity instead (close the workspaces the test created).",
      );
    }
  }
  const result = await execa("herdr", ["--session", session, ...args], { reject: false });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? null,
  };
}

/**
 * True iff a herdr server is RUNNING and protocol-COMPATIBLE right now.
 *
 * The herdr analogue of `$TMUX`-gating, but stricter: an installed
 * binary is not enough, because a herdr whose server is down cannot
 * drive a single pane. Mirrors `herdrBackend.available()`'s parse of
 * the one non-JSON command.
 *
 * Deliberately probes the DEFAULT server (no `--session`): the question
 * is "does this box run herdr at all", which is a property of the
 * install, not of our test session. It is a read-only `status` call —
 * the one herdr command that is safe to point anywhere.
 */
export async function herdrIntegrationAvailable(): Promise<boolean> {
  const result = await execa("herdr", ["status"], { reject: false }).catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return false;
  const stdout = result.stdout ?? "";
  if (!/^\s*status:\s*running\s*$/m.test(stdout)) return false;
  return !/^\s*compatible:\s*no\s*$/m.test(stdout);
}

/**
 * A unique MU_HERDR_SESSION name, so two concurrent `npm test` runs
 * never share a herdr server. Same construction as `freshWorkstream()`
 * in test/_fixture.ts: pid + timestamp + randomness, all base36.
 */
export function freshHerdrSession(prefix = "mu-test"): string {
  const pid = process.pid.toString(36).slice(-4);
  const now = Date.now().toString(36).slice(-6);
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${prefix}-${pid}-${now}-${rand}`;
}
