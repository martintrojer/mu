// mu — workspace registry CRUD and free/list/commits helpers.

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AgentNotFoundError } from "../agents/errors.js";
import { type Db, tryResolveWorkstreamId } from "../db.js";
import { emitEvent } from "../logs.js";
import { captureSnapshot } from "../snapshots.js";
import {
  type CommitSummary,
  type RebaseResult,
  type VcsBackend,
  type VcsBackendName,
  backendByName,
  detectBackend,
} from "../vcs.js";
import {
  HomeDirAsProjectRootError,
  type RawWorkspaceRow,
  SELECT_WS_COLS,
  WS_FROM_JOIN,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
  type WorkspaceRow,
  rowFromDb,
  workspacePath,
} from "./core.js";

export interface CreateWorkspaceOptions {
  agent: string;
  workstream: string;
  /** Project root to branch from. Defaults to the current working
   *  directory (the `mu` invocation site, which is normally what the
   *  user wants). */
  projectRoot?: string;
  /** Override backend detection. Default: walk `detectBackend`.
   *  Accepts either a name ("jj" / "sl" / "git" / "none") OR a
   *  pre-built `VcsBackend` object — the object form lets tests inject
   *  a fresh fake backend without mutating the exported singletons. */
  backend?: VcsBackendName | VcsBackend;
  /** Optional ref to base the workspace on. Backend-specific. */
  parentRef?: string;
  /** INTERNAL. When false, suppress the `workspace create` system
   *  event. Used by `recreateWorkspace` so the audit trail records
   *  ONE atomic `workspace recreate` line instead of separate
   *  free + create entries. Defaults to true. */
  _suppressEvent?: boolean;
}

/**
 * Create a fresh workspace for an agent. Allocates the on-disk
 * directory, records the row, emits a system event. Idempotent ONLY
 * to the extent that the row check is up-front; if the row exists
 * we throw `WorkspaceExistsError` rather than silently re-using a
 * possibly-stale on-disk state. Callers should `freeWorkspace` first.
 */
