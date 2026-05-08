// mu — VCS workspace abstraction.
//
// Tier-A goal from the "make mu fully functional" review: each agent
// gets its own working copy so two agents in the same project don't
// trample each other's edits.
//
// Four backends, deliberately concrete (no generic params, no
// anticipatory abstraction) so the file stays small and a prior
// internal LLM-runtime's `RunContext` cautionary tale doesn't apply:
//
//   jj    — `jj workspace add` (most isolated, native to mu's design)
//   sl    — `sl share / sl up` (sapling-native shared store)
//   git   — `git worktree add`
//   none  — `cp -a` snapshot (heavy fallback for non-VCS dirs)
//
// Detection precedence: jj > sl > git > none. The dispatcher tries
// each backend's `detect()` in that order; first hit owns the dir.
//
// On-disk layout: `<state-dir>/workspaces/<workstream>/<agent>/`.
// State dir defaults to `~/.local/state/mu/` (overridable via
// `$MU_STATE_DIR`, same as the DB).

import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type VcsBackendName = "jj" | "sl" | "git" | "none";

export interface CreateWorkspaceOptions {
  /** The repository being branched from. Absolute path. */
  projectRoot: string;
  /** Where to place the new workspace. Absolute path; must NOT exist. */
  workspacePath: string;
  /** Optional commit / branch / changeset id to base off. Backend-specific:
   *  git uses it as a `git worktree add`'s ref, jj as a revset, sl as a
   *  rev. Undefined = current head. */
  parentRef?: string;
}

export interface CreateWorkspaceResult {
  /** The actual ref the workspace points at (resolved to a stable id
   *  when possible). Stored on the row; useful for `mu workspace list`
   *  and for `--commit` flows. May be null for backends that don't
   *  expose a meaningful parent (e.g. `none`). */
  parentRef: string | null;
}

export interface FreeWorkspaceOptions {
  workspacePath: string;
  /** If true, attempt to commit any pending changes BEFORE removal.
   *  Backend-specific: jj auto-commits via `jj describe + jj new`, git
   *  needs an explicit commit on the worktree, sl needs `sl commit`,
   *  none has nothing to commit. If pending changes exist and `commit`
   *  is false, the on-disk directory still gets removed and changes are
   *  lost \u2014 the verb prints a clear warning. */
  commit: boolean;
}

export interface FreeWorkspaceResult {
  /** The commit id that captured the pending changes, when `commit` was
   *  true and there was something to commit. Otherwise undefined. */
  committedRef?: string;
  /** True iff the on-disk path was actually removed (vs. already gone). */
  removed: boolean;
}

export interface VcsBackend {
  readonly name: VcsBackendName;

  /** True iff this backend should handle `projectRoot`. Implementations
   *  check for the relevant marker dir (`.jj`, `.sl`, `.git`); `none`
   *  always returns true and is consulted last. */
  detect(projectRoot: string): Promise<boolean>;

  createWorkspace(opts: CreateWorkspaceOptions): Promise<CreateWorkspaceResult>;

