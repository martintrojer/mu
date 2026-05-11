// mu — kickAgent: signal a wedged worker pane's foreground process
// group from outside the pane.
//
// Why this verb exists: pi/claude/codex CLIs catch SIGINT themselves
// (Ctrl-C is a UI input, not a process signal). When a worker is
// wedged on a long-running tool subprocess (an unbounded `find /`,
// a busy-wait loop, ...) the orchestrator's options were:
//
//   - `mu agent send` — queues; the message is read after the tool
//     subprocess returns, which is exactly the wait we're trying to
//     shortcut.
//   - `tmux send-keys C-c` against the pane — the wrapping CLI eats
//     the signal as TUI input; doesn't reach the tool subprocess.
//   - drop out of mu, `pgrep -af "find /"`, `kill <pid>` — works,
//     but breaks the orchestrator's mental model and is fiddly.
//
// `mu agent kick` looks up the pane's TTY via tmux, asks `ps -t <tty>`
// for the foreground process group (the pgid whose `stat` field
// contains a `+`), and kills(2) that pgid directly. Default signal
// is SIGINT (graceful, matches what Ctrl-C would do if it
// propagated); --signal SIGTERM / SIGKILL escalate.
//
// Source feedback: workers_commonly_attempt_unbounded_find. The
// PART A spec.

import { type AgentRow, getAgent } from "../agents.js";
import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import type { HasNextSteps, NextStep } from "../output.js";
import { paneTTY } from "../tmux.js";
import { AgentNotFoundError } from "./errors.js";

// ─── Allowed signals ─────────────────────────────────────────────────

/** The signal set kick supports. SIGINT is graceful (matches Ctrl-C
 *  semantics — what the operator probably wanted in the first place);
 *  SIGTERM is the polite escalation; SIGKILL is the unblockable
 *  hammer. We deliberately don't expose arbitrary signals — the
 *  three above are the actionable ones for "interrupt a wedged
 *  foreground tool subprocess." */
export type KickSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

const ALLOWED_SIGNALS: readonly KickSignal[] = ["SIGINT", "SIGTERM", "SIGKILL"];

export function isKickSignal(s: string): s is KickSignal {
  return (ALLOWED_SIGNALS as readonly string[]).includes(s);
}

// ─── Errors ──────────────────────────────────────────────────────────

/**
 * Thrown when the foreground pgid lookup on a pane's TTY yields
 * either no rows at all (the pane is sitting at an idle shell with
 * no foreground job) or only the wrapping shell itself (the LLM CLI
 * — pi/claude/codex — is the foreground; signalling it would close
 * the agent, which is what `mu agent close` is for).
 *
 * Maps to the generic exit code 1 in handle.ts (this is a
 * runtime-state condition, not a typed not-found / conflict).
 */
