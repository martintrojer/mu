// mu — workspace orphan directory detection.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type Db, defaultStateDir, tryResolveWorkstreamId } from "../db.js";
import { workspacesRoot } from "./core.js";
import { listWorkspaces } from "./crud.js";

export interface WorkspaceOrphan {
  /** The on-disk dir name (the agent name it WOULD be for, if mu had
   *  registered it). */
  agentName: string;
  /** Workstream the dir is filed under. */
  workstreamName: string;
  /** Absolute path to the orphan dir. */
  path: string;
}

/**
 * Like WorkspaceOrphan but additionally flags whether the parent
 * workstream itself is gone (no row in `workstreams`). Returned by
 * listAllOrphanWorkspaces; the per-workstream listWorkspaceOrphans
 * doesn't carry this since by construction it only runs against an
 * existing workstream.
 */
export interface StrandedWorkspaceOrphan extends WorkspaceOrphan {
  /** True iff the parent workstream has no DB row (the dir was left
   *  behind by a `mu workstream destroy` or a manual DELETE). */
  stranded: boolean;
}

/**
 * Scan `<state-dir>/workspaces/<workstream>/` for directories that
 * have no row in `vcs_workspaces`.
 *
 * Returns `[]` when the workstream's workspaces dir doesn't exist,
 * or when every dir on disk has a corresponding DB row. Filesystem
 * read is best-effort: a missing/inaccessible dir returns `[]`.
 */
export function listWorkspaceOrphans(db: Db, workstream: string): WorkspaceOrphan[] {
  const root = workspacesRoot(workstream);
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const registered = new Set(listWorkspaces(db, workstream).map((w) => w.path));
  const orphans: WorkspaceOrphan[] = [];
  for (const agentDir of dirs) {
    const fullPath = join(root, agentDir);
    if (!registered.has(fullPath)) {
      orphans.push({ agentName: agentDir, workstreamName: workstream, path: fullPath });
    }
  }
  return orphans;
}

/**
 * Cross-workstream variant of listWorkspaceOrphans. Reads
 * `<state-dir>/workspaces/`, recurses one level (per-ws subdir →
 * per-agent subdir), and surfaces every dir with no row in
 * `vcs_workspaces`.
 */
export function listAllOrphanWorkspaces(db: Db): StrandedWorkspaceOrphan[] {
  const root = join(defaultStateDir(), "workspaces");
  let wsDirs: string[];
  try {
    wsDirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const registered = new Set(listWorkspaces(db).map((w) => w.path));
  const orphans: StrandedWorkspaceOrphan[] = [];
  for (const wsName of wsDirs) {
    const wsRoot = join(root, wsName);
    let agentDirs: string[];
    try {
      agentDirs = readdirSync(wsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    const stranded = tryResolveWorkstreamId(db, wsName) === null;
    for (const agentDir of agentDirs) {
      const fullPath = join(wsRoot, agentDir);
      if (!registered.has(fullPath)) {
        orphans.push({
          agentName: agentDir,
          workstreamName: wsName,
          path: fullPath,
          stranded,
        });
      }
    }
  }
  return orphans;
}
