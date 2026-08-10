// mu — tmux substrate.
//
// Single source of truth for all tmux interactions. Every tmux invocation
// goes through `tmux(args)`, which wraps execa and produces structured
// `TmuxError`s carrying args + stderr.
//
// The send protocol is the bracketed-paste sequence (canonical
// implementation lives in `sendToPane` below):
//   0. await pane quiescence (MU_SEND_READINESS_MS, default 15s)
//   1. copy-mode -q   (silent if not in copy mode)
//   2. set-buffer     (load text into a uniquely named buffer)
//   3. paste-buffer -p -d -r   (bracketed paste, delete buffer, preserve LF)
//   4. delay (MU_SEND_DELAY_MS, default 500)
//   5. send-keys Enter
//   6. confirm the Enter took; re-send it, then warn loudly if not
//
// Naive `tmux send-keys "<text>"` is broken: characters like /, ?, f get
// interpreted by the agent's TUI (Claude, Codex, less, vim) or by tmux's
// copy mode if the user has scrolled up. Use `sendToPane()`.
//
// Steps 0 and 6 exist because of dogfood_send_after_new_dropped: a TUI
// rendering a modal SWALLOWS the Enter, stranding the pasted text in the
// input box while `mu agent send` reported exit 0. See
// `awaitPaneQuiescence` for the reproduction and the mechanism.

import { execa } from "execa";
import { detectPiStatus } from "../detect.js";
import type { NextStep } from "../output.js";
import {
  type AttachTarget,
  type CaptureOptions,
  type MuxBackend,
  type MuxCommand,
  MuxError,
  type MuxHealth,
  type MuxPane,
  type MuxSession,
  type MuxWindow,
  type NewSessionOptions,
  type NewSessionWithPaneOptions,
  type NewWindowOptions,
  PaneNotFoundError,
  parseAgentNameFromTitle,
  type SendOptions,
  type SendWarning,
  type SplitWindowOptions,
} from "./types.js";

// Re-exported so the historical `import { ... } from "./tmux.js"` surface
// keeps resolving these names (47 test files and 12 src modules use it).
export {
  type AttachTarget,
  type CaptureOptions,
  type MuxCommand,
  MuxError,
  type MuxHealth,
  type NewSessionOptions,
  type NewSessionWithPaneOptions,
  type NewWindowOptions,
  PaneNotFoundError,
  parseAgentNameFromTitle,
  type SendOptions,
  type SendWarning,
  type SplitWindowOptions,
};

/** Back-compat aliases: tmux-specific names predating the MuxBackend
 *  extraction. Same shapes, now owned by ./types.js. */
export type TmuxSession = MuxSession;
export type TmuxWindow = MuxWindow;
export type TmuxPane = MuxPane;

// ─── Error type ────────────────────────────────────────────────────────

export class TmuxError extends MuxError {
  constructor(
    public readonly args: readonly string[],
    public readonly stderr: string,
    public readonly stdout: string,
    public readonly exitCode: number | null,
  ) {
    const detail = stderr.trim() || stdout.trim() || "no output";
    super(`tmux ${args.join(" ")} failed (exit ${exitCode}): ${detail}`);
    this.name = "TmuxError";
  }
  override errorNextSteps(): NextStep[] {
    return [
      { intent: "Run health check", command: "mu doctor" },
      {
        intent: "Verify tmux is running and reachable",
        command: "tmux info | head",
      },
      {
        intent: "Check the failing tmux command in isolation",
        command: `tmux ${this.args.join(" ")}`,
      },
    ];
  }
}

// ─── Pane ID validation ────────────────────────────────────────────────

/**
 * Stable tmux pane IDs are of the form `%N` (e.g. "%15"). They never change
 * for the lifetime of the pane. **Pane indexes** (0, 1, 2…) are volatile and
 * shift when other panes close — never store or pass them.
 */
export const PANE_ID_RE = /^%\d+$/;

export function isValidPaneId(s: string): boolean {
  return PANE_ID_RE.test(s);
}

export function assertValidPaneId(s: string): void {
  if (!isValidPaneId(s)) {
    throw new TypeError(`invalid tmux pane id: ${JSON.stringify(s)} (expected /^%\\d+$/)`);
  }
}

// ─── Configurable delay ────────────────────────────────────────────────

/**
 * Delay between bracketed-paste and Enter, in milliseconds. Claude/Codex/pi
 * process pasted text asynchronously; without this delay, Enter can arrive
 * before the agent has ingested the text. Defaults to 500; lower for tests,
 * raise for slow remotes via `MU_SEND_DELAY_MS`.
 */
export function defaultSendDelayMs(): number {
  const raw = process.env.MU_SEND_DELAY_MS;
  if (raw === undefined) return 500;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 500;
  return parsed;
}

// ─── Executor (swappable for tests) ────────────────────────────────────

export interface TmuxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type TmuxExecutor = (args: readonly string[]) => Promise<TmuxExecResult>;

