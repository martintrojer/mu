// mu — shared multiplexer backend contracts and typed errors.
//
// A "mux" is the terminal multiplexer that owns panes. mu supports one
// active backend per invocation, chosen by `detectMux()` in ./detect.js.
// Everything backend-specific lives behind `MuxBackend`:
//
//   - session / window / pane topology
//   - the send protocol (bracketed paste on tmux)
//   - scrollback capture
//   - PANE ID VALIDATION — tmux `%15` vs herdr `w1:p1`, which is why
//     there is no global pane-id regex
//   - ACTOR IDENTITY fallback — how to ask "which agent is this pane?"
//
// Same shape as src/vcs/: a types module, one file per impl, and an
// index that dispatches. See docs/VOCABULARY.md § "mux backend".

import type { DetectedStatus } from "../detect.js";
import type { HasNextSteps, NextStep } from "../output.js";

/** The multiplexers mu can drive. */
export type MuxBackendName = "herdr" | "tmux";

// ─── Domain types ──────────────────────────────────────────────────────
//
// Deliberately narrow: these carry only the fields mu actually reads.
// A backend that knows more about a pane keeps that to itself.

export interface MuxSession {
  name: string;
}

export interface MuxWindow {
  /** Backend-specific window handle (tmux `@1`). */
  id: string;
  name: string;
  /** Session this window belongs to (only set by cross-session listings). */
  sessionName?: string;
}

export interface MuxPane {
  /** Backend-specific stable pane id (tmux `%15`). Never a volatile index. */
  paneId: string;
  /** The agent's name, in mu's convention. */
  title: string;
  /** Current foreground command (e.g. "claude", "node", "bash"). */
  command: string;
  /** Window this pane lives in. Only set by cross-window listings. */
  windowId?: string;
  /** Session this pane lives in. Only set by cross-session listings. */
  sessionName?: string;
}

export interface NewSessionOptions {
  detached?: boolean;
  windowName?: string;
  command?: string;
  /** Initial working directory for the first pane (`-c <path>`). */
  cwd?: string;
  /** Extra env vars to set in the new pane. On tmux this is `-e KEY=VALUE`
   *  (tmux 3.0+), which sets the variable in the new pane's environment
   *  without polluting the server's global env. */
  env?: Record<string, string>;
}

export interface NewSessionWithPaneOptions {
  windowName: string;
  command: string;
  cwd?: string;
  detached?: boolean;
  /** Extra env vars to set in the new pane. */
  env?: Record<string, string>;
}

export interface NewWindowOptions {
  /** Target session. Required if invoking outside an existing client. */
  session?: string;
  /** Window name. Maps to the agent's `tab:` value (or its name if no tab). */
  name: string;
  /** Command to run in the first pane. */
  command: string;
  /** If true, do not switch focus. Defaults to true. */
  detached?: boolean;
  /** Initial working directory (`-c <path>`). */
  cwd?: string;
  /** Extra env vars to set in the new pane. */
  env?: Record<string, string>;
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
  /** Extra env vars to set in the new pane. */
  env?: Record<string, string>;
}

/** Where an attach should land the user. */
export interface AttachTarget {
  /** Mux session name, e.g. `mu-auth`. */
  session: string;
  /** Window inside that session (the agent's `tab`, or its name). */
  window?: string;
  /** True when the caller is already inside a client of this mux, which
   *  on tmux means `switch-client` rather than `attach-session`. */
  inside?: boolean;
}

/** One argv the caller may execute to hand the terminal to the mux. */
export interface MuxCommand {
  command: string;
  args: readonly string[];
  /** Best-effort step: a non-zero exit is not a failure of the attach
   *  as a whole (tmux's post-attach `select-window`, for instance). */
  optional?: boolean;
}

/** What a backend can say about its own health. Deliberately DATA, not
 *  prose: `mu doctor` owns all rendering (human and --json). */
export interface MuxHealth {
  /** Backend name, echoed so doctor can label the row. */
  name: MuxBackendName;
  /** True iff the backend answered a version probe. */
  ok: boolean;
  /** Version string as the backend reports it, or null when unreachable. */
  version: string | null;
  /** Ambient env facts this backend cares about, in display order
   *  (tmux: $TMUX / $TMUX_PANE). Values are null when unset. */
  env: readonly { name: string; value: string | null }[];
  /** Remediation line shown when `ok` is false. */
  remediation: string;
}

export interface SendOptions {
  /** Override the default delay between paste and Enter, in ms. */
  delayMs?: number;
  /**
   * Override the pre-send readiness budget, in ms. 0 disables the wait
   * AND the post-send submit verification.
   */
  readinessMs?: number;
  /** Called when the send could not be confirmed as submitted. */
  onUndelivered?: (warning: SendWarning) => void;
}

/** Why a send could not be confirmed as submitted. */
export interface SendWarning {
  paneId: string;
  /** 'paste-vanished' — pane looked calm, but the text stayed stranded
   *  in the input box. 'busy-at-deadline' — pane never quiesced within
   *  the budget and the text stayed stranded. */
  reason: "busy-at-deadline" | "paste-vanished";
  message: string;
}

