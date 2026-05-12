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
import { AgentNotFoundError } from "./agents/errors.js";
import { type Db, defaultStateDir, tryResolveWorkstreamId } from "./db.js";
import { emitEvent } from "./logs.js";
import type { HasNextSteps, NextStep } from "./output.js";
import { captureSnapshot } from "./snapshots.js";
import { isWorkspaceStale } from "./staleness.js";
import {
  type CommitSummary,
  type RebaseResult,
  type VcsBackend,
  type VcsBackendName,
  WorkspaceDirtyError,
  backendByName,
  detectBackend,
} from "./vcs.js";

export { WORKSPACE_STALE_THRESHOLD, isWorkspaceStale } from "./staleness.js";

export interface WorkspaceRow {
  agentName: string;
  workstreamName: string;
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
  /** True when the workspace has uncommitted / unstaged / untracked-not-
   *  ignored files, as observed by the backend's `listDirtyFiles`.
   *  Undefined when not yet computed (the listWorkspaces fast path leaves
   *  it unset; call decorateWithDirty to populate). Null when the dirty
   *  check could not be performed (backend command failure). For jj /
   *  none backends — which have no operator-visible "dirty" concept —
   *  this is always false (their listDirtyFiles returns []). */
  dirty?: boolean | null;
}

interface RawWorkspaceRow {
  /** Joined from agents.name. */
  agent: string;
  /** Joined from workstreams.name. */
  workstream: string;
  backend: string;
  path: string;
  parent_ref: string | null;
  created_at: string;
}

// SELECT clause that joins vcs_workspaces back to operator-facing
// agent + workstream names (v5 stores surrogate ids; the JS row shape
// is operator-facing TEXT names).
const SELECT_WS_COLS = `
  ag.name AS agent,
  ws.name AS workstream,
  v.backend AS backend,
  v.path AS path,
  v.parent_ref AS parent_ref,
  v.created_at AS created_at
`;

const WS_FROM_JOIN = `FROM vcs_workspaces v
  JOIN agents      ag ON ag.id = v.agent_id
  JOIN workstreams ws ON ws.id = v.workstream_id`;

