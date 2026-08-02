// mu — VCS workspace abstraction hub.
//
// Concrete backends live in the cohesive src/vcs/ cluster: one file per
// backend plus shared types/helpers. This root file preserves the public
// `import { ... } from "./vcs.js"` surface.

export {
  backendByName,
  type CommitSummary,
  type CreateWorkspaceOptions,
  type CreateWorkspaceResult,
  detectBackend,
  type FreeWorkspaceOptions,
  type FreeWorkspaceResult,
  gitBackend,
  jjBackend,
  noneBackend,
  type RebaseResult,
  SHOW_COMMIT_MAX_CHARS,
  type ShowCommitResult,
  slBackend,
  type VcsBackend,
  type VcsBackendName,
  WorkspaceConflictError,
  WorkspaceDirtyError,
  WorkspaceVcsRequiredError,
} from "./vcs/index.js";