/**
 * Optional global-flag prefix to splice in front of every tmux args
 * vector. When `MU_TMUX_SOCKET=<name>` is set, this returns
 * `["-L", name, "-f", "/dev/null"]`:
 *
 *   `-L <name>` routes every call through a private tmux server with
 *   the given socket name (Linux: `/tmp/tmux-<uid>/<name>`,
 *   macOS: `$TMPDIR/tmux-<uid>/<name>`) instead of the user's default
 *   `/tmp/tmux-<uid>/default`. Set by the test harness in Layer 3 of
 *   bug_test_suite_flake_leaks_isolation so the integration suite
 *   can never observe — or contaminate — the user's interactive
 *   tmux server.
 *
 *   `-f /dev/null` skips the user's `~/.tmux.conf`. This matters
 *   because tmux auto-starts the server on the first client call if
 *   none is running (e.g. after a test’s last `kill-session`
 *   shuts the server down). A typical user config uses `run-shell`
 *   for status-bar plugins (TPM, hostname/network probes), and each
 *   such hook adds ~1–4s to that auto-start. Without `-f /dev/null`
 *   a single integration test grows from 3s to 48s on a configured
 *   dev box. The suite drives tmux through the documented protocol,
 *   not through bound keys, so the user's config is irrelevant.
 *
 * Read fresh on every call so a setupFiles hook that mutates
 * `process.env.MU_TMUX_SOCKET` mid-run takes effect immediately.
 *
 * Production code never sets this; it's a test-isolation seam.
 */
function tmuxGlobalFlags(): readonly string[] {
  const socket = process.env.MU_TMUX_SOCKET;
  if (socket === undefined || socket.length === 0) return [];
  return ["-L", socket, "-f", "/dev/null"];
}

const realExecutor: TmuxExecutor = async (args) => {
  const result = await execa("tmux", [...tmuxGlobalFlags(), ...args], { reject: false });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? null,
  };
};

let currentExecutor: TmuxExecutor = realExecutor;

/**
 * Install a custom executor (for tests). Returns the previous executor so
 * tests can restore it cleanly. Production code should never call this.
 */
export function setTmuxExecutor(executor: TmuxExecutor): TmuxExecutor {
  const previous = currentExecutor;
  currentExecutor = executor;
  return previous;
}

/** Restore the real (execa-backed) executor. */
export function resetTmuxExecutor(): void {
  currentExecutor = realExecutor;
}

/**
 * Run an arbitrary tmux command. The single point of contact with the
 * tmux binary; every higher-level operation in this module goes through it.
 *
 * Throws `TmuxError` on non-zero exit. Returns stdout on success.
 */
export async function tmux(args: readonly string[]): Promise<string> {
  const result = await currentExecutor(args);
  if (result.exitCode !== 0) {
    throw new TmuxError([...args], result.stderr, result.stdout, result.exitCode);
  }
  return result.stdout;
}

// ─── Sleep helper (testable) ──────────────────────────────────────────

let currentSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setSleepForTests(
  impl: (ms: number) => Promise<void>,
): (ms: number) => Promise<void> {
  const previous = currentSleep;
  currentSleep = impl;
  return previous;
}

export function resetSleep(): void {
  currentSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

/** Test-aware sleep — honours `setSleepForTests`. Public so other modules
 *  (notably `agents.ts` for spawn liveness polling) get free no-op-ing in
 *  tests without re-implementing the swap. */
export function sleep(ms: number): Promise<void> {
  return currentSleep(ms);
}

// ─── Domain types ──────────────────────────────────────────────────────

// ─── Sessions ──────────────────────────────────────────────────────────

export async function listSessions(): Promise<TmuxSession[]> {
  // `list-sessions` exits 1 when no sessions exist; treat as empty.
  try {
    const out = await tmux(["list-sessions", "-F", "#{session_name}"]);
    return out
      .split("\n")
      .filter((line) => line.length > 0)
      .map((name) => ({ name }));
  } catch (err) {
    if (err instanceof TmuxError && /no server running|no sessions/i.test(err.stderr)) {
      return [];
    }
    throw err;
  }
}

export async function sessionExists(name: string): Promise<boolean> {
  const result = await currentExecutor(["has-session", "-t", name]);
  return result.exitCode === 0;
}

export async function newSession(name: string, opts: NewSessionOptions = {}): Promise<void> {
  const args = ["new-session"];
  if (opts.detached !== false) args.push("-d");
  args.push("-s", name);
  if (opts.windowName) args.push("-n", opts.windowName);
  if (opts.cwd) args.push("-c", opts.cwd);
  appendEnvFlags(args, opts.env);
  if (opts.command) args.push(opts.command);
  await tmux(args);
}

/**
 * Create a tmux session AND its first window+pane in one atomic call.
 * Returns the new pane's stable id. Used by mu when spawning the first
 * agent in a workstream so we never end up with an empty `mu-<workstream>`
 * session left behind by a failed spawn.
 */
export async function newSessionWithPane(
  name: string,
  opts: NewSessionWithPaneOptions,
): Promise<string> {
  const args = ["new-session"];
  if (opts.detached !== false) args.push("-d");
  args.push("-s", name, "-n", opts.windowName);
  if (opts.cwd) args.push("-c", opts.cwd);
  appendEnvFlags(args, opts.env);
  args.push("-P", "-F", "#{pane_id}", opts.command);
  const out = (await tmux(args)).trim();
  assertValidPaneId(out);
  return out;
}

/**
 * Idempotent: succeeds even if the session is already gone.
 *
 * Four swallowed shapes:
 *   - "can't find session: <name>"  — session never existed.
 *   - "session not found"           — alternate phrasing on some tmux builds.
 *   - "no server running on <path>" — the tmux server itself has exited
 *     (typical when the test suite runs against a private `tmux -L
 *     <socket>` server and the just-killed session was its last; tmux
 *     quietly shuts the server down). Without this, killSession would
 *     throw on the very next idempotent call — only visible under
 *     Layer 3 of bug_test_suite_flake_leaks_isolation.
 *   - "no current target"           — the server is UP but has zero
 *     sessions, so `-t <name>` has no session list to resolve against
 *     and tmux never gets as far as "can't find session". Reachable
 *     whenever the server outlives its last session: the suite's
 *     private server (`exit-empty off`, see test/_global-teardown.ts)
 *     and any user whose ~/.tmux.conf sets `exit-empty off`. Same
 *     meaning as "can't find session" for our purposes — the session
 *     we were asked to kill is gone.
 */
export async function killSession(name: string): Promise<void> {
  const result = await currentExecutor(["kill-session", "-t", name]);
  if (
    result.exitCode !== 0 &&
    !/can't find session|session not found|no server running|no current target/i.test(result.stderr)
  ) {
    throw new TmuxError(
      ["kill-session", "-t", name],
      result.stderr,
      result.stdout,
      result.exitCode,
    );
  }
}

// ─── Windows ───────────────────────────────────────────────────────────

export async function listWindows(session?: string): Promise<TmuxWindow[]> {
  if (session) {
    const out = await tmux(["list-windows", "-t", session, "-F", "#{window_id}\t#{window_name}"]);
    return parseWindows(out);
  }
  // Cross-session: include the session name.
  const out = await tmux([
    "list-windows",
    "-a",
    "-F",
    "#{session_name}\t#{window_id}\t#{window_name}",
  ]);
  const windows: TmuxWindow[] = [];
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const [sessionName, id, name] = line.split("\t");
    if (!sessionName || !id || name === undefined) continue;
    windows.push({ id, name, sessionName });
  }
  return windows;
}

