// Pure helper for choosing the initial active workstream tab when the
// TUI launches from either bare `mu` or `mu state --tui`.
//
// Precedence is intentionally shared across both entry paths:
//   1. $MU_SESSION if it names one of the resolved workstreams
//   2. current tmux session name (`mu-<workstream>` prefix stripped)
//   3. current cwd inside a registered vcs_workspaces.path
//   4. current cwd equals a VCS-derived project root for registered workspaces,
//      with ties broken by most-recent workstream activity
//   5. tab 0
//
// No ink/react imports here: this file sits outside src/cli/tui/ so the
// static CLI graph stays free of the TUI bundle.

import { realpathSync } from "node:fs";
import path from "node:path";

import type { Db } from "../db.js";
import { workspaceProjectRoot } from "../project-root.js";
import { listWorkspaces } from "../workspace.js";
import { resolveTmuxSessionWorkstreamName } from "../workstream.js";

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

function latestActiveWorkstream(db: Db, candidates: readonly string[]): string | null {
  if (candidates.length === 0) return null;
  const placeholders = candidates.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT ws.name AS workstreamName
         FROM agent_logs l
         JOIN workstreams ws ON ws.id = l.workstream_id
        WHERE ws.name IN (${placeholders})
        ORDER BY l.created_at DESC, l.seq DESC
        LIMIT 1`,
    )
    .get(...candidates) as { workstreamName: string } | undefined;
  return row?.workstreamName ?? null;
}

export async function resolveInitialTab(names: readonly string[], db: Db): Promise<number> {
  const envWs = process.env.MU_SESSION;
  const envIndex = envWs === undefined ? -1 : names.indexOf(envWs);
  if (envIndex >= 0) return envIndex;

  if (names.length <= 1) return 0;

  const tmuxWs = await resolveTmuxSessionWorkstreamName();
  const tmuxIndex = tmuxWs === null ? -1 : names.indexOf(tmuxWs);
  if (tmuxIndex >= 0) return tmuxIndex;

  const cwd = normalizeExistingPath(process.cwd());
  const workspaces = listWorkspaces(db);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name === undefined) continue;
    for (const row of workspaces) {
      if (row.workstreamName === name && isInsidePath(cwd, row.path)) return i;
    }
  }

  const rootCache = new Map<string, Promise<string | null>>();
  const rootFor = (workspacePath: string, backend: (typeof workspaces)[number]["backend"]) => {
    const key = `${backend}\x00${workspacePath}`;
    const cached = rootCache.get(key);
    if (cached !== undefined) return cached;
    const promise = workspaceProjectRoot(workspacePath, backend);
    rootCache.set(key, promise);
    return promise;
  };

  const candidates: string[] = [];
  for (const row of workspaces) {
    if (!names.includes(row.workstreamName)) continue;
    const projectRoot = await rootFor(row.path, row.backend);
    if (projectRoot !== null && cwd === normalizeExistingPath(projectRoot)) {
      candidates.push(row.workstreamName);
    }
  }

  const uniqueCandidates = Array.from(new Set(candidates));
  if (uniqueCandidates.length === 1) {
    const index = names.indexOf(uniqueCandidates[0] as string);
    if (index >= 0) return index;
  }

  const latest = latestActiveWorkstream(db, uniqueCandidates);
  const latestIndex = latest === null ? -1 : names.indexOf(latest);
  if (latestIndex >= 0) return latestIndex;

  return 0;
}
