// Drop into `lazygit` from inside the TUI: leaves the alt screen,
// inherits stdio so lazygit owns the terminal, restores the alt
// screen on exit. Mirrors `runTuicrInteractive` (src/cli/tui/tuicr.ts)
// — same dependency-injection seam, same error-shape contract — so
// test coverage and behavioural conventions stay consistent across
// the two TUI escape hatches.
//
// Bound to `l` in the Commits popup LIST mode (counterpart to
// `t tuicr` in the per-revision git-show DRILL): lazygit operates on
// a cwd, not on a single revision, so the natural surface is the
// list-level "browse this repo" exit, not a per-row drill.

import { spawnSync } from "node:child_process";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./escapes.js";

export interface RunLazygitOptions {
  /** Project root / workspace cwd used by lazygit for repo detection. */
  cwd: string;
}

interface SpawnSyncResult {
  status: number | null;
  error?: Error;
}

type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv },
) => SpawnSyncResult;

export interface RunLazygitDeps {
  spawn?: SpawnSyncFn;
  write?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface RunLazygitResult {
  ok: boolean;
  error?: string;
}

export function runLazygitInteractive(
  opts: RunLazygitOptions,
  deps: RunLazygitDeps = {},
): RunLazygitResult {
  const run = deps.spawn ?? (spawnSync as SpawnSyncFn);
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const env = deps.env ?? process.env;
  let result: RunLazygitResult = { ok: true };

  try {
    write(ALT_SCREEN_EXIT);
    const r = run("lazygit", [], {
      cwd: opts.cwd,
      stdio: "inherit",
      env,
    });
    if (r.error !== undefined) {
      result = { ok: false, error: lazygitErrorMessage(r.error) };
    } else if (typeof r.status === "number" && r.status !== 0) {
      result = { ok: false, error: `lazygit exited ${r.status}` };
    }
  } catch (err) {
    result = { ok: false, error: lazygitErrorMessage(err) };
  } finally {
    try {
      write(ALT_SCREEN_ENTER);
    } catch {
      // Best-effort terminal repair only. Preserve the original result.
    }
  }

  return result;
}

export function lazygitErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "lazygit not found · install from https://github.com/jesseduffield/lazygit";
    }
    return err.message.length > 0 ? err.message : String(err);
  }
  return String(err);
}