function parseWindows(output: string): TmuxWindow[] {
  const windows: TmuxWindow[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const [id, name] = line.split("\t");
    if (!id || name === undefined) continue;
    windows.push({ id, name });
  }
  return windows;
}

/**
 * Create a new tmux window with one pane. Returns the new pane's stable
 * pane id (e.g. `%15`).
 */
export async function newWindow(opts: NewWindowOptions): Promise<string> {
  const args = ["new-window"];
  if (opts.detached !== false) args.push("-d");
  if (opts.session) args.push("-t", opts.session);
  args.push("-n", opts.name);
  if (opts.cwd) args.push("-c", opts.cwd);
  appendEnvFlags(args, opts.env);
  args.push("-P", "-F", "#{pane_id}", opts.command);
  const out = (await tmux(args)).trim();
  assertValidPaneId(out);
  return out;
}

// ─── Panes ─────────────────────────────────────────────────────────────

/**
 * List ALL panes in a tmux session (across every window). Used by
 * reconciliation to find every pane in the workstream's session.
 *
 * Note `list-panes -t <session>` (no -s) lists panes in the current
 * *window* of that session, not the whole session — a common gotcha.
 * `-s` is the flag that says "all panes in this session."
 *
 * Returns `[]` (not throws) when the session doesn't exist or has no
 * panes. tmux destroys a session as soon as its last pane closes, so the
 * "session was just here a moment ago" case is normal during reconcile.
 * tmux's error wording in this case varies ("can't find session",
 * "can't find window", or "no current target" when the server is up
 * with zero sessions), so we match any of them.
 */
export async function listPanesInSession(session: string): Promise<TmuxPane[]> {
  const args = [
    "list-panes",
    "-s",
    "-t",
    session,
    "-F",
    "#{window_id}\t#{pane_id}\t#{pane_title}\t#{pane_current_command}",
  ];
  const result = await currentExecutor(args);
  if (result.exitCode !== 0) {
    if (
      /can't find (session|window)|no server running|no sessions|no current target/i.test(
        result.stderr,
      )
    ) {
      return [];
    }
    throw new TmuxError(args, result.stderr, result.stdout, result.exitCode);
  }
  const panes: TmuxPane[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) continue;
    const [windowId, paneId, title, command] = line.split("\t");
    if (!windowId || !paneId || command === undefined) continue;
    panes.push({ paneId, title: title ?? "", command, windowId });
  }
  return panes;
}

/**
 * List panes in the current session, a specific window/session target, or
 * all panes across all sessions when `target` is the literal "*".
 */
export async function listPanes(target?: string): Promise<TmuxPane[]> {
  if (target === "*") {
    const out = await tmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_title}\t#{pane_current_command}",
    ]);
    const panes: TmuxPane[] = [];
    for (const line of out.split("\n")) {
      if (line.length === 0) continue;
      const [sessionName, windowId, paneId, title, command] = line.split("\t");
      if (!sessionName || !windowId || !paneId || command === undefined) continue;
      panes.push({ paneId, title: title ?? "", command, windowId, sessionName });
    }
    return panes;
  }

  const args = ["list-panes"];
  if (target !== undefined) args.push("-t", target);
  args.push("-F", "#{pane_id}\t#{pane_title}\t#{pane_current_command}");
  const out = await tmux(args);
  const panes: TmuxPane[] = [];
  for (const line of out.split("\n")) {
    if (line.length === 0) continue;
    const [paneId, title, command] = line.split("\t");
    if (!paneId || command === undefined) continue;
    panes.push({ paneId, title: title ?? "", command });
  }
  return panes;
}

/**
 * Split a window and run a command in the new pane. Returns the new pane's
 * stable pane id.
 */
export async function splitWindow(opts: SplitWindowOptions): Promise<string> {
  const args = ["split-window"];
  if (opts.horizontal !== false) args.push("-h");
  if (opts.detached !== false) args.push("-d");
  args.push("-t", opts.target);
  if (opts.cwd) args.push("-c", opts.cwd);
  appendEnvFlags(args, opts.env);
  args.push("-P", "-F", "#{pane_id}", opts.command);
  const out = (await tmux(args)).trim();
  assertValidPaneId(out);
  return out;
}

