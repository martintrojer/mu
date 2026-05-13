// mu — workspace recreate verb.

import type { Db } from "../db.js";
import { emitEvent } from "../logs.js";
import { captureSnapshot } from "../snapshots.js";
import {
  type VcsBackend,
  type VcsBackendName,
  WorkspaceDirtyError,
  backendByName,
} from "../vcs.js";
import { WorkspaceNotFoundError, type WorkspaceRow } from "./core.js";
import {
  type CreateWorkspaceOptions,
  createWorkspace,
  freeWorkspace,
  getWorkspaceForAgent,
} from "./crud.js";

export interface RecreateWorkspaceOptions {
  /** Same as createWorkspace; defaults to cwd. */
  projectRoot?: string;
  /** Same as createWorkspace; if undefined the previous backend is
   *  reused (auto-detection re-runs only when --backend was passed). */
  backend?: VcsBackendName | VcsBackend;
  /** Same as createWorkspace; if undefined the new workspace bases on
   *  the backend's current head (for git/jj/sl: the project's main),
   *  which is the whole point of the verb. */
  parentRef?: string;
  /** When true, skip the dirty-check refusal and discard any
   *  uncommitted changes in the existing workspace. The lossy escape
   *  hatch — mirrors the implicit semantics of `mu workspace free`
   *  without --commit. */
  force?: boolean;
}

export interface RecreateWorkspaceResult {
  /** The freshly-created workspace row (the previous row is already
   *  gone by the time we return). */
  workspace: WorkspaceRow;
  /** parent_ref of the WORKSPACE BEFORE recreate, so callers (and the
   *  CLI's success message) can show "bumped from <old> -> <new>". */
  previousParentRef: string | null;
}

/**
 * Free + create in one atomic-ish verb. Between waves the operator
 * wants the SAME agent name with a fresh workspace pinned to current
 * main; doing `free` then `create` manually was the dogfood-painful
 * pattern.
 */
export async function recreateWorkspace(
  db: Db,
  agent: string,
  opts: RecreateWorkspaceOptions & { workstream: string },
): Promise<RecreateWorkspaceResult> {
  const row = getWorkspaceForAgent(db, agent, opts.workstream);
  if (!row) throw new WorkspaceNotFoundError(agent);

  // Dirty-check the OLD workspace before we destroy it. Same
  // safety semantics as `free` (without --commit): refuse rather
  // than silently lose uncommitted edits. `--force` is the lossy
  // escape hatch.
  if (opts.force !== true) {
    const oldBackend = backendByName(row.backend);
    const dirty = await oldBackend.listDirtyFiles(row.path);
    if (dirty.length > 0) {
      throw new WorkspaceDirtyError(row.path, dirty, "recreate");
    }
  }

  // One snapshot for the whole free+create cycle; one event line at
  // the end. The internal `_suppressEvent` flag on free/create is
  // private to this module — not part of the SDK contract.
  captureSnapshot(db, `workspace recreate ${agent}`, row.workstreamName);

  await freeWorkspace(db, agent, {
    workstream: opts.workstream,
    commit: false,
    _suppressEvent: true,
  });

  const createOpts: CreateWorkspaceOptions = {
    agent,
    workstream: opts.workstream,
    _suppressEvent: true,
  };
  if (opts.projectRoot !== undefined) createOpts.projectRoot = opts.projectRoot;
  // Default to the prior backend so a between-wave refresh stays on
  // the same VCS regardless of cwd. Explicit override wins.
  if (opts.backend !== undefined) {
    createOpts.backend = opts.backend;
  } else {
    createOpts.backend = row.backend;
  }
  if (opts.parentRef !== undefined) createOpts.parentRef = opts.parentRef;

  const fresh = await createWorkspace(db, createOpts);

  emitEvent(
    db,
    opts.workstream,
    `workspace recreate ${agent} (backend=${fresh.backend}, path=${fresh.path}, old_parent=${row.parentRef ? row.parentRef.slice(0, 12) : "—"}, new_parent=${fresh.parentRef ? fresh.parentRef.slice(0, 12) : "—"})`,
  );

  return { workspace: fresh, previousParentRef: row.parentRef };
}
