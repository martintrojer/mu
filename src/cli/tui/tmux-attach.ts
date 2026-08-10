// Drop into a managed agent's pane from inside the TUI.
//
// Mirrors the `tuicr.ts` / `lazygit.ts` per-popup escape-hatch
// pattern: leave the alt screen, hand the terminal to the multiplexer,
// restore the alt screen on return. Bound to `a` in the Agents popup
// (counterpart to per-revision `t tuicr` and per-cwd `l lazygit`).
//
// Mechanics live in the BACKEND, not here. `attachCommands()` returns
// the argv steps for the active mux; this module only runs them with
// stdio inherited (so any password / prompt / confirmation reaches the
// user) and bookends them with the alt-screen dance. On tmux that is
// `switch-client` when the caller is already inside a client and
// `attach-session` + `select-window` otherwise, but this file does not
// know that and must not.
//
// Returning to the orchestrator: the user navigates back to the
// originating window themselves (Ctrl-B p, Ctrl-B <window>, etc.).
// We do NOT auto-restore — the alt-screen restore happens when the
// user re-runs `mu` or just hits whatever brings them back. This
// matches `tuicr` / `lazygit` semantics: the escape is one-way until
// the user explicitly comes back.
//
// In practice for the in-mux case (the common path): switch-client
// returns immediately after pointing the client at the new
// session:window, so the alt-screen restore fires almost instantly
// and the user is now looking at the worker pane in the same client.
// The mu TUI is still running in its original window — switching
// back via Ctrl-B p brings it into view, alt-screen still active.

import { spawnSync } from "node:child_process";
import { activeMux, type MuxCommand } from "../../mux.js";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./escapes.js";

export interface RunTmuxAttachOptions {
  /** Mux session name, e.g. `mu-multimachine`. */
  session: string;
  /** Window name or index inside the session (the agent's `tab`
   *  field, or its `name` if `tab` is null). */
  window: string;
}

interface SpawnSyncResult {
  status: number | null;
  error?: Error;
}

type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
) => SpawnSyncResult;

export interface RunTmuxAttachDeps {
  spawn?: SpawnSyncFn;
  write?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Pre-resolved attach steps. Tests inject these to stay off a real
   *  mux; production resolves them from `activeMux()`. */
  commands?: readonly MuxCommand[];
}

export interface RunTmuxAttachResult {
  ok: boolean;
  error?: string;
}

/**
 * Resolve the attach steps for `opts` from the active backend.
 *
 * Best-effort by design: the TUI's `a` key is an escape hatch, not a
 * verb. With no reachable mux the caller gets an error string in the
 * footer instead of a crashed TUI.
 */
export async function resolveAttachCommands(
  opts: RunTmuxAttachOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly MuxCommand[] | undefined> {
  try {
    const mux = await activeMux();
    // `inside` is a tmux-shaped question ("are we in a client of this
    // mux?"), but the ANSWER is the backend's business — we just report
    // the ambient evidence we have.
    const inside = typeof env.TMUX === "string" && env.TMUX.length > 0;
    return mux.attachCommands({ session: opts.session, window: opts.window, inside });
  } catch {
    return undefined;
  }
}

/**
 * Run pre-resolved attach steps with the alt screen bookended around
 * them. Takes STEPS rather than a target because the backend owns the
 * argv and resolving it is async, while ink's key handler is not.
 */
export function runTmuxAttachInteractive(deps: RunTmuxAttachDeps = {}): RunTmuxAttachResult {
  const run = deps.spawn ?? (spawnSync as SpawnSyncFn);
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const env = deps.env ?? process.env;
  const commands = deps.commands;
  if (commands === undefined || commands.length === 0) {
    return { ok: false, error: "no multiplexer available to attach with" };
  }
  let result: RunTmuxAttachResult = { ok: true };

  try {
    write(ALT_SCREEN_EXIT);
    for (const step of commands) {
      const r = run(step.command, step.args, { stdio: "inherit", env });
      if (step.optional === true) continue;
      if (r.error !== undefined) {
        result = { ok: false, error: tmuxAttachErrorMessage(r.error) };
        break;
      }
      if (typeof r.status === "number" && r.status !== 0) {
        result = {
          ok: false,
          error: `${step.command} ${step.args[0] ?? ""} exited ${r.status}`.trim(),
        };
        break;
      }
    }
  } catch (err) {
    result = { ok: false, error: tmuxAttachErrorMessage(err) };
  } finally {
    try {
      write(ALT_SCREEN_ENTER);
    } catch {
      // Best-effort terminal repair only. Preserve the original result.
    }
  }

  return result;
}

export function tmuxAttachErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "multiplexer binary not found";
    return err.message.length > 0 ? err.message : String(err);
  }
  return String(err);
}