export async function createWorkspace(db: Db, opts: CreateWorkspaceOptions): Promise<WorkspaceRow> {
  if (getWorkspaceForAgent(db, opts.agent, opts.workstream) !== undefined) {
    throw new WorkspaceExistsError(opts.agent);
  }

  const projectRoot = opts.projectRoot ?? process.cwd();

  // Footgun guard: refuse projectRoot=$HOME. resolve() normalises a
  // trailing slash, `.`, symlinks-in-name, etc., so `cd && mu workspace
  // create ...` and `--project-root ~/` are all blocked the same way.
  // Direct children of $HOME (e.g. ~/Documents) are NOT blocked —
  // that would be overreach. See snap_dogfood Finding 4.
  if (resolve(projectRoot) === resolve(homedir())) {
    throw new HomeDirAsProjectRootError(opts.agent, opts.workstream, homedir());
  }

  const backend =
    opts.backend === undefined
      ? await detectBackend(projectRoot)
      : typeof opts.backend === "string"
        ? backendByName(opts.backend)
        : opts.backend;
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

  // Wrap the backend's on-disk side effect in a cleanup guard. If the
  // backend throws mid-way (cp -a hits a DRM-protected file, git
  // worktree add fails after creating the dir, an interrupt during a
  // long copy), the partial dir would otherwise be left behind with
  // no DB row — exactly the failure mode from snap_dogfood Finding 4,
  // which then blocked subsequent `mu workspace create` calls with
  // WorkspacePathNotEmptyError. Best-effort: if the rm itself fails,
  // surface the original error and let the user clean up via
  // `mu workspace orphans`.
  let created: Awaited<ReturnType<typeof backend.createWorkspace>>;
  try {
    created = await backend.createWorkspace(createOpts);
  } catch (err) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // best-effort; original error wins
    }
    throw err;
  }

  // Roll back the on-disk + VCS-registry side effect if the DB row
  // insert fails (FK violation, schema constraint, sqlite_busy timeout).
  const now = new Date().toISOString();
  try {
    const wsId = tryResolveWorkstreamId(db, opts.workstream);
    if (wsId === null) {
      throw new Error(
        `createWorkspace: workstream not found: ${opts.workstream} (insertAgent should have ensured this)`,
      );
    }
    const agentRow = db
      .prepare("SELECT id FROM agents WHERE name = ? AND workstream_id = ? LIMIT 1")
      .get(opts.agent, wsId) as { id: number } | undefined;
    if (!agentRow) {
      throw new AgentNotFoundError(opts.agent, opts.workstream);
    }
    db.prepare(
      `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(agentRow.id, wsId, backend.name, path, created.parentRef, now);
  } catch (err) {
    await backend.freeWorkspace({ workspacePath: path, commit: false }).catch(() => {});
    throw err;
  }

  if (opts._suppressEvent !== true) {
    emitEvent(
      db,
      opts.workstream,
      `workspace create ${opts.agent} (backend=${backend.name}, path=${path}${created.parentRef ? `, parent=${created.parentRef.slice(0, 12)}` : ""})`,
    );
  }

  return {
    agentName: opts.agent,
    workstreamName: opts.workstream,
    backend: backend.name,
    path,
    parentRef: created.parentRef,
    createdAt: now,
  };
}

export function getWorkspaceForAgent(
  db: Db,
  agent: string,
  workstream: string,
): WorkspaceRow | undefined {
  // v5: agents.name is per-workstream unique — the lookup must scope
  // by (workstream, agent) so a same-named worker elsewhere can't be
  // resolved instead.
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return undefined;
  const row = db
    .prepare(`SELECT ${SELECT_WS_COLS} ${WS_FROM_JOIN} WHERE ag.name = ? AND v.workstream_id = ?`)
    .get(agent, wsId) as RawWorkspaceRow | undefined;
  return row ? rowFromDb(row) : undefined;
}

export function listWorkspaces(db: Db, workstream?: string): WorkspaceRow[] {
  if (workstream === undefined) {
    const rows = db
      .prepare(`SELECT ${SELECT_WS_COLS} ${WS_FROM_JOIN} ORDER BY ws.name, ag.name`)
      .all() as RawWorkspaceRow[];
    return rows.map(rowFromDb);
  }
  const wsId = tryResolveWorkstreamId(db, workstream);
  if (wsId === null) return [];
  const rows = db
    .prepare(`SELECT ${SELECT_WS_COLS} ${WS_FROM_JOIN} WHERE v.workstream_id = ? ORDER BY ag.name`)
    .all(wsId) as RawWorkspaceRow[];
  return rows.map(rowFromDb);
}

export interface FreeWorkspaceOptions {
  /** If true, attempt to commit pending changes before tearing down.
   *  Backend-specific; see VcsBackend.freeWorkspace. */
  commit?: boolean;
  /** INTERNAL. When false, suppress the `workspace free` system
   *  event AND skip the pre-mutation snapshot capture. Used by
   *  `recreateWorkspace` so the audit trail records ONE atomic
   *  `workspace recreate` line and one snapshot for the whole
   *  free+create cycle. Defaults to true. */
  _suppressEvent?: boolean;
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
  opts: FreeWorkspaceOptions & { workstream: string },
): Promise<FreeWorkspaceResult> {
  const row = getWorkspaceForAgent(db, agent, opts.workstream);
  if (!row) return { removed: false, rowDeleted: false };

  // Pre-mutation snapshot — the row deletion + on-disk teardown is
  // not recoverable from history. Snapshot is DB-only (the worktree
  // is not rolled back; that's the design's tmux/disk honesty point).
  // recreateWorkspace owns its own snapshot label so the undo trail
  // shows one `workspace recreate` step, not free + create.
  if (opts._suppressEvent !== true) {
    captureSnapshot(db, `workspace free ${agent}`, row.workstreamName);
  }

  const backend = backendByName(row.backend);
  const result = await backend.freeWorkspace({
    workspacePath: row.path,
    commit: opts.commit ?? false,
  });

  // Resolve to surrogate ids scoped by the row's workstream.
  const wsIdForDel = tryResolveWorkstreamId(db, row.workstreamName);
  const del =
    wsIdForDel === null
      ? { changes: 0 }
      : db
          .prepare(
            `DELETE FROM vcs_workspaces
             WHERE agent_id = (SELECT id FROM agents WHERE name = ? AND workstream_id = ?)
               AND workstream_id = ?`,
          )
          .run(agent, wsIdForDel, wsIdForDel);
  if (opts._suppressEvent !== true) {
    emitEvent(
      db,
      row.workstreamName,
      `workspace free ${agent} (backend=${row.backend}, path=${row.path}${result.committedRef ? `, committed=${result.committedRef.slice(0, 12)}` : ""})`,
    );
  }

  return {
    removed: result.removed,
    rowDeleted: del.changes > 0,
    ...(result.committedRef !== undefined ? { committedRef: result.committedRef } : {}),
  };
}

export interface RefreshWorkspaceOptions {
  agent: string;
  workstream: string;
  /** Optional override of the rebase target. When undefined, the
   *  backend resolves its own default (origin/HEAD for git,
   *  `trunk()` for jj/sl). */
  fromRef?: string;
}

export interface RefreshWorkspaceResult extends RebaseResult {
  /** Backend name (mirrors the row) so a JSON consumer doesn't have
   *  to look up the workspace separately to know what kind of rebase
   *  it just got. */
  vcs: VcsBackendName;
  /** The workspace's on-disk path (so the JSON shape is self-contained
   *  for piping to a downstream `jq` script). */
  workspacePath: string;
}

/**
 * Refresh an agent's workspace by rebasing it onto `fromRef` (or the
 * backend's default base). The agent / pane are NOT touched — only
 * the on-disk working copy moves. Bumps the row's `created_at` proxy
 * via the emit event; the row itself is otherwise unchanged.
 */
export async function refreshWorkspace(
  db: Db,
  opts: RefreshWorkspaceOptions,
): Promise<RefreshWorkspaceResult> {
  const row = getWorkspaceForAgent(db, opts.agent, opts.workstream);
  if (!row) throw new WorkspaceNotFoundError(opts.agent);
  const backend = backendByName(row.backend);
  const result = await backend.rebaseTo(row.path, opts.fromRef);
  emitEvent(
    db,
    row.workstreamName,
    `workspace refresh ${opts.agent} (backend=${row.backend}, fromRef=${result.fromRef}, replayed=${result.replayed.length})`,
  );
  return { ...result, vcs: row.backend, workspacePath: row.path };
}

export interface ListCommitsOptions {
  workstream: string;
  /** Optional override of the base ref (default: the workspace row's
   *  parent_ref). Useful when the operator wants to ask "what's on
   *  top of an arbitrary ref" without re-creating the workspace. */
  since?: string;
}

export interface ListCommitsResult {
  /** Backend name (mirrors the row). */
  vcs: VcsBackendName;
  /** The base ref actually used. */
  baseRef: string;
  /** The commits, oldest-first. Empty when the workspace is exactly
   *  at baseRef. */
  commits: CommitSummary[];
  /** The workspace's on-disk path (so JSON consumers don't have to
   *  call `mu workspace path` separately). */
  workspacePath: string;
}

/**
 * List commits the workspace has on top of its `parent_ref` (or the
 * `--since` override), oldest-first. Promotes the dogfood-painful
 *     cd $(mu workspace path X) && git log <base>..HEAD
 * incantation into a typed verb that knows the workspace's
 * recorded fork point.
 */
export async function listCommitsForWorkspace(
  db: Db,
  agent: string,
  opts: ListCommitsOptions,
): Promise<ListCommitsResult> {
  const row = getWorkspaceForAgent(db, agent, opts.workstream);
  if (!row) throw new WorkspaceNotFoundError(agent);
  const backend = backendByName(row.backend);
  const baseRef = opts.since ?? row.parentRef;
  if (baseRef === null || baseRef.length === 0) {
    if (row.backend === "none") {
      await backend.commitsSinceBase(row.path, "");
    }
    throw new Error(`workspace ${agent} has no recorded parent_ref; pass --since <ref> explicitly`);
  }
  const commits = await backend.commitsSinceBase(row.path, baseRef);
  return { vcs: row.backend, baseRef, commits, workspacePath: row.path };
}

/**
 * "Is this workspace safe to silently free on agent close?" — i.e.
 * does it have ZERO uncommitted changes AND ZERO commits since its
 * fork point. Used by closeAgent to auto-free clean workspaces.
 */
export async function isWorkspaceClean(row: WorkspaceRow): Promise<boolean> {
  const backend = backendByName(row.backend);
  let clean: boolean;
  try {
    clean = await backend.isClean(row.path);
  } catch {
    return false;
  }
  if (!clean) return false;
  if (row.backend === "none") return true;
  if (row.parentRef === null || row.parentRef.length === 0) return false;
  try {
    const commits = await backend.commitsSinceBase(row.path, row.parentRef);
    return commits.length === 0;
  } catch {
    return false;
  }
}