/**
 * Push one `-e KEY=VALUE` flag per entry into `args`, validating that
 * keys are non-empty and contain no `=` (tmux would error obscurely
 * otherwise; throwing TypeError keeps the failure at the call site).
 * No-op when `env` is undefined or empty.
 *
 * Iteration order follows Object.entries (insertion order); tests
 * shouldn't depend on a specific ordering, only on the presence of
 * each `-e KEY=VALUE` pair in the captured args.
 */
function appendEnvFlags(args: string[], env: Record<string, string> | undefined): void {
  if (!env) return;
  for (const [k, v] of Object.entries(env)) {
    if (k.length === 0) {
      throw new TypeError("tmux env key must be non-empty");
    }
    if (k.includes("=")) {
      throw new TypeError(`tmux env key must not contain '=': ${JSON.stringify(k)}`);
    }
    args.push("-e", `${k}=${v}`);
  }
}

/** Idempotent: succeeds even if the pane is already gone. */
export async function killPane(paneId: string): Promise<void> {
  assertValidPaneId(paneId);
  const result = await currentExecutor(["kill-pane", "-t", paneId]);
  if (result.exitCode !== 0 && !/can't find pane/i.test(result.stderr)) {
    throw new TmuxError(["kill-pane", "-t", paneId], result.stderr, result.stdout, result.exitCode);
  }
}

export async function paneExists(paneId: string): Promise<boolean> {
  if (!isValidPaneId(paneId)) return false;
  // tmux's `display-message -t <bogus>` exits 0 but emits empty output; we
  // must check that the echoed pane id matches what we asked for.
  const result = await currentExecutor(["display-message", "-t", paneId, "-p", "#{pane_id}"]);
  if (result.exitCode !== 0) return false;
  return result.stdout.trim() === paneId;
}

export async function setPaneTitle(paneId: string, title: string): Promise<void> {
  assertValidPaneId(paneId);
  await tmux(["select-pane", "-t", paneId, "-T", title]);
}

/**
 * Look up the window id (e.g. `@42`) that contains a given pane id
 * (e.g. `%15`). Used by spawn so we can apply window-scoped options
 * (`pane-border-status`) to the freshly created window.
 *
 * Returns undefined if the pane no longer exists.
 */
export async function getWindowIdForPane(paneId: string): Promise<string | undefined> {
  if (!isValidPaneId(paneId)) return undefined;
  const result = await currentExecutor(["display-message", "-t", paneId, "-p", "#{window_id}"]);
  if (result.exitCode !== 0) return undefined;
  const id = result.stdout.trim();
  return id.length > 0 ? id : undefined;
}

/**
 * Single source of truth for the operator opt-out from the mu pane
 * banner / border decorations. Set `MU_BANNER_QUIET=1` to disable.
 * All `enableMuPaneBorders*` helpers self-check this so callers
 * don't have to wrap them in env guards (a footgun: forget the
 * guard and you set the border even when the operator wanted
 * quiet).
 */
function muBannersDisabled(): boolean {
  return process.env.MU_BANNER_QUIET === "1";
}

/**
 * Apply the mu pane border (status=top, format='[mu] #{pane_title}')
 * to EVERY window currently in `session`. Idempotent. Best-effort:
 * windows that have vanished mid-iteration are silently skipped. Used
 * by `mu workstream init` (covers the placeholder `_mu` window plus
 * any windows that already exist, e.g. on re-init of an upgraded
 * mu-pre-border session) and by `mu agent spawn` (covers the
 * just-created window so the border shows immediately on attach).
 *
 * No-op (returns 0) when `MU_BANNER_QUIET=1`.
 *
 * Returns the number of windows that received the option.
 */
export async function enableMuPaneBordersForSession(session: string): Promise<number> {
  if (muBannersDisabled()) return 0;
  const windows = await listWindows(session).catch(() => []);
  let n = 0;
  for (const w of windows) {
    try {
      await enableMuPaneBorders(w.id);
      n += 1;
    } catch {
      // Window vanished; skip silently. Border is decorative.
    }
  }
  return n;
}

/**
 * Apply the mu pane border to the window containing `paneId`. This is
 * the spawn/adopt shape: callers have a pane id (from `new-window` or
 * from an adopt target), and need to resolve the enclosing window
 * before calling `enableMuPaneBorders` (a window-scoped option).
 *
 * Self-checks `MU_BANNER_QUIET` and swallows tmux errors — the border
 * is decorative; failing to set it is never load-bearing.
 */
export async function enableMuPaneBordersForPane(paneId: string): Promise<void> {
  if (muBannersDisabled()) return;
  const wid = await getWindowIdForPane(paneId).catch(() => undefined);
  if (wid) await enableMuPaneBorders(wid).catch(() => {});
}

/**
 * Enable a one-line top pane border on a specific window/session target,
 * showing `[mu] <pane-title>`. Idempotent (set-option is a write, not
 * a toggle).
 *
 * IMPORTANT: tmux's `pane-border-status` and `pane-border-format` are
 * **window** options, not session options. `set-option -t <session>`
 * only updates the active window at call time — windows created later
 * inherit from the GLOBAL value (which is `off` by default and which
 * we deliberately do NOT touch, since changing the global would
 * affect every other tmux session on the user's machine, including
 * dotfile-curated ones).
 *
 * Therefore mu must call this twice:
 *   1. At `mu workstream init` time on the placeholder `_mu` window
 *      (so an attached operator sees a border immediately).
 *   2. On every `mu agent spawn` (which calls `tmux new-window`),
 *      against the new window's id.
 *
 * The border is tmux chrome, not pane content: it doesn't scroll, it
 * survives copy-mode, and the inner CLI never sees it.
 *
 * Designed as the pane-border visual cue for mu-managed panes.
 */
