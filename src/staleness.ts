// Shared workspace staleness threshold + predicate.
//
// The TUI Workspaces card originally owned the magic number (red bucket
// at ≥10 commits behind main). Dispatch-time warnings need the same
// definition without importing ink/react code, so the threshold lives here.

export const WORKSPACE_STALE_THRESHOLD = 10;

export function isWorkspaceStale(behind: number | null | undefined): boolean {
  return behind !== null && behind !== undefined && behind >= WORKSPACE_STALE_THRESHOLD;
}
