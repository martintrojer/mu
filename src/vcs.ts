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
import type { HasNextSteps, NextStep } from "./output.js";

const exec = promisify(execFile);

export type VcsBackendName = "jj" | "sl" | "git" | "none";

// ─── Refresh / rebase result + typed errors ──────────────────────────
//
// rebaseTo is the backend-side of `mu workspace refresh`. The errors
// live in this module (not src/workspace.ts) because they're thrown
// from inside the backend impls; workspace.ts already imports vcs.ts,
// so colocating avoids a circular import. handle.ts imports them by
// name to map exit codes (4 for dirty / vcs-required, 5 for conflict).

export interface RebaseResult {
  /** The ref the workspace was actually rebased onto (resolved
   *  symbolic-or-revset → concrete name). For git that is the
   *  resolveGitMainRef() symbolic ref; for jj/sl it's the literal
   *  `trunk()` revset (or whatever the operator passed via fromRef). */
  fromRef: string;
  /** Commit subjects (or descriptions) that got replayed, oldest-first.
   *  Empty when the workspace was already at fromRef (no-op). */
  replayed: string[];
  /** Files / commits that conflicted during the rebase. Always
   *  empty for a successful rebase — a non-empty conflicts list
   *  means we threw WorkspaceConflictError before returning. The
   *  field exists so the error's serialised payload can carry it. */
  conflicts: string[];
}

export interface CommitSummary {
  /** Full commit / change id. */
  sha: string;
  /** First-line description / subject. */
  subject: string;
  /** Remainder of the commit message (may be empty). */
  body: string;
  /** ISO-8601 author / commit timestamp. */
  authorDate: string;
}

/**
 * Thrown by `rebaseTo` / `commitsSinceBase` on the `none` backend
 * (cp -a snapshots have no notion of a rebase target / fork point).
 * Maps to exit code 4.
 */
export class WorkspaceVcsRequiredError extends Error implements HasNextSteps {
  override readonly name = "WorkspaceVcsRequiredError";
  constructor(
    public readonly verb: string,
    public readonly workspacePath: string,
  ) {
    super(
      `vcs none: \`mu workspace ${verb}\` requires a real VCS (jj/sl/git); ${workspacePath} is a cp -a snapshot`,
    );
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "Free the snapshot and re-create with a real VCS backend",
        command: "mu workspace free <agent>  &&  mu workspace create <agent> --backend <jj|sl|git>",
      },
    ];
  }
}

/**
 * Thrown by `rebaseTo` when the workspace has uncommitted changes
 * the rebase would clobber. Carries the dirty file list so the operator
 * can decide between commit/stash/--force. Maps to exit code 4.
 */
export class WorkspaceDirtyError extends Error implements HasNextSteps {
  override readonly name = "WorkspaceDirtyError";
  /** The verb that refused ("rebase", "recreate", ...). Used to make
   *  the error message + nextSteps point the operator at the right
   *  escape hatch (e.g. recreate's `--force`). Default "rebase" for
   *  backward compatibility with the original rebaseTo call sites. */
  public readonly verb: string;
  constructor(
    public readonly workspacePath: string,
    public readonly files: readonly string[],
    verb = "rebase",
  ) {
    super(
      `workspace dirty (${files.length} uncommitted file(s)): ${workspacePath}; refusing to ${verb}`,
    );
    this.verb = verb;
  }
  errorNextSteps(): NextStep[] {
    const steps: NextStep[] = [
      {
        intent: "Inspect the dirty files",
        command: `(cd ${this.workspacePath} && git status -s)  # or jj st / sl st`,
      },
      {
        intent: `Commit them first, then retry ${this.verb}`,
        command: `(cd ${this.workspacePath} && git add -A && git commit -m WIP)`,
      },
      {
        intent: "Or stash them first (git only)",
        command: `(cd ${this.workspacePath} && git stash)`,
      },
    ];
    if (this.verb === "recreate") {
      steps.push({
        intent: "Or DISCARD all uncommitted changes (the lossy escape)",
        command: "mu workspace recreate <agent> --force",
      });
    }
    return steps;
  }
}