/**
 * What `startAgentInPane` needs to know. mu has already resolved the
 * command it WOULD have run in a create-and-run backend; a backend that
 * starts agents itself needs both that string and the `--cli` key it came
 * from, because those select different routes (see the herdr impl).
 */
export interface StartAgentInPaneOptions {
  /** An existing pane, sitting at its interactive shell prompt. */
  paneId: string;
  /** mu's agent name. Backends with their own agent registry use it as
   *  the mux-level handle too. */
  name: string;
  /** mu's `--cli` key, e.g. "pi". A backend that classifies agent kinds
   *  natively maps this onto its own kind vocabulary. */
  cli: string;
  /** Fully resolved command string mu would otherwise have spawned. */
  command: string;
  /**
   * Where `command` came from. A backend that resolves the executable
   * ITSELF (rather than running the string mu hands it) must not silently
   * discard an operator's explicit choice, and needs to know which one it
   * is so the diagnostic can name the right thing to change:
   *
   *   "cli-key"  — just the `--cli` value; nothing to honour, proceed.
   *   "env"      — a `MU_<UPPER_CLI>_COMMAND` override.
   *   "explicit" — an explicit `--command "…"`.
   */
  commandSource: "cli-key" | "env" | "explicit";
}

export interface CaptureOptions {
  /**
   * Number of trailing lines to capture. Omitted = full scrollback.
   * 0 = visible pane only.
   */
  lines?: number;
}

// ─── Title parsing ───────────────────────────────────────────────

/**
 * Extract the agent-name token from a (possibly composed) pane title.
 * mu's `composeAgentTitle` renders titles as `name · <glyph> · task_id`;
 * the agent name is always the first ' · '-separated token. Adopted
 * panes mu never re-titled have just the name — still parses.
 *
 * Backend-INDEPENDENT: the format is mu's, not any multiplexer's, so
 * every backend that can read a pane title parses it the same way.
 * Lives here rather than in an impl so migrated call sites can use it
 * without importing tmux.
 */
export function parseAgentNameFromTitle(title: string): string {
  const idx = title.indexOf(" · ");
  return idx === -1 ? title.trim() : title.slice(0, idx).trim();
}

// ─── Errors ────────────────────────────────────────────────────────────

/**
 * Base class for "the multiplexer itself failed". Each backend
 * subclasses it (tmux → `TmuxError`) so `handle()` can map the whole
 * family to exit code 5 (substrate unavailable) with one `instanceof`.
 */
export class MuxError extends Error implements HasNextSteps {
  override name: string = "MuxError";
  errorNextSteps(): NextStep[] {
    return [{ intent: "Run health check", command: "mu doctor" }];
  }
}

/**
 * Thrown when a verb references a pane id that doesn't exist on the
 * running multiplexer. Distinct from `MuxError` (which wraps any mux
 * command failure) so callers can map it to a specific exit code
 * (`mu` maps it to 5 alongside other mux issues, but the message is
 * more actionable than raw backend stderr).
 *
 * The backend-specific half of the remediation comes from the backend
 * that raised it: showing a herdr user `tmux info | head` would be
 * worse than showing no hint at all. Callers that construct this error
 * already hold the active backend, so passing it is free; the
 * no-backend form degrades to mu's own verbs only.
 */