function rowFromDb(row: RawWorkspaceRow): WorkspaceRow {
  return {
    agentName: row.agent,
    workstreamName: row.workstream,
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
 *
 * Each entry is additionally tagged with `stranded: boolean`: true
 * when the parent workstream has no row in `workstreams`. Stranded
 * orphans are the failure mode this verb was added for — workstreams
 * destroyed before the close-refuses-with-workspace fix landed (or
 * via `mu sql DELETE FROM workstreams ...`) would leave their entire
 * workspace subtree invisible to `mu workspace orphans -w <ws>`,
 * because the user couldn't know to ask for the right name.
 *
 * Surfaced by workspace_orphans_misses_destroyed_workstreams. Returns
 * `[]` when the workspaces root itself doesn't exist; otherwise scans
 * best-effort and skips any subdir that fails to read.
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
  // One pass over every registered workspace path, regardless of
  // workstream. listWorkspaces(db) joins to workstreams, so any rows
  // for destroyed workstreams (FK CASCADE-deleted) are already gone —
  // their on-disk dirs all fall through as stranded.
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

export interface WorkspaceStaleness {
  agentName: string;
  workstreamName: string;
  commitsBehindMain: number | null;
  isStale: boolean;
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
  // Without this, a failed INSERT leaves a real git worktree (or jj
  // workspace, or 'cp -a' tree) on disk + registered, with no DB row
  // to track it. Surfaced by bug_agent_spawn_workspace_fk_failure: the
  // operator hit 'FOREIGN KEY constraint failed' and was left with a
  // 226M git worktree at workspaces/<ws>/<agent>/ that mu state
  // couldn't see and that blocked subsequent spawns.
  const now = new Date().toISOString();
  try {
    // Resolve agent + workstream to surrogate ids before insert. The
    // agent must already exist (the spawn flow always inserts the
    // agent row first, even on the --workspace pre-stage path that
    // uses the placeholder pane id). We don't auto-create here — a
    // missing row is a programmer bug, not a recoverable condition.
    const wsId = tryResolveWorkstreamId(db, opts.workstream);
    if (wsId === null) {
      throw new Error(
        `createWorkspace: workstream not found: ${opts.workstream} (insertAgent should have ensured this)`,
      );
    }
    const agentRow = db
      .prepare("SELECT id FROM agents WHERE name = ? AND workstream_id = ? LIMIT 1")
      .get(opts.agent, wsId) as { id: number } | undefined;
    // Throw a typed AgentNotFoundError BEFORE the INSERT so the
    // operator sees `no such agent: worker-1 (in workstream X)`
    // instead of a leaked `NOT NULL constraint failed:
    // vcs_workspaces.agent_id` (or, in WAL mode, a FK violation).
    // The CLI's classifyError maps this to exit 3. Surfaced by the
    // parallel-fan-out spawn — see workspace_create_typed_no_agent_error.
    // The catch below reuses the same backend rollback path the
    // SQLite errors used.
    if (!agentRow) {
      throw new AgentNotFoundError(opts.agent, opts.workstream);
    }
    db.prepare(
      `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(agentRow.id, wsId, backend.name, path, created.parentRef, now);
  } catch (err) {
    // Best-effort backend-level cleanup. If the backend's free fails
    // (e.g. git worktree remove --force errors), the on-disk state
    // is still there — but at this point we're already failing the
    // verb; surface the original error and let the user clean up
    // via mu workspace orphans (or git worktree remove --force).
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

export async function getWorkspaceStaleness(
  db: Db,
  agentName: string,
  workstreamName: string,
): Promise<WorkspaceStaleness | null> {
  const row = getWorkspaceForAgent(db, agentName, workstreamName);
  if (row === undefined) return null;
  const [decorated] = await decorateWithStaleness([row]);
  const commitsBehindMain = decorated?.commitsBehindMain ?? null;
  return {
    agentName,
    workstreamName,
    commitsBehindMain,
    isStale: isWorkspaceStale(commitsBehindMain),
  };
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
 * Decorate every row with a `dirty` marker — true when the backend's
 * `listDirtyFiles` reports any uncommitted / unstaged / untracked-not-
 * ignored files; false when clean; null on backend-command failure.
 *
 * Cheap, pure observation: NO automatic snapshot/refresh. Cost is one
 * `git status --porcelain` (or sl equivalent) per row, capped at
 * DECORATE_CONCURRENCY in flight. jj / none backends short-circuit to
 * an empty list (always-snapshotted / no-VCS), so dirty=false there.
 *
 * Surfaced by feat_card_5_workspaces (workstream `tui-impl`): the TUI
 * Workspaces card needs a per-row dirty flag so operators can spot
 * pending edits without a manual `mu workspace list` shellout.
 *
 * Returns a NEW array; does not mutate the input.
 */
export async function decorateWithDirty(rows: readonly WorkspaceRow[]): Promise<WorkspaceRow[]> {
  return mapWithConcurrency(rows, DECORATE_CONCURRENCY, async (r) => {
    let dirty: boolean | null;
    try {
      const backend = backendByName(r.backend);
      const files = await backend.listDirtyFiles(r.path);
      dirty = files.length > 0;
    } catch {
      dirty = null;
    }
    return { ...r, dirty };
  });
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
 *
 * Surfaced by fb_workspace_recycle_verb: dogfood between waves
 * required `close → free → spawn`, which killed the worker's LLM
 * context. `refresh` lets the worker keep its context while the
 * dir gets fresh main.
 *
 * Throws (with typed errors propagated from the backend):
 *   - WorkspaceNotFoundError    — no row for this (agent, workstream)
 *   - WorkspaceVcsRequiredError — backend == none
 *   - WorkspaceDirtyError       — git/sl: uncommitted changes present
 *   - WorkspaceConflictError    — rebase produced conflicts
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
 *
 * Throws (with typed errors propagated from the backend):
 *   - WorkspaceNotFoundError    — no row for this (agent, workstream)
 *   - WorkspaceVcsRequiredError — backend == none
 *   - any backend-level Error   — unknown ref, missing repo, etc.
 *
 * Surfaced by fb_workspace_commits_verb.
 */
export async function listCommitsForWorkspace(
  db: Db,
  agent: string,
  opts: ListCommitsOptions,
): Promise<ListCommitsResult> {
  const row = getWorkspaceForAgent(db, agent, opts.workstream);
  if (!row) throw new WorkspaceNotFoundError(agent);
  const backend = backendByName(row.backend);
  // Dispatch FIRST when the backend can't possibly answer (none),
  // so the operator sees the typed WorkspaceVcsRequiredError with
  // its Next: hints rather than a generic "no recorded parent_ref"
  // string. The backend.commitsSinceBase impl is the source of
  // truth on "is this verb meaningful for this backend?".
  const baseRef = opts.since ?? row.parentRef;
  if (baseRef === null || baseRef.length === 0) {
    if (row.backend === "none") {
      // Force the typed error path — baseRef value doesn't matter
      // since none.commitsSinceBase ignores it.
      await backend.commitsSinceBase(row.path, "");
    }
    // Without a recorded parent_ref AND no --since override there's
    // no defensible answer to "commits since fork". Surface as a
    // standard Error (no typed UX upgrade until a real user hits this
    // — the row's parent_ref is set by every backend that supports
    // commits at all).
    throw new Error(`workspace ${agent} has no recorded parent_ref; pass --since <ref> explicitly`);
  }
  const commits = await backend.commitsSinceBase(row.path, baseRef);
  return { vcs: row.backend, baseRef, commits, workspacePath: row.path };
}

/**
 * "Is this workspace safe to silently free on agent close?" — i.e.
 * does it have ZERO uncommitted changes AND ZERO commits since its
 * fork point. Used by closeAgent to auto-free clean workspaces
 * (allow_mu_agent_close_without_discard) so the user no longer has
 * to type --discard-workspace for a workspace that contains nothing
 * worth preserving.
 *
 * Returns false on any backend failure / unknown state — be
 * conservative: we'd rather refuse a close (forcing the user to
 * decide) than silently free a workspace whose state we couldn't
 * verify. The `none` backend's isClean() returns true unconditionally
 * (no commits to lose; see VcsBackend.isClean docstring); the
 * commitsSinceBase check is skipped on `none` for the same reason
 * (cp -a snapshots have no fork point).
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
  // none: no notion of "commits since fork"; treat as clean iff
  // isClean returned true (which for none is unconditionally true).
  if (row.backend === "none") return true;
  // No recorded parent_ref means we can't safely answer "any commits
  // since fork?" — refuse rather than guess.
  if (row.parentRef === null || row.parentRef.length === 0) return false;
  try {
    const commits = await backend.commitsSinceBase(row.path, row.parentRef);
    return commits.length === 0;
  } catch {
    return false;
  }
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
 * Free + create in one atomic-ish verb. The whole point: between
 * waves the operator wants the SAME agent name with a fresh workspace
 * pinned to current main; doing `free` then `create` manually was the
 * dogfood-painful pattern (mufeedback note add_mu_workspace_recreate_free_create).
 *
 * Behaviour:
 *   - Refuses with WorkspaceDirtyError if the existing workspace has
 *     uncommitted changes (git/sl), UNLESS `force: true` is passed
 *     (lossy escape hatch). jj is always-snapshotted so dirty is never
 *     an issue; `none` has no VCS to consult so it never refuses.
 *   - Reuses the SAME backend the previous workspace had unless
 *     `backend` is explicitly overridden — a between-wave refresh
 *     should not silently swap from git to none because the operator
 *     happened to cd into a non-VCS dir. The override path matches
 *     `mu workspace create --backend ...` semantics.
 *   - Emits ONE `workspace recreate <agent>` event (with both old and
 *     new parent_ref in the payload) instead of separate free + create
 *     events. One pre-mutation snapshot is captured under the same
 *     label so the undo trail shows one step.
 *
 * Throws:
 *   - WorkspaceNotFoundError    — no row for this (agent, workstream).
 *   - AgentNotFoundError        — propagated from createWorkspace's
 *                                 typed agent check (the agent row
 *                                 was deleted between the lookup and
 *                                 the re-INSERT; vanishingly rare).
 *   - WorkspaceDirtyError       — dirty + !force.
 *   - any backend-level Error   — free or create failed.
 *
 * On a free-side failure the row + on-disk dir are best-effort gone;
 * on a create-side failure we surface the create error and the row is
 * already deleted (the operator can re-run `mu workspace create`).
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
