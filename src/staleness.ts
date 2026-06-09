// Shared workspace staleness threshold + predicate.
//
// The TUI Workspaces card originally owned the magic number (red bucket
// at ≥10 commits behind main). Dispatch-time warnings need the same
// definition without importing ink/react code, so the threshold lives here.

export const WORKSPACE_STALE_THRESHOLD = 10;

export function isWorkspaceStale(behind: number | null | undefined): boolean {
  return behind !== null && behind !== undefined && behind >= WORKSPACE_STALE_THRESHOLD;
}

/**
 * Pure predicate: has a scratch agent been idle (no status change) for
 * at least `thresholdMs`? Scratch is special-cased because its agents
 * are task-less by design — the regular `idle` flag (src/agents.ts
 * `computeAgentIdle`) requires owning an IN_PROGRESS task and so never
 * fires for off-the-cuff helpers. Without this nudge, easy spawning
 * into `scratch` would silently accumulate forgotten panes. We use the
 * same `MU_IDLE_THRESHOLD_MS` budget the rest of mu uses for "no recent
 * progress" so the two notions of idle agree.
 *
 * `updatedAt` is the agent row's ISO timestamp. Returns false on an
 * unparsable timestamp or a non-positive threshold (mirrors
 * `computeAgentIdle`'s defensive posture — env typos shouldn't crash
 * `mu state`).
 */
export function isLingeringScratchAgent(
  updatedAt: string,
  thresholdMs: number,
  now: number = Date.now(),
): boolean {
  if (thresholdMs <= 0) return false;
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return false;
  return now - updated >= thresholdMs;
}
