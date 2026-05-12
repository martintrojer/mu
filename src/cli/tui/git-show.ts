// Pure helper for the Workspaces popup's third-level git-show drill.
//
// Extracted from src/cli/tui/popups/workspaces.tsx (loadShow) per
// review_tests_workspaces_show_loadshow_unmocked: the body — execFile
// invocation + arg list + truncation + error stringification — was
// living inside a useCallback that no test ever called. The previous
// coverage was a static-source assertion ("does the file contain the
// literal '--color=never'?"); a regression that swapped
// `--color=never` to `--color=always` would have passed.
//
// This module:
//   - has zero ink/react imports (callable from a vitest worker
//     without spinning up a React renderer);
//   - takes a minimal { execFile } seam so the workspaces popup can
//     pass a stub in tests (default: real promisified execFile);
//   - returns a structured { text, truncated, error } result instead
//     of throwing — matches the popup's existing
//     setShowText/setShowErr split.

import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { SHOW_COMMIT_MAX_CHARS, gitBackend } from "../../vcs.js";

/** Cap the captured `git show` output so a giant merge commit can't
 *  blow the popup's render budget or eat memory. 100_000 chars is
 *  ~1300 wrapped lines at 80 cols; well above the viewport, well
 *  below "runaway". Kept as a TUI-helper export for test/back-compat;
 *  production show execution delegates to VcsBackend.showCommit. */
export const SHOW_MAX_CHARS = SHOW_COMMIT_MAX_CHARS;

/** The exact arg vector passed to git for the show drill. Exported
 *  for test assertions ("the popup must NOT swap --color=never for
 *  --color=always"). */
export function gitShowArgs(path: string, sha: string): string[] {
  return ["-C", path, "show", sha, "--stat", "-p", "--color=never"];
}

export interface RunGitShowResult {
  /** Captured stdout (possibly truncated). Empty string on error. */
  text: string;
  /** True when stdout exceeded SHOW_MAX_CHARS and was clipped. */
  truncated: boolean;
  /** Human-readable error message; null on success. */
  error: string | null;
}

/** Promisified execFile signature — narrow enough to stub in tests
 *  without dragging in execa typings. */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = promisify(nodeExecFile) as ExecFileFn;

/** Show a commit from a git repo. Production callers delegate to
 *  VcsBackend.showCommit so the TUI's show path shares the same seam
 *  as jj/sl. The optional execFile injection remains for this helper's
 *  older unit tests that pin git's exact arg vector. */
export async function runGitShow(
  path: string,
  sha: string,
  opts: { execFile?: ExecFileFn } = {},
): Promise<RunGitShowResult> {
  if (opts.execFile === undefined) {
    const r = await gitBackend.showCommit(path, sha);
    return { text: r.text, truncated: r.truncated, error: r.error ?? null };
  }
  const exec = opts.execFile ?? defaultExecFile;
  try {
    const { stdout } = await exec("git", gitShowArgs(path, sha), {
      maxBuffer: SHOW_MAX_CHARS * 2,
    });
    if (stdout.length > SHOW_MAX_CHARS) {
      return {
        text: `${stdout.slice(0, SHOW_MAX_CHARS)}\n…(truncated at ${SHOW_MAX_CHARS} chars)`,
        truncated: true,
        error: null,
      };
    }
    return { text: stdout, truncated: false, error: null };
  } catch (e) {
    return { text: "", truncated: false, error: e instanceof Error ? e.message : String(e) };
  }
}