export async function enableMuPaneBorders(target: string): Promise<void> {
  if (muBannersDisabled()) return;
  await tmux(["set-option", "-w", "-t", target, "pane-border-status", "top"]);
  await tmux(["set-option", "-w", "-t", target, "pane-border-format", " [mu] #{pane_title} "]);
  // Bottom + sides: heavy box-drawing lines so a mu-managed pane is
  // visually distinct even when not the active pane (top carries the
  // labeled status text; the rest of the frame carries the visual
  // "this is mu" cue). Cyan-bold for the active pane, dim brightblack
  // for inactive ones, so the operator's eye lands on the pane that
  // currently has focus.
  await tmux(["set-option", "-w", "-t", target, "pane-border-lines", "heavy"]);
  await tmux(["set-option", "-w", "-t", target, "pane-active-border-style", "fg=cyan,bold"]);
  await tmux(["set-option", "-w", "-t", target, "pane-border-style", "fg=brightblack"]);
}

/**
 * Look up the TTY device path for a pane (e.g. `/dev/ttys012` on macOS,
 * `/dev/pts/3` on Linux). Used by `mu agent kick` to find the
 * foreground process group on the pane's TTY so it can be signalled
 * directly — `tmux send-keys C-c` does NOT propagate to wrapped
 * subprocesses inside a CLI like pi/claude/codex (the CLI catches it
 * itself and treats it as a UI input). The escape hatch is signalling
 * the foreground pgid of the underlying TTY from outside the pane.
 *
 * Throws `PaneNotFoundError` when the pane id is invalid or the pane
 * has vanished. Throws `TmuxError` on any other tmux failure.
 */
export async function paneTTY(paneId: string): Promise<string> {
  assertValidPaneId(paneId);
  const result = await currentExecutor(["display-message", "-t", paneId, "-p", "#{pane_tty}"]);
  if (result.exitCode !== 0) {
    if (/can't find pane|pane not found/i.test(result.stderr)) {
      throw new PaneNotFoundError(paneId, tmuxBackend);
    }
    throw new TmuxError(
      ["display-message", "-t", paneId, "-p", "#{pane_tty}"],
      result.stderr,
      result.stdout,
      result.exitCode,
    );
  }
  const tty = result.stdout.trim();
  if (tty === "") throw new PaneNotFoundError(paneId, tmuxBackend);
  return tty;
}

export async function getPaneTitle(paneId: string): Promise<string | undefined> {
  if (!isValidPaneId(paneId)) return undefined;
  const result = await currentExecutor(["display-message", "-t", paneId, "-p", "#{pane_title}"]);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.trimEnd();
}

/**
 * Read the title of the *current* pane (the one whose shell is running this
 * process), via $TMUX_PANE. Returns undefined when not inside tmux. Used by
 * `mu claim` to derive the agent identity from the pane title — the claim
 * protocol's zero-config identity step.
 */
export async function currentPaneTitle(): Promise<string | undefined> {
  const paneId = process.env.TMUX_PANE;
  if (!paneId || !isValidPaneId(paneId)) return undefined;
  return getPaneTitle(paneId);
}

/**
 * Convenience: read the current pane's title and extract the agent name.
 */
export async function currentAgentName(): Promise<string | undefined> {
  const title = await currentPaneTitle();
  if (title === undefined) return undefined;
  return parseAgentNameFromTitle(title);
}

/**
 * Name of the tmux session this process is running inside, or
 * undefined outside tmux. Gated on `$TMUX` so a call from a plain
 * shell doesn't get whatever session the server happens to consider
 * current.
 */
export async function currentSessionName(): Promise<string | undefined> {
  if (!process.env.TMUX) return undefined;
  const result = await currentExecutor(["display-message", "-p", "#S"]);
  if (result.exitCode !== 0) return undefined;
  const name = result.stdout.trim();
  return name === "" ? undefined : name;
}

export async function selectLayout(window: string, layout: string): Promise<void> {
  await tmux(["select-layout", "-t", window, layout]);
}

// ─── Send protocol (the canonical bracketed-paste sequence) ────────────

/**
 * Default pre-send readiness budget in ms. Override with
 * MU_SEND_READINESS_MS; 0 disables the wait entirely.
 *
 * 15s (vs spawn's 10s) because the blocking operation here is an LLM
 * round-trip inside the target TUI, not a process cold-start. pi's
 * post-`/new` "Naming session before closing…" step measured ~1.5s on a
 * warm session but is a model call, so it has no useful upper bound.
 */
export function defaultSendReadinessMs(): number {
  const raw = process.env.MU_SEND_READINESS_MS;
  if (raw === undefined) return 15_000;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 15_000;
  return parsed;
}

/** Interval between quiescence polls (ms). */
const SEND_READINESS_POLL_MS = 250;

/**
 * How many CONSECUTIVE non-busy polls count as quiescent.
 *
 * One is not enough, and that is the subtle half of this bug. A TUI
 * does not render its modal synchronously: `mu agent send W "/new"`
 * returns as soon as tmux delivers Enter, and pi needs ~200-400ms more
 * before the "Naming session…" spinner appears. A single poll in that
 * window sees the PREVIOUS frame — still `needs_input` — declares the
 * pane ready, and pastes straight into the modal that is about to
 * appear. Measured directly: with a single poll, quiescence returned
 * true while naming was still running on 2 of 3 attempts.
 *
 * Three polls at 250ms means the pane must look idle for ~500ms of
 * wall-clock before we believe it, which covers the render gap without
 * adding meaningful latency to the common already-idle case.
 */
