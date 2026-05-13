// mu — VCS workspace abstraction hub.
//
// Concrete backends live in the cohesive src/vcs/ cluster: one file per
// backend plus shared types/helpers. This root file preserves the public
// `import { ... } from "./vcs.js"` surface.

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
  backendByName,
  detectBackend,
  gitBackend,
  jjBackend,
  noneBackend,
  slBackend,
} from "./vcs/index.js";