  freeWorkspace(opts: FreeWorkspaceOptions): Promise<FreeWorkspaceResult>;
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function rmDirSync(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

/**
 * Run a binary with args. Throws a typed Error on non-zero exit. Stdout
 * is returned trimmed; stderr is appended to the Error message.
 */
async function run(bin: string, args: readonly string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await exec(bin, [...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`vcs ${bin} ${args.join(" ")} failed: ${msg}`);
  }
}

// ─── none backend ────────────────────────────────────────────────────
//
// The fallback for projects that aren't under any VCS we recognise.
// `cp -a` is heavy but correct; the workspace is a full snapshot.
// Free deletes the snapshot. No commit semantics (no VCS to commit
// against), so `--commit` is silently ignored.

export const noneBackend: VcsBackend = {
  name: "none",

  async detect(_projectRoot) {
    return true;
  },

  async createWorkspace(opts) {
    if (existsSync(opts.workspacePath)) {
      throw new Error(`vcs none: workspacePath already exists: ${opts.workspacePath}`);
    }
    await ensureParent(opts.workspacePath);
    // `cp -a` is GNU/BSD-portable for "preserve everything, recursive".
    await run("cp", ["-a", `${opts.projectRoot}/.`, opts.workspacePath]);
    return { parentRef: null };
  },

  async freeWorkspace(opts) {
    const removed = rmDirSync(opts.workspacePath);
    return { removed };
  },
};

// ─── git backend ─────────────────────────────────────────────────────
//
// Uses `git worktree` so the new workspace shares the .git store with
// the project root. Cheap (no copy), fast, and integrates with the rest
// of the agent's git workflow (push, log, etc) trivially.

export const gitBackend: VcsBackend = {
  name: "git",

  async detect(projectRoot) {
    return isDir(join(projectRoot, ".git"));
  },

  async createWorkspace(opts) {
    if (existsSync(opts.workspacePath)) {
      throw new Error(`vcs git: workspacePath already exists: ${opts.workspacePath}`);
    }
    await ensureParent(opts.workspacePath);
    // Defensive prune: if a previous workspace at the same path was
    // freed by `rm -rf` (or otherwise lost its dir without proper
    // teardown), git's worktree registry still points at it. Then
    // `git worktree add` fails with 'missing but already registered
    // worktree'. `git worktree prune` is idempotent and cheap; running
    // it BEFORE every add costs ~10ms and immunises us against the
    // mufeedback workspace_free_cleanup_leaves_git case.
    await run("git", ["worktree", "prune"], opts.projectRoot).catch(() => {
      /* prune is best-effort; if it fails we'll get a clear error from `add` next */
    });
    // `git worktree add <path> [<ref>]`. Without a ref, the new worktree
    // checks out a detached HEAD at the project's current HEAD, which
    // matches the "fresh per-agent workspace" semantics we want. Use a
    // detached HEAD by default so two agents from the same parent ref
    // don't collide on a branch name.
    const args = ["worktree", "add", "--detach", opts.workspacePath];
    if (opts.parentRef) args.push(opts.parentRef);
    await run("git", args, opts.projectRoot);
    // Resolve the actual SHA we ended up on for the parentRef record.
    const sha = await run("git", ["rev-parse", "HEAD"], opts.workspacePath);
    return { parentRef: sha };
  },

  async freeWorkspace(opts) {
    // Disk-missing case: a previous caller (or the user) ran `rm -rf`
    // out from under us, but the git worktree registry STILL has an
    // entry pointing here. Without a prune, the next `git worktree
    // add` at this path errors out (the mufeedback case). We can't
    // reach the project root via the workspace itself (the .git
    // pointer file is gone with the dir), but `worktree prune` runs
    // from inside any git repo and reaps every dead worktree. We
    // can't reliably guess WHICH project root, so log it as a hint
    // in the result rather than running prune ourselves; the spawn
    // path's defensive prune (above) will clean it on next use.
    if (!existsSync(opts.workspacePath)) {
      return { removed: false };
    }
    let committedRef: string | undefined;
    if (opts.commit) {
      // Commit only if there's anything to commit. `git diff --quiet`
      // returns 0 when clean, 1 when dirty.
      const dirty = await isGitDirty(opts.workspacePath);
      if (dirty) {
        await run("git", ["add", "-A"], opts.workspacePath);
        await run(
          "git",
          [
            "-c",
            "user.email=mu@local",
            "-c",
            "user.name=mu",
            "commit",
            "-m",
            "mu workspace free auto-commit",
          ],
          opts.workspacePath,
        );
        committedRef = await run("git", ["rev-parse", "HEAD"], opts.workspacePath);
      }
    }
    // Tear down: git worktree remove --force <path> cleans both the
    // on-disk directory AND the git/worktrees/<name>/ admin entry. We
    // can't easily run it from the project root (we don't store it on
    // the workspace row), but git accepts the worktree's own path from
    // anywhere with --force, so we resolve a usable cwd via git's own
    // pointer back to the project's .git dir.
    const projectRoot = await resolveGitProjectRoot(opts.workspacePath);
    if (projectRoot) {
      await run("git", ["worktree", "remove", "--force", opts.workspacePath], projectRoot);
    } else {
      // Lost the link — just rm the directory. git's admin entry will
      // be cleaned by the next `git worktree prune` invocation.
      rmDirSync(opts.workspacePath);
    }
    const result: FreeWorkspaceResult = { removed: true };
    if (committedRef !== undefined) result.committedRef = committedRef;
    return result;
  },
};

async function isGitDirty(workspacePath: string): Promise<boolean> {
  // Three independent checks: working-tree changes, staged changes,
  // untracked-but-not-ignored files. Any of the three → dirty.
  try {
    await exec("git", ["diff", "--quiet"], { cwd: workspacePath });
  } catch {
    return true;
  }
  try {
    await exec("git", ["diff", "--cached", "--quiet"], { cwd: workspacePath });
  } catch {
    return true;
  }
  const { stdout } = await exec("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: workspacePath,
  });
  return stdout.trim().length > 0;
}

/**
 * Resolve the project root that owns this worktree. Returns undefined
 * if the link is broken (e.g. project root deleted). git rev-parse
 * --git-common-dir gives us the parent project's .git dir; the worktree's
 * project root is its parent.
 */
async function resolveGitProjectRoot(workspacePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: workspacePath },
    );
    return resolve(stdout.trim(), "..");
  } catch {
    return undefined;
  }
}