export class NoForegroundProcessError extends Error implements HasNextSteps {
  override readonly name = "NoForegroundProcessError";
  constructor(
    public readonly agentName: string,
    public readonly tty: string,
    public readonly reason: "no-foreground" | "shell-only",
  ) {
    const detail =
      reason === "no-foreground"
        ? `no foreground process group on tty ${tty} (pane is idle)`
        : `the only foreground process on tty ${tty} is the agent's wrapping CLI itself; refusing to signal it (use \`mu agent close ${agentName}\` to close the agent)`;
    super(`agent ${agentName}: ${detail}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Inspect what's running in the pane",
        command: `mu agent show ${this.agentName} -n 50`,
      },
      {
        intent: "Close the agent (kills the wrapping CLI + pane)",
        command: `mu agent close ${this.agentName}`,
      },
    ];
  }
}

// ─── Process executor (swappable for tests) ──────────────────────────
//
// Mirrors the `setTmuxExecutor` pattern in src/tmux.ts so unit tests
// can mock `ps -t <tty>` and `kill -<sig> -<pgid>` without touching
// real processes.

export interface KickProcessExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type KickProcessExecutor = (
  cmd: string,
  args: readonly string[],
) => Promise<KickProcessExecResult>;

const realExecutor: KickProcessExecutor = async (cmd, args) => {
  // Lazy-load execa: this module is on the cold path (kick is rare),
  // and the unit tests swap in a mock executor before any real call
  // would be made.
  const { execa } = await import("execa");
  const result = await execa(cmd, [...args], { reject: false });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? null,
  };
};

let currentExecutor: KickProcessExecutor = realExecutor;

/** Install a custom executor (for tests). Returns the previous one so
 *  tests can restore cleanly. */
export function setKickProcessExecutor(executor: KickProcessExecutor): KickProcessExecutor {
  const previous = currentExecutor;
  currentExecutor = executor;
  return previous;
}

/** Restore the real executor. */
export function resetKickProcessExecutor(): void {
  currentExecutor = realExecutor;
}

// ─── Foreground pgid lookup ──────────────────────────────────────────

interface PsRow {
  pid: number;
  pgid: number;
  /** ps's `stat` (or `state`) field. The presence of `+` means
   *  "foreground process group on its controlling tty". */
  stat: string;
  /** Process command (just the comm; truncated, used for diagnostics). */
  comm: string;
}

/**
 * Parse `ps -t <tty> -o pid=,pgid=,stat=,comm=` output. Each non-blank
 * line is one process: four whitespace-separated fields. Defensive
 * about leading whitespace and command names with embedded spaces
 * (the comm is the LAST field — join the tail).
 */
export function parsePsTtyOutput(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [pidStr, pgidStr, stat, ...commParts] = parts;
    if (pidStr === undefined || pgidStr === undefined || stat === undefined) continue;
    const pid = Number.parseInt(pidStr, 10);
    const pgid = Number.parseInt(pgidStr, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(pgid)) continue;
    rows.push({ pid, pgid, stat, comm: commParts.join(" ") });
  }
  return rows;
}

/**
 * Resolve the foreground process group id for a TTY device path. The
 * canonical signal `ps`'s `stat` field uses is `+` (BSD/Darwin AND
 * Linux procps). We pick the first row whose stat contains `+`; its
 * `pgid` is the foreground pgid of that controlling terminal.
 *
 * Returns:
 *   - `{ kind: "ok", pgid, fgRow }` on success
 *   - `{ kind: "no-foreground" }` when no row carries `+` AND there
 *     are no candidate rows at all
 *   - `{ kind: "shell-only", pgid, fgRow }` when the foreground pgid
 *     resolves to a shell whose comm is the agent's wrapping CLI
 *     (caller decides whether to refuse — kick refuses)
 *
 * The wrapping-CLI guard is intentionally narrow: we only refuse
 * when the foreground process command matches one of the known
 * pi/claude/codex/zsh/bash shapes. Anything else (a `find`, a
 * `cargo build`, a `python script.py`) is exactly what we want to
 * signal — that's the unbounded-tool case the verb was built for.
 */
export interface ForegroundLookup {
  kind: "ok" | "shell-only" | "no-foreground";
  pgid?: number;
  fgRow?: PsRow;
  /** All rows ps returned for the tty, for diagnostics / tests. */
  rows: PsRow[];
}

/** Comm names we treat as the agent's wrapping CLI / shell. Signalling
 *  these via kick would just terminate the agent itself; that's
 *  `mu agent close`'s job. The match is loose (suffix on basename)
 *  so paths like `/usr/local/bin/pi` and aliases like `pi-meta` match
 *  the right family. */
const WRAPPER_COMM_PREFIXES: readonly string[] = [
  "pi",
  "claude",
  "codex",
  "bash",
  "zsh",
  "sh",
  "fish",
  "dash",
];

function isWrapperComm(comm: string): boolean {
  // ps -o comm= returns the basename of the executable, possibly with
  // a leading `-` (login shell). Strip both.
  const cleaned = comm.replace(/^-/, "").trim();
  if (cleaned === "") return false;
  // Match exactly OR with a `-suffix` (e.g. `pi-meta`, `bash-3.2`).
  for (const prefix of WRAPPER_COMM_PREFIXES) {
    if (cleaned === prefix) return true;
    if (cleaned.startsWith(`${prefix}-`)) return true;
  }
  return false;
}

export async function foregroundPgid(tty: string): Promise<ForegroundLookup> {
  // Strip the `/dev/` prefix because some `ps` implementations want
  // the tty as e.g. `ttys012` rather than `/dev/ttys012`. macOS's
  // ps accepts both; Linux's procps wants the short form. Pass the
  // short form everywhere for portability.
  const ttyShort = tty.startsWith("/dev/") ? tty.slice("/dev/".length) : tty;
  const result = await currentExecutor("ps", ["-t", ttyShort, "-o", "pid=,pgid=,stat=,comm="]);
  // ps exits 1 with empty output when no process is attached to the
  // tty; treat as no-foreground rather than throw.
  if (result.exitCode !== 0 && result.stdout.trim() === "") {
    return { kind: "no-foreground", rows: [] };
  }
  const rows = parsePsTtyOutput(result.stdout);
  if (rows.length === 0) return { kind: "no-foreground", rows };
  // Find the foreground row: stat contains `+`.
  const fg = rows.find((r) => r.stat.includes("+"));
  if (!fg) {
    // ps returned rows but none is foreground. Treat as no-foreground.
    return { kind: "no-foreground", rows };
  }
  if (isWrapperComm(fg.comm)) {
    return { kind: "shell-only", pgid: fg.pgid, fgRow: fg, rows };
  }
  return { kind: "ok", pgid: fg.pgid, fgRow: fg, rows };
}

// ─── kill(2) the process group ────────────────────────────────────────

/**
 * Send `signal` to process group `pgid`. The `kill -SIG -<pgid>` form
 * (negative pid) targets the whole pgrp, which is what we want — a
 * single `find` invocation may have spawned helpers; we want to take
 * the whole tree down with one signal.
 */
async function killPgrp(pgid: number, signal: KickSignal): Promise<void> {
  const result = await currentExecutor("kill", [`-${signal}`, `-${pgid}`]);
  if (result.exitCode !== 0) {
    // ESRCH (pgid already gone) is benign — the process completed
    // between our ps and our kill. Treat as success.
    if (/no such process/i.test(result.stderr)) return;
    throw new Error(
      `kill -${signal} -${pgid} failed (exit ${result.exitCode}): ${result.stderr.trim() || "no stderr"}`,
    );
  }
}

// ─── Public verb ──────────────────────────────────────────────────────

export interface KickAgentOptions {
  workstream: string;
  /** Defaults to SIGINT (matches Ctrl-C semantics). */
  signal?: KickSignal;
}

export interface KickAgentResult {
  agentName: string;
  paneId: string;
  /** TTY device path the foreground pgid was resolved against. */
  tty: string;
  /** The pgid we signalled. */
  signaledPgid: number;
  signal: KickSignal;
  /** The comm of the foreground process at the time of signal — useful
   *  diagnostic in the event log ("we kicked a `find`, not a `cargo`"). */
  foregroundComm: string;
}

/**
 * Send `signal` to the foreground process group of an agent's pane
 * TTY. Default signal is SIGINT.
 *
 * Errors:
 *   - `AgentNotFoundError` — the agent doesn't exist in this workstream.
 *   - `PaneNotFoundError` (from paneTTY) — the agent's pane has vanished.
 *   - `NoForegroundProcessError` — pane has no foreground job, OR the
 *     foreground is the wrapping CLI itself (refuse; use `mu agent close`).
 *
 * Emits an `agent kick <name> (signal=..., pgid=..., comm=...)` event
 * on success.
 */
export async function kickAgent(
  db: Db,
  name: string,
  opts: KickAgentOptions,
): Promise<KickAgentResult> {
  const signal: KickSignal = opts.signal ?? "SIGINT";
  const agent: AgentRow | undefined = getAgent(db, name, opts.workstream);
  if (!agent) throw new AgentNotFoundError(name, opts.workstream);
  const tty = await paneTTY(agent.paneId);
  const lookup = await foregroundPgid(tty);
  if (lookup.kind === "no-foreground") {
    throw new NoForegroundProcessError(name, tty, "no-foreground");
  }
  if (lookup.kind === "shell-only") {
    throw new NoForegroundProcessError(name, tty, "shell-only");
  }
  // kind === "ok"
  const pgid = lookup.pgid;
  const fgRow = lookup.fgRow;
  if (pgid === undefined || fgRow === undefined) {
    // Should be unreachable given the discriminator; defensive throw
    // satisfies noUncheckedIndexedAccess + future-refactor safety.
    throw new NoForegroundProcessError(name, tty, "no-foreground");
  }
  await killPgrp(pgid, signal);
  emitEvent(
    db,
    agent.workstreamName,
    `agent kick ${name} (signal=${signal}, pgid=${pgid}, comm=${fgRow.comm})`,
  );
  return {
    agentName: name,
    paneId: agent.paneId,
    tty,
    signaledPgid: pgid,
    signal,
    foregroundComm: fgRow.comm,
  };
}
