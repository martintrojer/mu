// Shared CLI helper for the two dispatch surfaces that should warn
// before sending work to a stale workspace:
//   - `mu task claim --for <agent>`
//   - `mu agent send <agent>`

import type { Db } from "../db.js";
import { type NextStep, pc } from "../output.js";
import { TaskClaimStaleWorkspaceError } from "../tasks.js";
import {
  WORKSPACE_STALE_THRESHOLD,
  type WorkspaceStaleness,
  getWorkspaceStaleness,
} from "../workspace.js";

export interface StalenessCheckResult {
  staleness: WorkspaceStaleness | null;
  warned: boolean;
  nextStep: NextStep | null;
}

export async function checkWorkspaceStalenessForDispatch(
  db: Db,
  agentName: string,
  workstreamName: string,
  opts: { strict?: boolean; warn?: boolean } = {},
): Promise<StalenessCheckResult> {
  const staleness = await getWorkspaceStaleness(db, agentName, workstreamName);
  if (staleness?.isStale !== true) {
    return { staleness, warned: false, nextStep: null };
  }

  const nextStep: NextStep = {
    intent: "Refresh first",
    command: `mu workspace refresh ${agentName} -w ${workstreamName}`,
  };

  if (opts.strict === true) {
    throw new TaskClaimStaleWorkspaceError(staleness);
  }

  if (opts.warn !== false) {
    console.error(formatStaleWorkspaceWarning(staleness));
  }

  return { staleness, warned: true, nextStep };
}

export function formatStaleWorkspaceWarning(staleness: WorkspaceStaleness): string {
  return pc.yellow(
    `WARN: ${staleness.agentName} workspace is ${staleness.commitsBehindMain} commits behind main (≥${WORKSPACE_STALE_THRESHOLD} = stale)`,
  );
}
