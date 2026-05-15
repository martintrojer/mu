// Drop into a managed agent's tmux pane from inside the TUI.
//
// Mirrors the `tuicr.ts` / `lazygit.ts` per-popup escape-hatch
// pattern: leave the alt screen, hand the terminal to tmux, restore
// the alt screen on return. Bound to `a` in the Agents popup
// (counterpart to per-revision `t tuicr` and per-cwd `l lazygit`).
//
// Mechanics: the user is almost certainly already inside a tmux
// client (mu's TUI was launched from a pane). From-inside the right
// verb is `tmux switch-client -t <session>:<window>`; from-outside
// (no $TMUX) we fall back to `tmux attach -t <session>` then
// `select-window`. Both branches keep stdio inherited so any tmux
// password / prompt / confirmation reaches the user.
//
// Returning to the orchestrator: the user navigates back to the
// originating window themselves (Ctrl-B p, Ctrl-B <window>, etc.).
// We do NOT auto-restore — the alt-screen restore happens when the
// user re-runs `mu` or just hits whatever brings them back. This
// matches `tuicr` / `lazygit` semantics: the escape is one-way until
// the user explicitly comes back.
//
// In practice for the in-tmux case (the common path): switch-client
// returns immediately after pointing the client at the new
// session:window, so the alt-screen restore fires almost instantly
// and the user is now looking at the worker pane in the same client.
// The mu TUI is still running in its original window — switching
// back via Ctrl-B p brings it into view, alt-screen still active.

import { spawnSync } from "node:child_process";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./escapes.js";

export interface RunTmuxAttachOptions {
  /** Tmux session name, e.g. `mu-multimachine`. */
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
}

export interface RunTmuxAttachResult {
  ok: boolean;
  error?: string;
}

export function runTmuxAttachInteractive(
  opts: RunTmuxAttachOptions,
  deps: RunTmuxAttachDeps = {},
): RunTmuxAttachResult {
  const run = deps.spawn ?? (spawnSync as SpawnSyncFn);
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const env = deps.env ?? process.env;
  const target = `${opts.session}:${opts.window}`;
  const insideTmux = typeof env.TMUX === "string" && env.TMUX.length > 0;
  let result: RunTmuxAttachResult = { ok: true };

  try {
    write(ALT_SCREEN_EXIT);
    if (insideTmux) {
      const r = run("tmux", ["switch-client", "-t", target], {
        stdio: "inherit",
        env,
      });
      if (r.error !== undefined) {
        result = { ok: false, error: tmuxAttachErrorMessage(r.error) };
      } else if (typeof r.status === "number" && r.status !== 0) {
        result = { ok: false, error: `tmux switch-client exited ${r.status}` };
      }
    } else {
      // Not inside tmux: attach to the session, then select the
      // window. Two separate invocations because `tmux attach -t
      // session:window` doesn't reliably select the window across
      // tmux versions; the explicit two-step works everywhere.
      const attach = run("tmux", ["attach-session", "-t", opts.session], {
        stdio: "inherit",
        env,
      });
      if (attach.error !== undefined) {
        result = { ok: false, error: tmuxAttachErrorMessage(attach.error) };
      } else if (typeof attach.status === "number" && attach.status !== 0) {
        result = { ok: false, error: `tmux attach-session exited ${attach.status}` };
      } else {
        // Best-effort window selection AFTER the attach detaches.
        // If this fails the user is at least in the right session.
        run("tmux", ["select-window", "-t", target], { stdio: "inherit", env });
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
    if (code === "ENOENT") return "tmux not found · install tmux";
    return err.message.length > 0 ? err.message : String(err);
  }
  return String(err);
}