const QUIESCENCE_CONFIRMATIONS = 3;

/** How many times to re-send Enter for text stranded in the input box.
 *  One swallowed Enter is the observed failure; a second retry costs
 *  nothing when it is not needed. */
const SUBMIT_RETRIES = 2;

/** Pause after a retry Enter so the TUI can accept it and repaint
 *  before we re-inspect. */
const SUBMIT_SETTLE_MS = 600;

/** Samples that must ALL agree before calling a send stranded, and the
 *  gap between them. 4 x 700ms ≈ 2.1s, which covers the observed
 *  repaint lag during which a delivered prompt still reads as count==1. */
const SUBMIT_VERIFY_SAMPLES = 4;
const SUBMIT_VERIFY_INTERVAL_MS = 700;

/**
 * Markers that mean "the agent is mid-turn", as opposed to "a modal is
 * up". Both render a spinner, so the spinner alone cannot tell them
 * apart. `to interrupt)` is the same literal the status detector keys
 * on for busy; `Working` covers pi's plain progress line.
 */
const WORK_MARKERS: readonly string[] = ["to interrupt)", "Working"];

/** True when the pane tail shows the agent working on a turn (rather
 *  than a modal / re-init spinner). Only the last 40 lines count, so a
 *  work marker scrolled far above cannot make a live modal look like an
 *  in-flight turn. See awaitPaneQuiescence. */
export function hasWorkMarker(scrollback: string): boolean {
  const tail = scrollback.split("\n").slice(-40).join("\n");
  return WORK_MARKERS.some((m) => tail.includes(m));
}

/**
 * Block until the pane is ready to ACCEPT input, or the budget expires.
 * Returns true if the pane quiesced, false on timeout.
 *
 * WHY THIS EXISTS (dogfood_send_after_new_dropped, reproduced 3/6 at
 * sleep=0.3s and 1/5 at sleep=2s against a real pi pane):
 *
 * `mu agent send W "/new"` makes pi run an ASYNC "Naming session before
 * closing…" step — an LLM call — before the new session exists. A
 * bracketed paste that arrives while that modal is up is ACCEPTED, but
 * the Enter that follows it is SWALLOWED. The text is therefore left
 * sitting in the new session's input box, typed but never submitted —
 * exactly the reported symptom: pane at needs_input, context 0.0%, no
 * error anywhere, and an orchestrator waiting on a task the agent never
 * started.
 *
 * (Verified rather than assumed: pasting during the modal and capturing
 * afterwards shows the probe string exactly ONCE, in the input box, on
 * 3 of 3 attempts. Re-sending Enter afterwards took it to 2 and moved
 * context 0.0% -> 2.4%, which is what makes recovery possible.)
 *
 * Because the blocker is a model call, no fixed sleep can be correct —
 * `sleep 2` is a coin flip, not a fix. The signal already existed: pi's
 * spinner is a Braille glyph and `detectPiStatus` calls Braille busy,
 * so this reuses the detector rather than adding a second readiness
 * mechanism, matching `awaitSpawnReadiness` in src/agents/spawn.ts.
 *
 * `needs_permission` counts as ready: a pane sitting on a confirm
 * dialog is waiting for a keystroke, and refusing to send would break
 * the documented "answer the prompt with `mu agent send`" flow.
 *
 * IMPORTANT — what this does NOT wait for: an agent that is BUSY doing
 * the work you gave it. Queuing a follow-up into a working agent is a
 * legitimate, documented pattern, and pi accepts it. Waiting on that
 * made every send into a working agent pay the full budget — measured
 * at 14.5s of 15s, versus milliseconds before. The two cases are told
 * apart by WHAT is busy, not by when:
 *
 *   agent working   — tail carries a work marker (`to interrupt)`,
 *                     `Working`). Send immediately; pi queues it.
 *   modal / re-init — spinner with NO work marker, which is what pi's
 *                     "Naming session before closing…" looks like.
 *                     Wait it out; this is the one that eats the Enter.
 */
