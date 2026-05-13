// mu — workspace SDK hub.
//
// Per-agent VCS workspace implementation lives in the cohesive
// src/workspace/ cluster. This root file preserves the public
// `import { ... } from "./workspace.js"` surface.

export { WORKSPACE_STALE_THRESHOLD, isWorkspaceStale } from "./staleness.js";
export {
  HomeDirAsProjectRootError,
  type RawWorkspaceRow,
  SELECT_WS_COLS,
  WS_FROM_JOIN,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
  type WorkspaceRow,
  type WorkspaceStaleness,
  rowFromDb,
  workspacePath,
  workspacesRoot,
} from "./workspace/core.js";
export {
  type CreateWorkspaceOptions,
  type FreeWorkspaceOptions,
  type FreeWorkspaceResult,
  type ListCommitsOptions,
  type ListCommitsResult,
  type RefreshWorkspaceOptions,
  type RefreshWorkspaceResult,
  createWorkspace,
  freeWorkspace,
  getWorkspaceForAgent,
  isWorkspaceClean,
  listCommitsForWorkspace,
  listWorkspaces,
  refreshWorkspace,
} from "./workspace/crud.js";
export {
  decorateWithDirty,
  decorateWithStaleness,
  getWorkspaceStaleness,
} from "./workspace/decorate.js";
export {
  type StrandedWorkspaceOrphan,
  type WorkspaceOrphan,
  listAllOrphanWorkspaces,
  listWorkspaceOrphans,
} from "./workspace/orphans.js";
export {
  type RecreateWorkspaceOptions,
  type RecreateWorkspaceResult,
  recreateWorkspace,
} from "./workspace/recreate.js";
