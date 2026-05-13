// mu — VCS backend dispatcher.

import { gitBackend } from "./git.js";
import { jjBackend } from "./jj.js";
import { noneBackend } from "./none.js";
import { slBackend } from "./sl.js";
import type { VcsBackend, VcsBackendName } from "./types.js";

export { gitBackend } from "./git.js";
export { jjBackend } from "./jj.js";
export { noneBackend } from "./none.js";
export { slBackend } from "./sl.js";
export {
  SHOW_COMMIT_MAX_CHARS,
  type CommitSummary,
  type CreateWorkspaceOptions,
  type CreateWorkspaceResult,
  type FreeWorkspaceOptions,
  type FreeWorkspaceResult,
  type RebaseResult,
  type ShowCommitResult,
  type VcsBackend,
  type VcsBackendName,
  WorkspaceConflictError,
  WorkspaceDirtyError,
  WorkspaceVcsRequiredError,
} from "./types.js";

/**
 * Detection precedence: jj > sl > git > none. The first backend whose
 * detect() returns true wins. `none` is always last. Detection shells
 * out to each VCS's canonical root probe (`jj root`, `sl root`, `git
 * rev-parse --show-toplevel`) so worktrees and gitdir-pointer files are
 * handled by the owning tool instead of a brittle marker-dir heuristic.
 */
const BACKENDS: readonly VcsBackend[] = [jjBackend, slBackend, gitBackend, noneBackend];

/** Return the backend that should handle projectRoot. Walks BACKENDS
 *  in precedence order; never returns undefined because noneBackend
 *  always claims. */
export async function detectBackend(projectRoot: string): Promise<VcsBackend> {
  for (const backend of BACKENDS) {
    if (await backend.detect(projectRoot)) return backend;
  }
  return noneBackend;
}

/** Look up a backend by name. Throws on unknown name. Used by
 *  `mu workspace create --backend ...` to honour an explicit override. */
export function backendByName(name: VcsBackendName): VcsBackend {
  for (const backend of BACKENDS) {
    if (backend.name === name) return backend;
  }
  throw new Error(`unknown vcs backend: ${name}`);
}