// ─── jj backend ─────────────────────────────────────────────────────────────
//
// `jj workspace add --name <name> <path>` shares the .jj/repo store
// while giving each agent its own working copy. Workspaces are named;
// we use basename(workspacePath) which (per our on-disk layout) is the
// agent name.
//
// Free is two-step: `jj workspace forget <name>` from the workspace
// itself unregisters; then we rm the dir since jj leaves the files
// behind.
//
// --commit semantics for jj: jj's working copy is always automatically
// snapshotted, so "commit" is really "capture the current change_id
// as the result." Nothing is ever lost; jj keeps all operations in
// its op log indefinitely. We additionally call `jj describe` to set
// a description IF the current commit's description is empty so the
// captured ref is human-discoverable.

export const jjBackend: VcsBackend = {
  name: "jj",

  async detect(projectRoot) {
    return isDir(join(projectRoot, ".jj"));
  },

  async createWorkspace(opts) {
    if (existsSync(opts.workspacePath)) {
      throw new Error(`vcs jj: workspacePath already exists: ${opts.workspacePath}`);
    }
    await ensureParent(opts.workspacePath);
    const name = jjWorkspaceName(opts.workspacePath);
    const args = ["workspace", "add", "--name", name];
    if (opts.parentRef) args.push("--revision", opts.parentRef);
    args.push(opts.workspacePath);
    await run("jj", args, opts.projectRoot);
    const commitId = await jjCommitId(opts.workspacePath);
    return { parentRef: commitId };
  },

  async freeWorkspace(opts) {
    if (!existsSync(opts.workspacePath)) {
      return { removed: false };
    }
    const name = jjWorkspaceName(opts.workspacePath);
    let committedRef: string | undefined;
    if (opts.commit) {
      const desc = await run(
        "jj",
        [
          "log",
          "-r",
          "@",
          "--no-graph",
          "--no-pager",
          "--color",
          "never",
          "--template",
          "description",
        ],
        opts.workspacePath,
      );
      if (desc.trim().length === 0) {
        await run("jj", ["describe", "-m", "mu workspace free auto-commit"], opts.workspacePath);
      }
      committedRef = await jjCommitId(opts.workspacePath);
    }
    // `jj workspace forget` works from inside the workspace itself.
    // jj prints a hint about the working copy becoming orphaned;
    // we resolve that immediately by rm-ing the dir.
    await run("jj", ["workspace", "forget", name], opts.workspacePath);
    rmDirSync(opts.workspacePath);
    const result: FreeWorkspaceResult = { removed: true };
    if (committedRef !== undefined) result.committedRef = committedRef;
    return result;
  },
};