export async function awaitPaneQuiescence(paneId: string, budgetMs: number): Promise<boolean> {
  if (budgetMs <= 0) return true;
  const deadline = Date.now() + budgetMs;
  let calm = 0;
  for (;;) {
    const scrollback = await capturePane(paneId, { lines: 50 }).catch(() => undefined);
    const busy = scrollback === undefined || detectPiStatus(scrollback) === "busy";
    // Busy BECAUSE the agent is working a turn: not a re-init modal.
    // Send now and let the TUI queue it behind the current turn.
    if (busy && scrollback !== undefined && hasWorkMarker(scrollback)) return true;
    if (!busy) {
      calm++;
      if (calm >= QUIESCENCE_CONFIRMATIONS) return true;
    } else {
      // Went busy after looking idle: a modal rendered late. Reset the
      // streak so it cannot sneak in behind that early idle reading.
      calm = 0;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await currentSleep(Math.min(SEND_READINESS_POLL_MS, remaining));
  }
}

/**
 * Longest prefix of `text` that is safe to look for in a pane capture.
 * The TUI soft-wraps its input box, so only the first line survives
 * intact. 24 chars is comfortably under any sane terminal width while
 * still being specific enough not to false-positive on chrome.
 */
function pasteProbe(text: string): string {
  const firstLine = (text.split("\n")[0] ?? "").trim();
  return firstLine.slice(0, 24);
}

/**
 * True when `probe` looks SUSTAINED-unsubmitted: visible exactly once,
 * on a pane that is not working, across every sample in a short window.
 *
 * Why all three conditions, each learned from a false positive on a
 * real pane:
 *
 *  - EXACTLY ONCE. Text sitting in the input box appears once. A
 *    submitted prompt ends up appearing twice (the TUI echoes it into
 *    the transcript above its response) or zero times (it scrolled
 *    past). Zero therefore counts as delivered — treating "cannot see
 *    it" as failure would warn on every long send.
 *  - NOT BUSY. A busy pane is working on something, which is what a
 *    delivered prompt looks like.
 *  - SUSTAINED. This is the one that matters most. A successful submit
 *    legitimately passes THROUGH count==1 for up to ~2s while the TUI
 *    repaints, before the echo makes it 2. Sampling once inside that
 *    window reports a strand that has already gone through, which was
 *    a real false warning during development. Requiring every sample
 *    to agree removes it.
 *
 * Cost when all is well: the first sample usually shows 0 or 2 and the
 * function returns immediately.
 */
async function isTextStranded(paneId: string, probe: string): Promise<boolean> {
  for (let i = 0; i < SUBMIT_VERIFY_SAMPLES; i++) {
    if (i > 0) await currentSleep(SUBMIT_VERIFY_INTERVAL_MS);
    const capture = await capturePane(paneId, { lines: 50 }).catch(() => undefined);
    if (capture === undefined) return false;
    if (detectPiStatus(capture) === "busy") return false;
    let count = 0;
    let idx = capture.indexOf(probe);
    while (idx !== -1 && count < 2) {
      count++;
      idx = capture.indexOf(probe, idx + probe.length);
    }
    if (count !== 1) return false;
  }
  return true;
}

/** Default handler for an unconfirmed send: warn on stderr. Loud by
 *  design — the whole bug was that this case was silent. */
function defaultUndeliveredWarning(warning: SendWarning): void {
  console.warn(`warning: ${warning.message}`);
}

/**
 * Send a single line of text to a pane and submit it.
 *
 * Sequence:
 *   0. wait until the pane is not mid-modal (see awaitPaneQuiescence)
 *   1. exit copy mode (silent if not in copy mode)
 *   2. load text into a uniquely-named tmux buffer
 *   3. paste with bracketed-paste mode (-p) so apps treat as literal text;
 *      delete buffer after paste (-d); preserve LF (-r)
 *   4. wait MU_SEND_DELAY_MS (default 500) so the agent ingests the text
 *   5. send Enter as a real key event
 *   6. confirm the Enter took; re-send it if the text is stranded
 *
 * DELIVERY CONTRACT (dogfood_send_after_new_dropped): exit 0 must not
 * be able to mean "silently dropped". After Enter, the pane is checked
 * for text left STRANDED in the input box — typed but unsubmitted,
 * which is what a swallowed Enter looks like. If found, Enter is
 * re-sent (up to SUBMIT_RETRIES times), which recovers the prompt.
 * `onUndelivered` fires only if it is STILL stranded afterwards.
 *
 * Not a throw, deliberately: by then the text is in the agent's input
 * box, so the operator's next `mu agent read` shows it and a bare Enter
 * finishes the job. Failing the command would also break every existing
 * caller for a usually-recoverable condition. The warning is loud and
 * names the recovery step.
 *
 * Naive `send-keys "<text>"` would let characters like /, ?, f, : be
 * interpreted by the agent's TUI or by tmux's copy mode. Always use this.
 */
export async function sendToPane(
  paneId: string,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  assertValidPaneId(paneId);

  // 0. Wait out an in-flight modal / re-init. A TUI rendering one
  //    swallows the Enter, stranding the paste in the input box.
  const readinessMs = opts.readinessMs ?? defaultSendReadinessMs();
  const quiesced = await awaitPaneQuiescence(paneId, readinessMs);

  // 1. Exit copy mode silently. -q suppresses errors when not in copy mode.
  const copyResult = await currentExecutor(["copy-mode", "-q", "-t", paneId]);
  // Even with -q, some tmux versions report errors. Swallow non-fatal.
  if (copyResult.exitCode !== 0 && /can't find pane|no current target/i.test(copyResult.stderr)) {
    throw new TmuxError(
      ["copy-mode", "-q", "-t", paneId],
      copyResult.stderr,
      copyResult.stdout,
      copyResult.exitCode,
    );
  }

  // 2. Load text into a uniquely-named buffer.
  const bufferName = `mu-send-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await tmux(["set-buffer", "-b", bufferName, text]);

  // 3. Bracketed paste: -p wraps in \e[200~...\e[201~ so apps see literal
  //    text; -d deletes buffer after paste; -r preserves LF (no CR conversion).
  try {
    await tmux(["paste-buffer", "-p", "-d", "-r", "-b", bufferName, "-t", paneId]);
  } catch (err) {
    // Best-effort buffer cleanup if paste failed before -d took effect.
    await currentExecutor(["delete-buffer", "-b", bufferName]).catch(() => {});
    throw err;
  }

  // 4. Wait for the agent CLI to ingest the pasted text.
  const delay = opts.delayMs ?? defaultSendDelayMs();
  if (delay > 0) await currentSleep(delay);

  // 5. Submit. Enter must be a real key event, not part of the paste.
  await tmux(["send-keys", "-t", paneId, "Enter"]);

  // 6. Confirm the Enter took. readinessMs: 0 opts out of the whole
  //    wrapper (bare 4-command protocol; unit tests mock captures away).
  if (readinessMs <= 0) return;
  const probe = pasteProbe(text);
  if (probe.length === 0) return; // nothing observable to verify

  for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt++) {
    if (!(await isTextStranded(paneId, probe))) return;
    if (attempt === SUBMIT_RETRIES) break;
    // Sustained strand on a calm pane: the Enter was swallowed. Re-send.
    await tmux(["send-keys", "-t", paneId, "Enter"]);
    await currentSleep(SUBMIT_SETTLE_MS);
  }

  const warn = opts.onUndelivered ?? defaultUndeliveredWarning;
  warn({
    paneId,
    reason: quiesced ? "paste-vanished" : "busy-at-deadline",
    message: `send to ${paneId} was NOT submitted: the text is still sitting unsubmitted in the pane's input box after ${SUBMIT_RETRIES + 1} Enter attempts. The agent has NOT seen it. Press Enter in the pane, or re-send.`,
  });
}