export class PaneNotFoundError extends Error implements HasNextSteps {
  override readonly name = "PaneNotFoundError";
  constructor(
    public readonly paneId: string,
    private readonly backend?: MuxDiagnostics,
  ) {
    super(`${backend?.name ?? "mux"} pane not found: ${paneId}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      ...(this.backend?.paneNotFoundNextSteps(this.paneId) ?? []),
      {
        intent: "List workstreams to choose the right scope",
        command: "mu workstream list",
      },
      {
        intent: "List registered agents and orphan panes in that scope",
        command: "mu agent list -w <workstream>",
      },
    ];
  }
}

/** The slice of a backend `PaneNotFoundError` needs. Structural so the
 *  error type doesn't depend on the whole backend contract. */
export interface MuxDiagnostics {
  readonly name: MuxBackendName;
  paneNotFoundNextSteps(paneId: string): NextStep[];
}

/**
 * Thrown by `detectMux()` when no supported multiplexer is available.
 * Maps to exit 5 (substrate unavailable) — the same bucket as "tmux is
 * installed but the server is unreachable", because from the caller's
 * point of view both mean "mu cannot reach a pane right now".
 */
export class NoMultiplexerError extends Error implements HasNextSteps {
  override readonly name = "NoMultiplexerError";
  constructor(public readonly tried: readonly string[]) {
    super(
      `no supported multiplexer found (tried: ${tried.join(", ")}). mu drives agents through tmux panes.`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Run health check", command: "mu doctor" },
      { intent: "Verify tmux is installed", command: "tmux -V" },
      { intent: "Force a specific backend", command: "MU_MUX=tmux mu <verb>" },
    ];
  }
}

// ─── The backend contract ──────────────────────────────────────────────

/**
 * One multiplexer implementation. Methods mirror the operations mu
 * actually performs; nothing is here speculatively.
 *
 * Implementations must be stateless value objects (a frozen record of
 * functions), so swapping the active backend is a pointer assignment
 * and tests can install a fake without teardown ordering hazards.
 */
export interface MuxBackend {
  readonly name: MuxBackendName;

  /** True iff this backend can drive panes on this machine right now.
   *  Consulted by `detectMux()` in precedence order. */
  available(): Promise<boolean>;

  // — pane id validation (shape is backend-specific) —
  isValidPaneId(s: string): boolean;
  assertValidPaneId(s: string): void;

  // — sessions —
  listSessions(): Promise<MuxSession[]>;
  sessionExists(name: string): Promise<boolean>;
  newSession(name: string, opts?: NewSessionOptions): Promise<void>;
  newSessionWithPane(name: string, opts?: NewSessionWithPaneOptions): Promise<string>;
  killSession(name: string): Promise<void>;

  // — windows —
  listWindows(session?: string): Promise<MuxWindow[]>;
  newWindow(opts: NewWindowOptions): Promise<string>;
  selectLayout(window: string, layout: string): Promise<void>;

  // — panes —
  listPanes(target?: string): Promise<MuxPane[]>;
  listPanesInSession(session: string): Promise<MuxPane[]>;
  splitWindow(opts: SplitWindowOptions): Promise<string>;
  killPane(paneId: string): Promise<void>;
  paneExists(paneId: string): Promise<boolean>;
  paneTTY(paneId: string): Promise<string>;

  // — identity —
  //
  // The FALLBACK rung of actor resolution. `$MU_AGENT_NAME` is checked
  // first by the caller (src/tasks/claim.ts) and is backend-independent;
  // this exists because adopted panes predate that env injection.
  setPaneTitle(paneId: string, title: string): Promise<void>;
  getPaneTitle(paneId: string): Promise<string | undefined>;
  currentAgentName(): Promise<string | undefined>;
  /** Name of the session the CALLER is running inside, or undefined
   *  when outside one. Backs the `mu-<name>` rung of workstream
   *  auto-detection, which is why it is identity and not topology. */
  currentSessionName(): Promise<string | undefined>;

  // — spawn —
  //
  // OPTIONAL, and its absence is the DEFAULT shape: tmux creates a pane
  // and runs a command in one atomic call, so `NewWindowOptions.command`
  // et al. carry the command and there is nothing left to do.
  //
  // A backend that has no create-and-run form implements this instead.
  // mu then creates the pane bare, calls `startAgentInPane`, and — because
  // such a backend only returns once IT considers the agent ready for
  // input — SKIPS its own liveness/readiness polling. This is a capability
  // flag, not a backend name check: `src/agents/spawn.ts` branches on the
  // method being present, never on `mux.name`.
  startAgentInPane?(opts: StartAgentInPaneOptions): Promise<void>;

  // — io —
  sendToPane(paneId: string, text: string, opts?: SendOptions): Promise<void>;
  capturePane(paneId: string, opts?: CaptureOptions): Promise<string>;

  /**
   * The pane's lifecycle status AS THE MUX ITSELF CLASSIFIES IT, or
   * undefined when the pane is gone / unclassified.
   *
   * OPTIONAL by design, and the one place the two backends genuinely
   * differ in kind rather than in syntax. tmux knows nothing about what
   * runs inside a pane, so it omits this and mu falls back to scraping
   * scrollback with the per-CLI detector in `src/detect.ts`. herdr
   * watches the terminal continuously across every agent kind it
   * recognises, so it implements this and the detector is BYPASSED
   * entirely — guessing from a 100-line tail would be strictly worse
   * information than the substrate's own answer.
   *
   * Absent method ⇒ "ask the detector". Present-but-undefined result ⇒
   * "this pane has no status", NOT "free": no detector may mint `free`,
   * which only `mu agent free` sets.
   */
  paneStatus?(paneId: string): Promise<DetectedStatus | undefined>;

  // — chrome (decorative; a backend with no equivalent no-ops) —
  enableMuPaneBordersForSession(session: string): Promise<number>;
  enableMuPaneBordersForPane(paneId: string): Promise<void>;

  // — attach —
  //
  // Two shapes for the same intent because mu has two consumers:
  // `mu agent attach` PRINTS a copy-pasteable line, the TUI's `a` key
  // EXECUTES the steps. Neither may hardcode a tmux string.

  /** Copy-pasteable shell line that lands the user on `target`. */
  attachHint(target: AttachTarget): string;
  /** The same attach, as argv steps to spawn in order. */
  attachCommands(target: AttachTarget): readonly MuxCommand[];

  // — diagnostics —

  /** Backend-specific `PaneNotFoundError` remediation. */
  paneNotFoundNextSteps(paneId: string): NextStep[];
  /** Version + ambient facts for `mu doctor`. Never throws: an
   *  unreachable backend reports `ok: false`. */
  healthCheck(): Promise<MuxHealth>;
}