function jjWorkspaceName(workspacePath: string): string {
  // basename of /foo/bar/worker-1 → worker-1
  return workspacePath.replace(/\/+$/, "").split("/").pop() ?? workspacePath;
}

async function jjCommitId(workspacePath: string): Promise<string> {
  return run(
    "jj",
    ["log", "-r", "@", "--no-graph", "--no-pager", "--color", "never", "--template", "commit_id"],
    workspacePath,
  );
}

// ─── sl backend (Sapling) ────────────────────────────────────────────────────
//
// `sl worktree` exists in Sapling but only for EdenFS-backed repos.
// For portability we use `sl clone` instead, which works on any
// sapling install. The trade-off is heavier (history copy) vs lighter
// (shared store), but the workspace is fully isolated either way —
// which is what we care about. EdenFS-specific worktree optimization
// can layer on later if anyone hits the friction.
//
// Free is just rm -rf: sapling has no formal "unclone" because each
// clone is a self-contained repo.

export const slBackend: VcsBackend = {
  name: "sl",

  async detect(projectRoot) {
    // Sapling uses `.sl` in newer mode and `.hg` in mercurial-compat
    // mode. Both are valid sapling repos to `sl`. Accept either.
    return (await isDir(join(projectRoot, ".sl"))) || (await isDir(join(projectRoot, ".hg")));
  },

  async createWorkspace(opts) {
    if (existsSync(opts.workspacePath)) {
      throw new Error(`vcs sl: workspacePath already exists: ${opts.workspacePath}`);
    }
    await ensureParent(opts.workspacePath);
    const args = ["clone"];
    if (opts.parentRef) args.push("-r", opts.parentRef);
    args.push(opts.projectRoot, opts.workspacePath);
    await run("sl", args);
    const commitId = await slCommitId(opts.workspacePath);
    return { parentRef: commitId };
  },

  async freeWorkspace(opts) {
    if (!existsSync(opts.workspacePath)) {
      return { removed: false };
    }
    let committedRef: string | undefined;
    if (opts.commit && (await slIsDirty(opts.workspacePath))) {
      // sl commit -A: stage all (including untracked), commit. Exits
      // non-zero if nothing changed, but we just guarded above.
      await run(
        "sl",
        [
          "--config",
          "ui.username=mu <mu@local>",
          "commit",
          "-A",
          "-m",
          "mu workspace free auto-commit",
        ],
        opts.workspacePath,
      );
      committedRef = await slCommitId(opts.workspacePath);
    }
    rmDirSync(opts.workspacePath);
    const result: FreeWorkspaceResult = { removed: true };
    if (committedRef !== undefined) result.committedRef = committedRef;
    return result;
  },
};

async function slCommitId(workspacePath: string): Promise<string> {
  return run("sl", ["log", "-r", ".", "--template", "{node}"], workspacePath);
}

async function slIsDirty(workspacePath: string): Promise<boolean> {
  // sl status prints one line per changed file; empty stdout = clean.
  const out = await run("sl", ["status"], workspacePath);
  return out.length > 0;
}

// ─── Dispatcher ──────────────────────────────────────────────────────

/**
 * Detection precedence: jj > sl > git > none. The first backend whose
 * detect() returns true wins. `none` is always last.
 *
 * jj and sl are added in follow-up commits but this list is the
 * canonical order they'll prepend to.
 */
const BACKENDS: readonly VcsBackend[] = [jjBackend, slBackend, gitBackend, noneBackend];

/** Return the backend that should handle projectRoot. Walks BACKENDS
 *  in precedence order; never returns undefined because noneBackend
 *  always claims. */
export async function detectBackend(projectRoot: string): Promise<VcsBackend> {
  for (const backend of BACKENDS) {
    if (await backend.detect(projectRoot)) return backend;
  }
  return noneBackend;
}

/** Look up a backend by name. Throws on unknown name. Used by
 *  `mu workspace create --backend ...` to honour an explicit override. */
export function backendByName(name: VcsBackendName): VcsBackend {
  for (const backend of BACKENDS) {
    if (backend.name === name) return backend;
  }
  throw new Error(`unknown vcs backend: ${name}`);
}