// ─── Capture ───────────────────────────────────────────────────────────

/**
 * Read pane scrollback as plain text (no ANSI escapes).
 *
 * - No options: full scrollback (`-S - -E -`)
 * - `lines: 0`: visible pane only
 * - `lines: N`: last N lines (`-S -N`)
 */
export async function capturePane(paneId: string, opts: CaptureOptions = {}): Promise<string> {
  assertValidPaneId(paneId);
  const args = ["capture-pane", "-t", paneId, "-p"];
  if (opts.lines === undefined) {
    args.push("-S", "-", "-E", "-");
  } else if (opts.lines > 0) {
    args.push("-S", `-${opts.lines}`);
  }
  return tmux(args);
}

// ─── Backend record ────────────────────────────────────────────────────

/**
 * True iff tmux can be reached right now. `tmux -V` rather than a PATH
 * probe: a tmux binary that cannot execute (broken install, missing
 * libtinfo) is not an available backend, and the version call is the
 * cheapest thing that proves the binary actually runs.
 *
 * Deliberately does NOT require `$TMUX` — mu creates its own detached
 * sessions, so a usable tmux server is enough. `$TMUX` only tells us
 * whether the CALLER is inside a pane, which is a detection-precedence
 * signal (see ./detect.ts), not an availability one.
 */
async function tmuxAvailable(): Promise<boolean> {
  try {
    await tmux(["-V"]);
    return true;
  } catch {
    return false;
  }
}

// ─── Attach ────────────────────────────────────────────────────
//
// From INSIDE a tmux client the right verb is `switch-client`, which
// repoints the existing client and returns immediately. From outside
// it is `attach-session` followed by a separate `select-window`: `tmux
// attach -t session:window` does not reliably select the window across
// tmux versions, and the select must run after the attach detaches.

function attachTargetSpec(target: AttachTarget): string {
  return target.window === undefined ? target.session : `${target.session}:${target.window}`;
}

export function attachHint(target: AttachTarget): string {
  const spec = attachTargetSpec(target);
  if (target.inside === true) return `tmux switch-client -t ${spec}`;
  if (target.window === undefined) return `tmux attach -t ${target.session}`;
  return `tmux attach -t ${target.session} && tmux select-window -t ${spec}`;
}

export function attachCommands(target: AttachTarget): readonly MuxCommand[] {
  const spec = attachTargetSpec(target);
  if (target.inside === true) {
    return [{ command: "tmux", args: ["switch-client", "-t", spec] }];
  }
  const steps: MuxCommand[] = [{ command: "tmux", args: ["attach-session", "-t", target.session] }];
  if (target.window !== undefined) {
    // Best-effort: if it fails the user is at least in the right session.
    steps.push({ command: "tmux", args: ["select-window", "-t", spec], optional: true });
  }
  return steps;
}

// ─── Diagnostics ────────────────────────────────────────────────

export function paneNotFoundNextSteps(paneId: string): NextStep[] {
  return [
    {
      intent: `Verify the pane id ${paneId} actually exists`,
      command: `tmux display-message -t ${paneId} -p '#{pane_id} #{pane_title}'`,
    },
    {
      intent: "List all live panes across all sessions",
      command:
        "tmux list-panes -a -F '#{session_name}:#{window_id}.#{pane_id}\\t#{pane_title}\\t#{pane_current_command}'",
    },
  ];
}

/**
 * Version probe + the two ambient env facts tmux exposes. Returns DATA;
 * `mu doctor` owns every string the user sees, so a second backend
 * reporting different env vars needs no doctor change.
 */
export async function healthCheck(): Promise<MuxHealth> {
  let version: string | null = null;
  try {
    version = (await tmux(["-V"])).trim();
  } catch {
    version = null;
  }
  return {
    name: "tmux",
    ok: version !== null,
    version,
    env: [
      { name: "$TMUX", value: process.env.TMUX ?? null },
      { name: "$TMUX_PANE", value: process.env.TMUX_PANE ?? null },
    ],
    remediation: "install tmux ≥ 3.0",
  };
}

/**
 * The tmux implementation of `MuxBackend`. A frozen record of the
 * module's functions — no state of its own, so swapping backends is a
 * pointer assignment (see ./detect.ts).
 */
export const tmuxBackend: MuxBackend = Object.freeze({
  name: "tmux" as const,
  available: tmuxAvailable,

  isValidPaneId,
  assertValidPaneId,

  listSessions,
  sessionExists,
  newSession,
  newSessionWithPane,
  killSession,

  listWindows,
  newWindow,
  selectLayout,

  listPanes,
  listPanesInSession,
  splitWindow,
  killPane,
  paneExists,
  paneTTY,

  setPaneTitle,
  getPaneTitle,
  currentAgentName,
  currentSessionName,

  sendToPane,
  capturePane,

  enableMuPaneBordersForSession,
  enableMuPaneBordersForPane,

  attachHint,
  attachCommands,

  paneNotFoundNextSteps,
  healthCheck,
});
