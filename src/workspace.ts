// mu — workspace SDK hub.
//
// Per-agent VCS workspace implementation lives in the cohesive
// src/workspace/ cluster. This root file preserves the public
// `import { ... } from "./workspace.js"` surface.

export { isWorkspaceStale, WORKSPACE_STALE_THRESHOLD } from "./staleness.js";
export {
  HomeDirAsProjectRootError,
  type RawWorkspaceRow,
  rowFromDb,
  SELECT_WS_COLS,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
  type WorkspaceRow,
  type WorkspaceStaleness,
  WS_FROM_JOIN,
  workspacePath,
  workspacesRoot,
} from "./workspace/core.js";
export {
  type CreateWorkspaceOptions,
  createWorkspace,
  type FreeWorkspaceOptions,
  type FreeWorkspaceResult,
  freeWorkspace,
  getWorkspaceForAgent,
  isWorkspaceClean,
  type ListCommitsOptions,
  type ListCommitsResult,
  listCommitsForWorkspace,
  listWorkspaces,
  type RefreshWorkspaceOptions,
  type RefreshWorkspaceResult,
  refreshWorkspace,
} from "./workspace/crud.js";
export {
  decorateWithDirty,
  decorateWithStaleness,
  getWorkspaceStaleness,
} from "./workspace/decorate.js";
export {
  listAllOrphanWorkspaces,
  listWorkspaceOrphans,
  type StrandedWorkspaceOrphan,
  type WorkspaceOrphan,
} from "./workspace/orphans.js";
