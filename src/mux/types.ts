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

import type { HasNextSteps, NextStep } from "../output.js";

/** The multiplexers mu can drive. */
export type MuxBackendName = "tmux";

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

export interface CaptureOptions {
  /**
   * Number of trailing lines to capture. Omitted = full scrollback.
   * 0 = visible pane only.
   */
  lines?: number;
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
 * The remediation hints below are tmux-flavoured because tmux is
 * currently the only backend. Genericising them per-backend is part
 * of the `mux-callsite-migration` task — a herdr user reading
 * "tmux info | head" would be worse off than with no hint at all.
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

  // — io —
  sendToPane(paneId: string, text: string, opts?: SendOptions): Promise<void>;
  capturePane(paneId: string, opts?: CaptureOptions): Promise<string>;

  // — chrome (decorative; a backend with no equivalent no-ops) —
  enableMuPaneBordersForSession(session: string): Promise<number>;
  enableMuPaneBordersForPane(paneId: string): Promise<void>;
}
