// mu — workspace verbs: per-agent isolated working copies on top of
// the VcsBackend abstraction (src/vcs.ts).
//
// The schema (vcs_workspaces) plus this module give us:
//
//   - createWorkspace(db, opts) → makes a fresh on-disk workspace via
//     the appropriate backend, records the row
//   - listWorkspaces(db, ws?) → registry rows (optionally filtered)
//   - freeWorkspace(db, agent, opts) → tears down the on-disk dir AND
//     removes the row (atomic-ish: dir teardown first, then DELETE)
//   - getWorkspaceForAgent(db, agent) → spawn integration uses this to
//     resolve a managed agent's cwd
//
// On-disk layout: <state-dir>/workspaces/<workstream>/<agent>/. Each
// workspace lives under the same state dir as the DB so a single
// `rm -rf ~/.local/state/mu` cleans everything.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { defaultStateDir } from "./db.js";
import { emitEvent } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { type VcsBackendName, backendByName, detectBackend } from "./vcs.js";

export interface WorkspaceRow {
  agent: string;
  workstream: string;
  backend: VcsBackendName;
  path: string;
  parentRef: string | null;
  createdAt: string;
}

interface RawWorkspaceRow {
  agent: string;
  workstream: string;
  backend: string;
  path: string;
  parent_ref: string | null;
  created_at: string;
}

function rowFromDb(row: RawWorkspaceRow): WorkspaceRow {
  return {
    agent: row.agent,
    workstream: row.workstream,
    backend: row.backend as VcsBackendName,
    path: row.path,
    parentRef: row.parent_ref,
    createdAt: row.created_at,
  };
}

export class WorkspaceExistsError extends Error implements HasNextSteps {
  override readonly name = "WorkspaceExistsError";
  constructor(public readonly agent: string) {
    super(`workspace already exists for agent: ${agent}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "Show its on-disk path", command: `mu workspace path ${this.agent}` },
      {
        intent: "Free it (optionally --commit pending changes first)",
        command: `mu workspace free ${this.agent}  (--commit to commit pending changes first)`,
      },
      {
        intent: "Then re-create with a different backend or base ref",
        command: `mu workspace create ${this.agent} --backend <jj|sl|git|none> --from <ref>`,
      },
    ];
  }
}

export class WorkspaceNotFoundError extends Error implements HasNextSteps {
  override readonly name = "WorkspaceNotFoundError";
  constructor(public readonly agent: string) {
    super(`no workspace for agent: ${agent}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      { intent: "List workspaces in current workstream", command: "mu workspace list" },
      { intent: "List workspaces across all workstreams", command: "mu workspace list --all" },
      {
        intent: "Create one for this agent",
        command: `mu workspace create ${this.agent}`,
      },
    ];
  }
}

/**
 * Thrown by createWorkspace when the on-disk path it would create is
 * already occupied. Distinct from WorkspaceExistsError (which is about
 * the DB row) so the recovery is clear: the dir is orphaned (no DB
 * row points at it) and needs cleanup.
 *
 * Surfaced as a real bug from the multi-agent dogfood (mufeedback note
 * #143): users hit a bare 'vcs git: workspacePath already exists' from
 * the backend, with no nextSteps. After the cccba88 fix (close-refuses-
 * with-workspace), this case only fires when an orphan from a previous
 * mu version persists OR when the dir was manually rm-rf'd while a
 * stale registration remains (the git-worktree case).
 *
 * Maps to exit code 4 (conflict).
 */
export class WorkspacePathNotEmptyError extends Error implements HasNextSteps {
  override readonly name = "WorkspacePathNotEmptyError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly workspacePath: string,
  ) {
    super(
      `workspace dir already on disk for agent ${agent} (${workspacePath}); refusing to overwrite`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "If the dir is intentional (orphan from older mu), free it via mu first",
        command: `mu workspace free ${this.agent} -w ${this.workstream}  # also runs backend cleanup if a row remains`,
      },
      {
        intent: "Or delete it manually if the registry has no row",
        command: `rm -rf ${this.workspacePath}`,
      },
      {
        intent: "For git workspaces specifically: also prune the worktree registration",
        command: "cd <project-root> && git worktree prune",
      },
    ];
  }
}

/**
 * Compose the canonical on-disk path for an agent's workspace. Used by
 * createWorkspace and reachable from `mu workspace path` so the user
 * can `cd $(mu workspace path foo)` even before the directory exists.
 */
export function workspacePath(workstream: string, agent: string): string {
  return join(defaultStateDir(), "workspaces", workstream, agent);
}

