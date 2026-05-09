// mu — tmux substrate.
//
// Single source of truth for all tmux interactions. Every tmux invocation
// goes through `tmux(args)`, which wraps execa and produces structured
// `TmuxError`s carrying args + stderr.
//
// The send protocol is the bracketed-paste sequence (canonical
// implementation lives in `sendToPane` below):
//   1. copy-mode -q   (silent if not in copy mode)
//   2. set-buffer     (load text into a uniquely named buffer)
//   3. paste-buffer -p -d -r   (bracketed paste, delete buffer, preserve LF)
//   4. delay (MU_SEND_DELAY_MS, default 500)
//   5. send-keys Enter
//
// Naive `tmux send-keys "<text>"` is broken: characters like /, ?, f get
// interpreted by the agent's TUI (Claude, Codex, less, vim) or by tmux's
// copy mode if the user has scrolled up. Use `sendToPane()`.

import { execa } from "execa";
import type { HasNextSteps, NextStep } from "./output.js";

// ─── Error type ────────────────────────────────────────────────────────

export class TmuxError extends Error implements HasNextSteps {
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
  errorNextSteps(): NextStep[] {
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

/**
 * Thrown when a verb references a tmux pane id that doesn't exist on
 * the running tmux server. Distinct from TmuxError (which wraps any
 * tmux command failure) so callers can map it to a specific exit code
 * (`mu` maps it to 5 — substrate failure — alongside other tmux
 * issues, but the message is more actionable than a raw tmux stderr).
 */
export class PaneNotFoundError extends Error implements HasNextSteps {
  override readonly name = "PaneNotFoundError";
  constructor(public readonly paneId: string) {
    super(`tmux pane not found: ${paneId}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: `Verify the pane id ${this.paneId} actually exists`,
        command: `tmux display-message -t ${this.paneId} -p '#{pane_id} #{pane_title}'`,
      },
      {
        intent: "List all live panes across all sessions",
        command:
          "tmux list-panes -a -F '#{session_name}:#{window_id}.#{pane_id}\\t#{pane_title}\\t#{pane_current_command}'",
      },
      {
        intent: "List mu-managed agents (registered)",
        command: "mu agent list -w *",
      },
      {
        intent: "List orphan panes (look like agents, not registered)",
        command: "mu agent list -w * --json | jq '.[] | .orphans'",
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

const realExecutor: TmuxExecutor = async (args) => {
  const result = await execa("tmux", [...args], { reject: false });
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

export interface TmuxSession {
  name: string;
}

export interface TmuxWindow {
  /** tmux window id, e.g. "@1". */
  id: string;
  name: string;
  /** Session this window belongs to (only set by cross-session listings). */
  sessionName?: string;
}

export interface TmuxPane {
  /** Stable tmux pane id, e.g. "%15". */
  paneId: string;
  /** Pane title set via `select-pane -T`. The agent's name in mu's convention. */
  title: string;
  /** Current foreground command (e.g. "claude", "node", "bash"). */
  command: string;
  /** Window this pane lives in. Only set by cross-window listings. */
  windowId?: string;
  /** Session this pane lives in. Only set by cross-session listings. */
  sessionName?: string;
}

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

export interface NewSessionOptions {
  detached?: boolean;
  windowName?: string;
  command?: string;
  /** Initial working directory for the first pane (`-c <path>`). */
  cwd?: string;
  /** Extra env vars to set in the new pane via tmux `-e KEY=VALUE`.
   *  Available since tmux 3.0; sets the variable in the new pane's
   *  environment without polluting the tmux server's global env. */
  env?: Record<string, string>;
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

export interface NewSessionWithPaneOptions {
  windowName: string;
  command: string;
  cwd?: string;
  detached?: boolean;
  /** Extra env vars to set in the new pane via tmux `-e KEY=VALUE`. */
  env?: Record<string, string>;
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

/** Idempotent: succeeds even if the session is already gone. */
export async function killSession(name: string): Promise<void> {
  const result = await currentExecutor(["kill-session", "-t", name]);
  if (result.exitCode !== 0 && !/can't find session|session not found/i.test(result.stderr)) {
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

export interface NewWindowOptions {
  /** Target session. Required if invoking outside an existing tmux client. */
  session?: string;
  /** Window name. Maps to the agent's `tab:` value (or its name if no tab). */
  name: string;
  /** Command to run in the first pane. */
  command: string;
  /** If true, do not switch focus. Defaults to true. */
  detached?: boolean;
  /** Initial working directory (`-c <path>`). */
  cwd?: string;
  /** Extra env vars to set in the new pane via tmux `-e KEY=VALUE`. */
  env?: Record<string, string>;
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
 * tmux's error wording in this case varies ("can't find session" or
 * "can't find window"), so we match either.
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
    if (/can't find (session|window)|no server running|no sessions/i.test(result.stderr)) {
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

export interface SplitWindowOptions {
  /** Target window or pane (e.g. ":Backend" or "%15"). */
  target: string;
  command: string;
  /** Horizontal split (side-by-side). Default true. */
  horizontal?: boolean;
  detached?: boolean;
  /** Initial working directory for the new pane (`-c <path>`). */
  cwd?: string;
  /** Extra env vars to set in the new pane via tmux `-e KEY=VALUE`. */
  env?: Record<string, string>;
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
 * Designed in roadmap-v0-2 hud_visual_cue_design (note #283); shipped
 * in hud_visual_cue_impl.
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
 * Read the *current* pane's interior size (`pane_width` x `pane_height`)
 * via $TMUX_PANE. Returns undefined when not inside tmux or when the
 * tmux call fails. Used by `mu hud` to size its tables when stdout
 * isn't a TTY (e.g. when running under `watch -n 5 mu hud -w X` or
 * `tmux display-popup -E 'mu hud -w X'`, both of which strip TTY-ness
 * but still run inside a tmux pane whose dimensions matter).
 */
export async function currentPaneSize(): Promise<{ width: number; height: number } | undefined> {
  const paneId = process.env.TMUX_PANE;
  if (!paneId || !isValidPaneId(paneId)) return undefined;
  const result = await currentExecutor([
    "display-message",
    "-t",
    paneId,
    "-p",
    "#{pane_width} #{pane_height}",
  ]);
  if (result.exitCode !== 0) return undefined;
  const parts = result.stdout.trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  const [wStr, hStr] = parts;
  if (wStr === undefined || hStr === undefined) return undefined;
  const width = Number.parseInt(wStr, 10);
  const height = Number.parseInt(hStr, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

/**
 * Extract the agent-name token from a (possibly composed) pane title.
 * mu's composeAgentTitle renders titles as `name · <glyph> · task_id`,
 * where <glyph> is a Nerd Font codepoint from STATUS_EMOJI (see
 * src/agents.ts). The agent name is always the first ' · '-separated
 * token. Adopted / legacy panes that haven't been re-titled by mu have
 * just the name (one token) — still parses.
 *
 * Returns trimmed name, or the input unchanged if no separator.
 */
export function parseAgentNameFromTitle(title: string): string {
  const idx = title.indexOf(" · ");
  return idx === -1 ? title.trim() : title.slice(0, idx).trim();
}

/**
 * Convenience: read the current pane's title and extract the agent name.
 */
export async function currentAgentName(): Promise<string | undefined> {
  const title = await currentPaneTitle();
  if (title === undefined) return undefined;
  return parseAgentNameFromTitle(title);
}

export async function selectLayout(window: string, layout: string): Promise<void> {
  await tmux(["select-layout", "-t", window, layout]);
}

// ─── Send protocol (the canonical bracketed-paste sequence) ────────────

export interface SendOptions {
  /** Override the default delay between paste and Enter, in ms. */
  delayMs?: number;
}

/**
 * Send a single line of text to a pane and submit it.
 *
 * Sequence:
 *   1. exit copy mode (silent if not in copy mode)
 *   2. load text into a uniquely-named tmux buffer
 *   3. paste with bracketed-paste mode (-p) so apps treat as literal text;
 *      delete buffer after paste (-d); preserve LF (-r)
 *   4. wait MU_SEND_DELAY_MS (default 500) so the agent ingests the text
 *   5. send Enter as a real key event
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
}

// ─── Capture ───────────────────────────────────────────────────────────

export interface CaptureOptions {
  /**
   * Number of trailing lines to capture. Omitted = full scrollback.
   * 0 = visible pane only.
   */
  lines?: number;
}

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