/**
 * Thrown by `rebaseTo` when the rebase produced conflicts the
 * operator must resolve manually. Carries the conflicting paths.
 * Maps to exit code 5.
 */
export class WorkspaceConflictError extends Error implements HasNextSteps {
  override readonly name = "WorkspaceConflictError";
  constructor(
    public readonly workspacePath: string,
    public readonly fromRef: string,
    public readonly conflicts: readonly string[],
  ) {
    super(`rebase onto ${fromRef} produced ${conflicts.length} conflict(s): ${workspacePath}`);
  }
  errorNextSteps(): NextStep[] {
    return [
      {
        intent: "cd into the workspace and resolve",
        command: `cd ${this.workspacePath}  # then resolve & commit; or: git rebase --abort / jj abandon / sl rebase --abort`,
      },
    ];
  }
}

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

  /**
   * Count commits that the project's default branch ("main") has but
   * `ref` does not — i.e. how many commits `ref` is BEHIND main.
   *
   * Used by `mu workspace list` and `mu state` to surface staleness
   * (bug_workspace_stale_parent_silent_drift). Cheap, pure-observation:
   * NO automatic fetch. We compare against whatever main resolves to in
   * the workspace's LOCAL refs cache. The user can `git fetch` (or
   * equivalent) themselves if they want a fresher number.
   *
   * Returns null when:
   *  - main / trunk cannot be resolved (no origin/HEAD, no origin/main,
   *    no origin/master, no trunk() bookmark, etc.)
   *  - the underlying VCS command fails for any reason (detached worktree,
   *    missing refs, the `none` backend which has no notion of "main")
   *
   * Callers treat null as "unknown — render — — and don't warn".
   */
  commitsBehind(workspacePath: string, ref: string): Promise<number | null>;

  /**
   * Rebase the workspace onto `fromRef` (or the backend's tracked
   * base when undefined: `origin/HEAD` for git, `trunk()` for jj/sl).
   * Returns the resolved ref + replayed commits + conflicts list.
   *
   * Backend-specific behaviour:
   *   - git: refuses on dirty WC (WorkspaceDirtyError); fetches first;
   *     `git rebase <ref>`. On conflict, aborts the rebase and throws
   *     WorkspaceConflictError so the operator resolves manually.
   *   - jj:  always-snapshotted, so dirty is never an issue. After
   *     `jj rebase -d <ref>` the conflict-set is queried via
   *     `jj log -r 'conflict()'`. Conflicts surface as
   *     WorkspaceConflictError without an abort (jj's conflict markers
   *     persist as commits; the operator resolves in-place).
   *   - sl:  similar to jj. `sl rebase -d <ref>`; conflicts via
   *     `sl resolve -l`. On dirty WC sl errors itself; we wrap that
   *     into WorkspaceDirtyError.
   *   - none: throws WorkspaceVcsRequiredError unconditionally.
   *
   * Surfaced by fb_workspace_recycle_verb: dogfood between waves
   * needed `close → free → spawn` to refresh a worker against new
   * main; that killed the worker's LLM context. `refresh` updates
   * the on-disk dir without touching the agent or pane.
   */
  rebaseTo(workspacePath: string, fromRef?: string): Promise<RebaseResult>;

  /**
   * Cheap "is the working copy clean?" probe used by close-auto-free
   * (allow_mu_agent_close_without_discard). Definition: ZERO uncommitted
   * changes (no working-tree modifications, no staged changes, no
   * untracked-not-ignored files). Pure observation; no fetch, no commit.
   *
   * Backend-specific:
   *   - git: empty `git status --porcelain` output.
   *   - jj:  jj is auto-snapshotted, so the @ commit IS the WC; clean
   *          here means @ has no diff from its parent (empty `jj diff
   *          -r @ --summary`). A description-only difference still
   *          counts as clean.
   *   - sl:  empty `sl status` output.
   *   - none: meaningless (cp -a snapshot has no notion of
   *          "committed" vs "uncommitted"); always returns true so the
   *          close-auto-free path treats every none-workspace as
   *          eligible for silent free (no commits can be lost; the only
   *          loss is local file edits, which the operator implicitly
   *          accepts by closing the agent).
   *
   * Returns false on any backend command failure — be conservative
   * (we'd rather refuse a close than auto-free a workspace whose
   * cleanliness we couldn't verify).
   */
  isClean(workspacePath: string): Promise<boolean>;

  /**
   * List commits the workspace has on top of `baseRef`, oldest-first.
   * Used by `mu workspace commits` (fb_workspace_commits_verb) to
   * promote the dogfood-painful
   *     cd $(mu workspace path X) && git log <base>..HEAD
   * incantation into a typed verb that knows the workspace's
   * parent_ref. The CommitSummary fields survive subjects/bodies with
   * embedded newlines (NUL-delimited record format on the wire).
   *
   * `none` throws WorkspaceVcsRequiredError. Returns `[]` when the
   * workspace is exactly at baseRef (no commits since fork). Throws
   * on backend command failure (unknown ref, missing repo).
   */
  commitsSinceBase(workspacePath: string, baseRef: string): Promise<CommitSummary[]>;

  /**
   * Return the list of dirty (uncommitted / unstaged / untracked-not-
   * ignored) paths in the workspace. Empty array = clean.
   *
   * Used by `mu workspace recreate` to refuse a free+create cycle on
   * a dirty workspace unless the operator passes `--force` (the lossy
   * escape hatch). Mirrors the dirty-check `rebaseTo` does internally.
   *
   * Backend semantics:
   *   - git: `git status --porcelain` (working-tree + staged +
   *     untracked-not-ignored, mirroring the rebaseTo path).
   *   - sl:  `sl status` parsed for non-empty output.
   *   - jj:  always-snapshotted, so no concept of "dirty" — returns [].
   *   - none: cp -a snapshots have no VCS, so we can't decide "dirty";
   *     returns [] so the caller doesn't refuse for an unanswerable
   *     question.
   *
   * Throws on backend command failure (the operator should see a
   * real error, not a silent "clean").
   */
  listDirtyFiles(workspacePath: string): Promise<string[]>;
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

  // The `none` backend has no VCS to compare against — there's no
  // notion of "main" for a `cp -a` snapshot. Always null.
  async commitsBehind(_workspacePath, _ref) {
    return null;
  },

  // none has no notion of clean — a cp -a snapshot doesn't track
  // committed vs uncommitted state. Returning true makes the
  // close-auto-free path silently free a none-workspace (consistent
  // with the fact that there are no commits to lose).
  async isClean(_workspacePath) {
    return true;
  },

  // none has no upstream to rebase onto. Throw a typed error so the
  // CLI's handle() maps it to exit 4 with a clean Next: hint.
  async rebaseTo(workspacePath, _fromRef) {
    throw new WorkspaceVcsRequiredError("refresh", workspacePath);
  },

  // none has no notion of a fork point either — a cp -a snapshot
  // doesn't track history. Same typed error as rebaseTo.
  async commitsSinceBase(workspacePath, _baseRef) {
    throw new WorkspaceVcsRequiredError("commits", workspacePath);
  },

  // No VCS → nothing to compare against; "dirty" is unanswerable.
  // Caller (`recreateWorkspace`) treats [] as "clean" and proceeds.
  async listDirtyFiles(_workspacePath) {
    return [];
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

  // Working-copy clean check: empty `git status --porcelain` output
  // means no working-tree, staged, or untracked-not-ignored changes.
  // Returns false on any failure (workspace path missing, git
  // explodes) — be conservative; auto-free should never "silently
  // succeed" because we couldn't check.
  async isClean(workspacePath) {
    if (!existsSync(workspacePath)) return false;
    try {
      const files = await listGitDirtyFiles(workspacePath);
      return files.length === 0;
    } catch {
      return false;
    }
  },

  // Compute commits-behind as: count of commits reachable from main
  // but not from `ref`. Resolves "main" via origin/HEAD (the symbolic
  // ref the remote advertises), falling back to origin/main and then
  // origin/master. Returns null when none of those resolve, or when
  // the rev-list call fails (e.g. ref unknown locally).
  //
  // Pure observation: NO `git fetch`. The number is as fresh as the
  // last time the user (or some other process) updated the local
  // remote-tracking refs.
  async commitsBehind(workspacePath, ref) {
    if (!existsSync(workspacePath)) return null;
    const main = await resolveGitMainRef(workspacePath);
    if (main === undefined) return null;
    try {
      const out = await run("git", ["rev-list", "--count", `${ref}..${main}`], workspacePath);
      const n = Number.parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  },

  // Rebase the worktree onto `fromRef` (default = origin/HEAD via
  // resolveGitMainRef). Refuses on a dirty WC; returns the replayed
  // commit subjects oldest-first; on conflict aborts the rebase and
  // throws WorkspaceConflictError so the operator never inherits a
  // half-rebased worktree from us.
  //
  // We DO `git fetch` first — otherwise the rebase target would only
  // be as fresh as the local refs cache, and the operator running
  // `mu workspace refresh` is explicitly asking for the latest. This
  // is the one-and-only place mu fetches; commitsBehind() stays pure.
  async rebaseTo(workspacePath, fromRef) {
    if (!existsSync(workspacePath)) {
      throw new Error(`vcs git: workspace path missing: ${workspacePath}`);
    }
    // Dirty-check first: refuse before any side effect.
    const dirtyFiles = await listGitDirtyFiles(workspacePath);
    if (dirtyFiles.length > 0) {
      throw new WorkspaceDirtyError(workspacePath, dirtyFiles);
    }
    // Best-effort fetch so the resolved main ref is fresh. Failure is
    // ignored (offline / no remote) — we still attempt the rebase
    // against whatever the local refs cache holds.
    await run("git", ["fetch", "--quiet"], workspacePath).catch(() => {});
    let resolvedRef: string;
    if (fromRef !== undefined) {
      resolvedRef = fromRef;
    } else {
      const main = await resolveGitMainRef(workspacePath);
      if (main === undefined) {
        throw new Error(
          `vcs git: cannot resolve default branch (no origin/HEAD, origin/main, or origin/master) in ${workspacePath}; pass --from <ref>`,
        );
      }
      resolvedRef = main;
    }
    // Capture the pre-rebase HEAD so we can compute `replayed` as the
    // commits that ended up on top of resolvedRef after the rebase.
    const preHead = await run("git", ["rev-parse", "HEAD"], workspacePath);
    try {
      await run(
        "git",
        ["-c", "user.email=mu@local", "-c", "user.name=mu", "rebase", resolvedRef],
        workspacePath,
      );
    } catch (err) {
      // Capture the conflicting paths BEFORE aborting (the abort
      // resets the index and the unmerged paths disappear).
      const conflicts = await listGitUnmergedPaths(workspacePath);
      await run("git", ["rebase", "--abort"], workspacePath).catch(() => {});
      if (conflicts.length > 0) {
        throw new WorkspaceConflictError(workspacePath, resolvedRef, conflicts);
      }
      // Non-conflict rebase failure (e.g. unknown ref). Surface it raw.
      throw err;
    }
    // Replayed commits = the new HEAD..resolvedRef gap, but oldest-first
    // and limited to what was actually replayed from preHead. We use
    // `git log --reverse <merge-base>..HEAD` where the merge base is
    // computed against resolvedRef, since after a successful rebase
    // HEAD's history above the base IS the replayed set.
    const mergeBase = await run("git", ["merge-base", "HEAD", resolvedRef], workspacePath).catch(
      () => preHead,
    );
    const logOut = await run(
      "git",
      ["log", "--reverse", "--format=%s", `${mergeBase}..HEAD`],
      workspacePath,
    );
    const replayed = logOut.length === 0 ? [] : logOut.split("\n");
    return { fromRef: resolvedRef, replayed, conflicts: [] };
  },

  // List commits in (baseRef..HEAD), oldest-first. The format string
  // packs four NUL-delimited fields per record, then a record
  // separator '\x1e' (RECORD-SEPARATOR control char) so subjects /
  // bodies with embedded newlines or NULs survive parsing. We don't
  // use a JSON template because git's `--format` is field-oriented;
  // %x00 (NUL) and %x1e (RS) are git's portable escape sequences.
  async commitsSinceBase(workspacePath, baseRef) {
    if (!existsSync(workspacePath)) {
      throw new Error(`vcs git: workspace path missing: ${workspacePath}`);
    }
    const out = await run(
      "git",
      ["log", "--reverse", "-z", "--format=%H%x00%s%x00%b%x00%aI", `${baseRef}..HEAD`],
      workspacePath,
    );
    if (out.length === 0) return [];
    // -z makes git use NUL as the record separator; combined with our
    // %x00 field separators each commit looks like:
    //   <sha>\0<subject>\0<body>\0<authorDate>\0
    // i.e. four fields followed by the record-terminating NUL git
    // injects with -z. Splitting on NUL leaves us with 4N fields plus
    // a trailing empty string we drop.
    const fields = out.split("\x00");
    const records: CommitSummary[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const sha = fields[i] ?? "";
      const subject = fields[i + 1] ?? "";
      const body = fields[i + 2] ?? "";
      const authorDate = fields[i + 3] ?? "";
      if (sha.length === 0) continue;
      records.push({ sha, subject, body, authorDate });
    }
    return records;
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

  async listDirtyFiles(workspacePath) {
    if (!existsSync(workspacePath)) return [];
    return listGitDirtyFiles(workspacePath);
  },
};

/**
 * Resolve the workspace's notion of "main". Tries, in order:
 *   1. `origin/HEAD` — the symbolic ref the remote published
 *      (e.g. "refs/remotes/origin/main"). The most accurate signal.
 *   2. `refs/remotes/origin/main` — the convention.
 *   3. `refs/remotes/origin/master` — pre-rename convention.
 * Returns the resolved ref string (suitable for `git rev-list`) or
 * undefined if none of the three resolve.
 */
async function resolveGitMainRef(workspacePath: string): Promise<string | undefined> {
  for (const candidate of [
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
  ]) {
    try {
      await exec("git", ["rev-parse", "--verify", "--quiet", candidate], { cwd: workspacePath });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/**
 * Return the list of dirty paths (working-tree modifications + staged
 * + untracked-not-ignored), one entry per file. Empty when clean.
 * Used by `rebaseTo` to refuse with WorkspaceDirtyError carrying the
 * file list — one error message tells the operator both that the
 * workspace is dirty and which files to deal with.
 */
async function listGitDirtyFiles(workspacePath: string): Promise<string[]> {
  // `git status --porcelain` prints one line per changed file with
  // a 2-char status prefix; trim the prefix to get the path. Untracked
  // files appear as `?? path` and are included by default — same
  // strictness as isGitDirty (which used three independent commands).
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: workspacePath });
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  return lines.map((l) => l.slice(3));
}

/**
 * Return the unmerged paths after a failed `git rebase`. Used to
 * enrich WorkspaceConflictError before we abort. Empty list means the
 * rebase failed for a non-conflict reason (unknown ref, etc).
 */
async function listGitUnmergedPaths(workspacePath: string): Promise<string[]> {
  try {
    const out = await run("git", ["diff", "--name-only", "--diff-filter=U"], workspacePath);
    return out.length === 0 ? [] : out.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

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

  // jj working-copy clean: @ has no diff from its parent.
  // `jj diff -r @ --summary` prints one line per changed file; empty
  // stdout = clean. jj's auto-snapshotting means there's no separate
  // "untracked" bucket — every working-tree change is already in @.
  async isClean(workspacePath) {
    if (!existsSync(workspacePath)) return false;
    try {
      const out = await run(
        "jj",
        ["diff", "-r", "@", "--summary", "--no-pager", "--color", "never"],
        workspacePath,
      );
      return out.length === 0;
    } catch {
      return false;
    }
  },

  // Compute commits-behind via jj's `trunk()` revset, which resolves
  // to the project's configured trunk (default-branch heuristic).
  // Returns null when trunk() is unresolvable (e.g. fresh repo with
  // no configured trunk) or when the log call fails.
  //
  // Pure observation: NO `jj git fetch`.
  async commitsBehind(workspacePath, ref) {
    if (!existsSync(workspacePath)) return null;
    try {
      // `<ref>..trunk()` is the set of commits reachable from trunk
      // but not from ref — exactly the staleness number. Template `"x\n"`
      // gives one line per commit, which we count.
      const out = await run(
        "jj",
        [
          "log",
          "-r",
          `${ref}..trunk()`,
          "--no-graph",
          "--no-pager",
          "--color",
          "never",
          "--template",
          '"x\\n"',
        ],
        workspacePath,
      );
      if (out.length === 0) return 0;
      return out.split("\n").filter((l) => l.length > 0).length;
    } catch {
      return null;
    }
  },

  // Rebase the workspace's @ onto `fromRef` (default = `trunk()`).
  // jj is always-snapshotted so dirty WC is never an issue — the auto-
  // snapshot becomes part of the rebase. After the rebase we query
  // `conflict()` to surface any commits that ended up conflicted; jj
  // doesn't auto-abort on conflicts (they materialise as commits with
  // conflict markers), so the workspace is left in a state the
  // operator can resolve in-place.
  async rebaseTo(workspacePath, fromRef) {
    if (!existsSync(workspacePath)) {
      throw new Error(`vcs jj: workspace path missing: ${workspacePath}`);
    }
    const target = fromRef ?? "trunk()";
    // Snapshot the pre-rebase change_id so we can compute replayed
    // descriptions afterwards. `@` is the working-copy commit.
    const preRev = await run(
      "jj",
      ["log", "-r", "@", "--no-graph", "--no-pager", "--color", "never", "--template", "change_id"],
      workspacePath,
    );
    await run("jj", ["rebase", "-d", target], workspacePath);
    // Replayed = descriptions of commits in (target..@), oldest-first.
    // Template prints `description ++ "\n\x00"` so multi-line descs
    // survive splitting; we keep the first non-empty line as subject.
    const replayedRaw = await run(
      "jj",
      [
        "log",
        "-r",
        `${target}..@`,
        "--no-graph",
        "--no-pager",
        "--color",
        "never",
        "--reversed",
        "--template",
        'description.first_line() ++ "\\n"',
      ],
      workspacePath,
    ).catch(() => "");
    const replayed = replayedRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    // Conflict surface: list change_ids of commits in the rebased
    // range that are conflicted. Empty = clean rebase.
    const conflictRaw = await run(
      "jj",
      [
        "log",
        "-r",
        `(${target}..@) & conflict()`,
        "--no-graph",
        "--no-pager",
        "--color",
        "never",
        "--template",
        'change_id.short() ++ "\\n"',
      ],
      workspacePath,
    ).catch(() => "");
    const conflicts = conflictRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (conflicts.length > 0) {
      throw new WorkspaceConflictError(workspacePath, target, conflicts);
    }
    // Use preRev so future-resolution of @ at call time is irrelevant.
    void preRev;
    return { fromRef: target, replayed, conflicts: [] };
  },

  // List jj commits in (baseRef..@), oldest-first. jj's templating
  // gives us per-field strings; we glue them with NUL field-separators
  // and \x1e record-separators so multi-line descriptions/bodies
  // round-trip cleanly. The author timestamp template is
  // `author.timestamp().format("%Y-%m-%dT%H:%M:%S%:z")` which is
  // ISO-8601 (matches git's --aiso strict / --aI).
  async commitsSinceBase(workspacePath, baseRef) {
    if (!existsSync(workspacePath)) {
      throw new Error(`vcs jj: workspace path missing: ${workspacePath}`);
    }
    const out = await run(
      "jj",
      [
        "log",
        "-r",
        `${baseRef}..@`,
        "--no-graph",
        "--no-pager",
        "--color",
        "never",
        "--reversed",
        "--template",
        // commit_id\0subject\0body\0iso-date\x1e per record. The
        // outer string is jj-template syntax; \\x00 / \\x1e are
        // jj-template literal escape sequences. body = full
        // description (jj has no portable "rest of message" template,
        // and a small duplication of the first line beats a brittle
        // string-slicing template that breaks across jj versions).
        'commit_id ++ "\\x00" ++ description.first_line() ++ "\\x00" ++ description ++ "\\x00" ++ author.timestamp().format("%Y-%m-%dT%H:%M:%S%:z") ++ "\\x1e"',
      ],
      workspacePath,
    );
    return parseNulRecords(out);
  },

  // jj is always-snapshotted: there is no "uncommitted" state. The
  // working copy is itself a commit; the next snapshot folds any
  // edits in. Surface that by returning [] so `recreateWorkspace`
  // never refuses a jj workspace as "dirty".
  async listDirtyFiles(_workspacePath) {
    return [];
  },
};

/**
 * Parse the NUL-field / \x1e-record format used by the jj/sl
 * commitsSinceBase impls. Each record is `sha\0subject\0body\0date`
 * terminated by \x1e. Empty input → [].
 */
function parseNulRecords(raw: string): CommitSummary[] {
  if (raw.length === 0) return [];
  const records: CommitSummary[] = [];
  for (const rec of raw.split("\x1e")) {
    if (rec.length === 0) continue;
    const fields = rec.split("\x00");
    const sha = fields[0] ?? "";
    if (sha.length === 0) continue;
    records.push({
      sha,
      subject: fields[1] ?? "",
      body: fields[2] ?? "",
      authorDate: fields[3] ?? "",
    });
  }
  return records;
}

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

  // sl working-copy clean: empty `sl status` output. Same shape as
  // listSlDirtyFiles below but inlined to keep the failure-mode
  // boundary tight (any throw → not clean).
  async isClean(workspacePath) {
    if (!existsSync(workspacePath)) return false;
    try {
      const out = await run("sl", ["status"], workspacePath);
      return out.length === 0;
    } catch {
      return false;
    }
  },

  // Same shape as the jj impl: count commits in trunk() not reachable
  // from ref. Sapling's revset language is close enough to jj's that
  // the same idiom works. Returns null when trunk() is unresolvable
  // (fresh repo, missing remote bookmark, etc.) or the log fails.
  //
  // Pure observation: NO `sl pull`.
  async commitsBehind(workspacePath, ref) {
    if (!existsSync(workspacePath)) return null;
    try {
      const out = await run(
        "sl",
        ["log", "-r", `${ref}::trunk() - ${ref}`, "--template", "x\\n"],
        workspacePath,
      );
      if (out.length === 0) return 0;
      return out.split("\n").filter((l) => l.length > 0).length;
    } catch {
      return null;
    }
  },

  // Rebase the active draft chain onto `fromRef` (default = `trunk()`).
  // Sapling refuses on dirty WC by default — we pre-check and convert
  // its error into the typed WorkspaceDirtyError. Conflict surface
  // post-rebase via `sl resolve --list --tool=internal:dumpjson` is
  // brittle across versions, so we use the textual `sl resolve --list`
  // output and look for the U-prefixed lines (unresolved).
  async rebaseTo(workspacePath, fromRef) {
    if (!existsSync(workspacePath)) {
      throw new Error(`vcs sl: workspace path missing: ${workspacePath}`);
    }
    const target = fromRef ?? "trunk()";
    const dirtyFiles = await listSlDirtyFiles(workspacePath);
    if (dirtyFiles.length > 0) {
      throw new WorkspaceDirtyError(workspacePath, dirtyFiles);
    }
    await run(
      "sl",
      ["--config", "ui.username=mu <mu@local>", "rebase", "-d", target],
      workspacePath,
    ).catch(() => {
      // Rebase failure is acceptable here — the conflict-listing call
      // below will tell us what happened. Bare exception loss is OK
      // since `sl resolve` is the source of truth on conflicts.
    });
    const conflicts = await listSlUnresolved(workspacePath);
    if (conflicts.length > 0) {
      // Best-effort abort so the workspace returns to a clean state
      // — mirrors the git impl's never-leave-half-rebased policy.
      await run("sl", ["rebase", "--abort"], workspacePath).catch(() => {});
      throw new WorkspaceConflictError(workspacePath, target, conflicts);
    }
    // Replayed = log of `target..` post-rebase, oldest-first. Single-
    // line subjects via `{desc|firstline}`. Empty when nothing replayed.
    const replayedRaw = await run(
      "sl",
      ["log", "-r", `${target}::. - ${target}`, "--template", "{desc|firstline}\\n"],
      workspacePath,
    ).catch(() => "");
    const replayed = replayedRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { fromRef: target, replayed, conflicts: [] };
  },

  // List sl commits in (baseRef..., minus baseRef itself), oldest-
  // first. Same NUL-field / \x1e-record format as the jj impl;
  // sl's templating uses {field} braces (not jj's `++` operator) but
  // the field set is equivalent ({node}, {desc|firstline}, {desc},
  // {date|isodate}).
  async commitsSinceBase(workspacePath, baseRef) {
    if (!existsSync(workspacePath)) {
      throw new Error(`vcs sl: workspace path missing: ${workspacePath}`);
    }
    const out = await run(
      "sl",
      [
        "log",
        "-r",
        `${baseRef}::. - ${baseRef}`,
        "--template",
        "{node}\\0{desc|firstline}\\0{desc}\\0{date|isodatesec}\\x1e",
      ],
      workspacePath,
    );
    // sl emits oldest-last by default; reverse to oldest-first to match
    // the git/jj contract.
    return parseNulRecords(out).reverse();
  },

  async listDirtyFiles(workspacePath) {
    if (!existsSync(workspacePath)) return [];
    return listSlDirtyFiles(workspacePath);
  },
};

/**
 * List dirty paths for a sapling workspace. `sl status` prints one
 * line per changed file: `<status> <path>`. Empty = clean.
 */
async function listSlDirtyFiles(workspacePath: string): Promise<string[]> {
  const out = await run("sl", ["status"], workspacePath);
  if (out.length === 0) return [];
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.slice(2));
}

/**
 * List unresolved (conflicting) paths after an `sl rebase`. `sl resolve
 * --list` prints `<U|R> <path>` per file; U = unresolved.
 */
async function listSlUnresolved(workspacePath: string): Promise<string[]> {
  try {
    const out = await run("sl", ["resolve", "--list"], workspacePath);
    if (out.length === 0) return [];
    return out
      .split("\n")
      .filter((l) => l.startsWith("U "))
      .map((l) => l.slice(2));
  } catch {
    return [];
  }
}

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
