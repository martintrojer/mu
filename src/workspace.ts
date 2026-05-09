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

import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Db } from "./db.js";
import { defaultStateDir } from "./db.js";
import { emitEvent } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { captureSnapshot } from "./snapshots.js";
import { type VcsBackend, type VcsBackendName, backendByName, detectBackend } from "./vcs.js";

export interface WorkspaceRow {
  agent: string;
  workstream: string;
  backend: VcsBackendName;
  path: string;
  parentRef: string | null;
  createdAt: string;
  /** How many commits the workspace's parent_ref is behind the project's
   *  default branch HEAD, as of the last time the workspace's local refs
   *  cache was updated. Undefined when not yet computed (the listWorkspaces
   *  fast path leaves it unset; call decorateWithStaleness to populate).
   *  Null when staleness was queried but cannot be computed (no main found,
   *  none-backend, missing parent_ref, command failure). */
  commitsBehindMain?: number | null;
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
        intent: "List every orphan workspace dir in this workstream",
        command: `mu workspace orphans -w ${this.workstream}`,
      },
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
 * Thrown by createWorkspace when the resolved projectRoot is the
 * user's $HOME. Surfaced by snap_dogfood Finding 4: a `mu workspace
 * create` invoked from cwd=$HOME with no --project-root began a
 * recursive `cp -a` of $HOME (~/Music, ~/.config, ...) into the
 * workspace dir, stalled on DRM-protected files, and on ctrl-C left
 * a partial dir behind with no DB row.
 *
 * The guard's whole point is to make the user pick a real project
 * deliberately — there's no --force escape hatch on purpose. The
 * resolution is `--project-root <real-path>` (or `cd` into a real
 * project first).
 *
 * Maps to exit code 4 (conflict).
 */
export class HomeDirAsProjectRootError extends Error implements HasNextSteps {
  override readonly name = "HomeDirAsProjectRootError";
  constructor(
    public readonly agent: string,
    public readonly workstream: string,
    public readonly homeDir: string,
  ) {
    super(
      `refusing to create workspace with projectRoot=$HOME (${homeDir}); a recursive copy/clone of your home directory is almost never what you want`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Re-run from inside a real project directory",
        command: `cd <your-project> && mu workspace create ${this.agent} -w ${this.workstream}`,
      },
      {
        intent: "Or pass --project-root explicitly",
        command: `mu workspace create ${this.agent} -w ${this.workstream} --project-root <your-project>`,
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

/** Root dir for a workstream's workspaces — the parent of all
 *  per-agent workspace dirs. Used by listWorkspaceOrphans to scan
 *  the filesystem. */
export function workspacesRoot(workstream: string): string {
  return join(defaultStateDir(), "workspaces", workstream);
}

export interface WorkspaceOrphan {
  /** The on-disk dir name (the agent name it WOULD be for, if mu had
   *  registered it). */
  agent: string;
  /** Workstream the dir is filed under. */
  workstream: string;
  /** Absolute path to the orphan dir. */
  path: string;
}

/**
 * Scan `<state-dir>/workspaces/<workstream>/` for directories that
 * have no row in `vcs_workspaces`. These are the result of:
 *   - pre-cccba88 agents closed without --discard-workspace
 *   - failed spawn rollbacks (pre-bug_agent_spawn_workspace_fk_failure fix)
 *   - manual cleanup that left the dir but not the row
 *   - any case where the operator manually rm-rf'd vcs_workspaces rows
 *
 * Returns `[]` when the workstream's workspaces dir doesn't exist,
 * or when every dir on disk has a corresponding DB row. Filesystem
 * read is best-effort: a missing/inaccessible dir returns `[]`
 * (caller doesn't have to check existsSync first).
 *
 * Surfaced by bug_workspace_orphan_not_in_state: orphan dirs were
 * invisible to `mu state` and `mu workspace list`, but blocked
 * subsequent `--workspace` spawns with WorkspacePathNotEmptyError.
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
      orphans.push({ agent: agentDir, workstream, path: fullPath });
    }
  }
  return orphans;
}

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
  // Without this, a failed INSERT leaves a real git worktree (or jj
  // workspace, or 'cp -a' tree) on disk + registered, with no DB row
  // to track it. Surfaced by bug_agent_spawn_workspace_fk_failure: the
  // operator hit 'FOREIGN KEY constraint failed' and was left with a
  // 226M git worktree at workspaces/<ws>/<agent>/ that mu state
  // couldn't see and that blocked subsequent spawns.
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO vcs_workspaces (agent, workstream, backend, path, parent_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(opts.agent, opts.workstream, backend.name, path, created.parentRef, now);
  } catch (err) {
    // Best-effort backend-level cleanup. If the backend's free fails
    // (e.g. git worktree remove --force errors), the on-disk state
    // is still there — but at this point we're already failing the
    // verb; surface the original error and let the user clean up
    // via mu workspace orphans (or git worktree remove --force).
    await backend.freeWorkspace({ workspacePath: path, commit: false }).catch(() => {});
    throw err;
  }

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

/**
 * Decorate each row with `commitsBehindMain` by asking the row's backend
 * how far the parent_ref is behind the project's default branch HEAD.
 * Cheap, pure observation: NO automatic `git fetch` / `jj git fetch` /
 * `sl pull`. The number is as fresh as the workspace's local refs cache.
 *
 * Surfaced by bug_workspace_stale_parent_silent_drift: long-lived
 * workspaces silently drift from main, and there was no signal to the
 * operator. `mu workspace list` and `mu state` show the result.
 *
 * Returns a NEW array; does not mutate the input. Rows whose parent_ref
 * is missing, or whose backend's commitsBehind throws / returns null,
 * get `commitsBehindMain: null`.
 *
 * Performance hardening (review_code_decorate_with_staleness_n_plus_one):
 *   1. Concurrency-cap (DECORATE_CONCURRENCY = 4) so a workstream with
 *      many workspaces can't fork-burst N parallel git/jj/sl children.
 *      Real-user pain surface is `watch -n 5 mu state -w X` loops.
 *   2. Per-invocation memoization keyed by (backend, parentRef).
 *      Sibling workspaces in a workstream share a project root, and
 *      git worktrees / jj workspaces share their local refs cache by
 *      construction — so commits-behind for the same parent_ref
 *      resolves to the same answer regardless of which workspace dir
 *      we shell out from. Sl clones are independent, but in practice
 *      all sibling clones in a workstream were produced from the same
 *      origin and stay in lockstep on local origin/* refs. The cache
 *      is local to this function call — no cross-invocation TTL, no
 *      invalidation policy.
 */
const DECORATE_CONCURRENCY = 4;

export async function decorateWithStaleness(
  rows: readonly WorkspaceRow[],
): Promise<WorkspaceRow[]> {
  // Per-invocation cache: identical (backend, path, parentRef) tuples
  // resolve to one shellout regardless of how many rows hit them. We key
  // by path AND parentRef because the backend's commitsBehind contract
  // depends on both (different workspaces can share a parentRef but
  // each shells out from its own cwd; sharing only across identical
  // (path, parentRef) tuples is the strictly-correct memo).
  const cache = new Map<string, Promise<number | null>>();
  const fetchBehind = (r: WorkspaceRow): Promise<number | null> => {
    const parentRef = r.parentRef;
    if (parentRef === null) return Promise.resolve(null);
    const key = `${r.backend}\x00${parentRef}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const p = (async (): Promise<number | null> => {
      try {
        const backend = backendByName(r.backend);
        return await backend.commitsBehind(r.path, parentRef);
      } catch {
        return null;
      }
    })();
    cache.set(key, p);
    return p;
  };
  return mapWithConcurrency(rows, DECORATE_CONCURRENCY, async (r) => ({
    ...r,
    commitsBehindMain: await fetchBehind(r),
  }));
}

/**
 * Tiny p-limit-style helper. Keeps at most `limit` callbacks in flight
 * at once and preserves input order in the result. Stays in this file
 * because it has exactly one caller (decorateWithStaleness); promote
 * out only when a second caller appears (anti-feature pledge: no
 * abstractions for hypothetical future flexibility).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await fn(item, i);
    }
  };
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
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

  // Pre-mutation snapshot — the row deletion + on-disk teardown is
  // not recoverable from history. Snapshot is DB-only (the worktree
  // is not rolled back; that's the design's tmux/disk honesty point).
  captureSnapshot(db, `workspace free ${agent}`, row.workstream);

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
