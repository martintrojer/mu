// Pure helper for choosing the initial active workstream tab when the
// TUI launches from either bare `mu` or `mu state --tui`.
//
// Precedence is intentionally shared across both entry paths:
//   1. $MU_SESSION if it names one of the resolved workstreams
//   2. current cwd inside a registered vcs_workspaces.path
//   3. tab 0
//
// No ink/react imports here: this file sits outside src/cli/tui/ so the
// static CLI graph stays free of the TUI bundle.

import { realpathSync } from "node:fs";
import path from "node:path";

import type { Db } from "../db.js";
import { listWorkspaces } from "../workspace.js";

function normalizeExistingPath(candidatePath: string): string {
  try {
    return realpathSync(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

function isInsidePath(cwd: string, candidatePath: string): boolean {
  const normalizedCandidate = normalizeExistingPath(candidatePath);
  if (cwd === normalizedCandidate) return true;
  return cwd.startsWith(`${normalizedCandidate}${path.sep}`);
}

export function resolveInitialTab(names: readonly string[], db: Db): number {
  const envWs = process.env.MU_SESSION;
  const envIndex = envWs === undefined ? -1 : names.indexOf(envWs);
  if (envIndex >= 0) return envIndex;

  const cwd = normalizeExistingPath(process.cwd());
  const workspaces = listWorkspaces(db);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name === undefined) continue;
    for (const row of workspaces) {
      if (row.workstreamName === name && isInsidePath(cwd, row.path)) return i;
    }
  }

  return 0;
}
