import { spawnSync } from "node:child_process";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "./escapes.js";

export interface RunTuicrOptions {
  rev: string;
  /** Project root / workspace cwd used by tuicr for repo detection. */
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

export interface RunTuicrDeps {
  spawn?: SpawnSyncFn;
  write?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface RunTuicrResult {
  ok: boolean;
  error?: string;
}

export function runTuicrInteractive(
  opts: RunTuicrOptions,
  deps: RunTuicrDeps = {},
): RunTuicrResult {
  const run = deps.spawn ?? (spawnSync as SpawnSyncFn);
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const env = deps.env ?? process.env;
  let result: RunTuicrResult = { ok: true };

  try {
    write(ALT_SCREEN_EXIT);
    const r = run("tuicr", ["-r", opts.rev], {
      cwd: opts.cwd,
      stdio: "inherit",
      env,
    });
    if (r.error !== undefined) {
      result = { ok: false, error: tuicrErrorMessage(r.error) };
    } else if (typeof r.status === "number" && r.status !== 0) {
      result = { ok: false, error: `tuicr exited ${r.status}` };
    }
  } catch (err) {
    result = { ok: false, error: tuicrErrorMessage(err) };
  } finally {
    try {
      write(ALT_SCREEN_ENTER);
    } catch {
      // Best-effort terminal repair only. Preserve the original result.
    }
  }

  return result;
}

export function tuicrErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "tuicr not found · install with cargo install tuicr";
    return err.message.length > 0 ? err.message : String(err);
  }
  return String(err);
}