export interface CreateWorkspaceOptions {
  agent: string;
  workstream: string;
  /** Project root to branch from. Defaults to the current working
   *  directory (the `mu` invocation site, which is normally what the
   *  user wants). */
  projectRoot?: string;
  /** Override backend detection. Default: walk `detectBackend`. */
  backend?: VcsBackendName;
  /** Optional ref to base the workspace on. Backend-specific. */
  parentRef?: string;
}

/**
 * Create a fresh workspace for an agent. Allocates the on-disk
 * directory, records the row, emits a system event. Idempotent ONLY
 * to the extent that the row check is up-front; if the row exists
 * we throw `WorkspaceExistsError` rather than silently re-using a
 * possibly-stale on-disk state. Callers should `freeWorkspace` first.
 */
export async function createWorkspace(db: Db, opts: CreateWorkspaceOptions): Promise<WorkspaceRow> {
  if (getWorkspaceForAgent(db, opts.agent) !== undefined) {
    throw new WorkspaceExistsError(opts.agent);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();
  const backend = opts.backend ? backendByName(opts.backend) : await detectBackend(projectRoot);
  const path = workspacePath(opts.workstream, opts.agent);

  // Surface the dir-already-exists case as a typed error WITH actionable
  // nextSteps before we delegate to the backend (which throws a bare
  // Error). This is the orphan-from-older-mu case: a workspace dir from
  // before the cccba88 close-refuses fix landed; it has no DB row.
  if (existsSync(path)) {
    throw new WorkspacePathNotEmptyError(opts.agent, opts.workstream, path);
  }

  const createOpts: { projectRoot: string; workspacePath: string; parentRef?: string } = {
    projectRoot,
    workspacePath: path,
  };
  if (opts.parentRef !== undefined) createOpts.parentRef = opts.parentRef;

  const created = await backend.createWorkspace(createOpts);

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO vcs_workspaces (agent, workstream, backend, path, parent_ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.agent, opts.workstream, backend.name, path, created.parentRef, now);

  emitEvent(
    db,
    opts.workstream,
    `workspace create ${opts.agent} (backend=${backend.name}, path=${path}${created.parentRef ? `, parent=${created.parentRef.slice(0, 12)}` : ""})`,
  );

  return {
    agent: opts.agent,
    workstream: opts.workstream,
    backend: backend.name,
    path,
    parentRef: created.parentRef,
    createdAt: now,
  };
}

export function getWorkspaceForAgent(db: Db, agent: string): WorkspaceRow | undefined {
  const row = db.prepare("SELECT * FROM vcs_workspaces WHERE agent = ?").get(agent) as
    | RawWorkspaceRow
    | undefined;
  return row ? rowFromDb(row) : undefined;
}

export function listWorkspaces(db: Db, workstream?: string): WorkspaceRow[] {
  const rows =
    workstream === undefined
      ? (db
          .prepare("SELECT * FROM vcs_workspaces ORDER BY workstream, agent")
          .all() as RawWorkspaceRow[])
      : (db
          .prepare("SELECT * FROM vcs_workspaces WHERE workstream = ? ORDER BY agent")
          .all(workstream) as RawWorkspaceRow[]);
  return rows.map(rowFromDb);
}

export interface FreeWorkspaceOptions {
  /** If true, attempt to commit pending changes before tearing down.
   *  Backend-specific; see VcsBackend.freeWorkspace. */
  commit?: boolean;
}

export interface FreeWorkspaceResult {
  /** The committed ref, when `commit` was true and there was something
   *  to commit. */
  committedRef?: string;
  /** True iff the on-disk path was actually removed. */
  removed: boolean;
  /** True iff the DB row was actually deleted. */
  rowDeleted: boolean;
}

/**
 * Tear down an agent's workspace. Calls the backend to remove the
 * on-disk directory (with optional auto-commit), then DELETEs the row.
 * Idempotent on a missing workspace (returns all-false).
 */
export async function freeWorkspace(
  db: Db,
  agent: string,
  opts: FreeWorkspaceOptions = {},
): Promise<FreeWorkspaceResult> {
  const row = getWorkspaceForAgent(db, agent);
  if (!row) return { removed: false, rowDeleted: false };

  const backend = backendByName(row.backend);
  const result = await backend.freeWorkspace({
    workspacePath: row.path,
    commit: opts.commit ?? false,
  });

  const del = db.prepare("DELETE FROM vcs_workspaces WHERE agent = ?").run(agent);
  emitEvent(
    db,
    row.workstream,
    `workspace free ${agent} (backend=${row.backend}, path=${row.path}${result.committedRef ? `, committed=${result.committedRef.slice(0, 12)}` : ""})`,
  );

  return {
    removed: result.removed,
    rowDeleted: del.changes > 0,
    ...(result.committedRef !== undefined ? { committedRef: result.committedRef } : {}),
  };
}
