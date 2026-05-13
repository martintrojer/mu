// mu — shared VCS backend contracts and typed errors.

import type { HasNextSteps, NextStep } from "../output.js";

export type VcsBackendName = "jj" | "sl" | "git" | "none";

// ─── Refresh / rebase result + typed errors ──────────────────────────
//
// rebaseTo is the backend-side of `mu workspace refresh`. The errors
// live in this module (not src/workspace.ts) because they're thrown
// from inside the backend impls; workspace.ts imports vcs.ts, and the
// root vcs hub re-exports these concrete definitions.

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
  /** Author display name, when the backend exposes one. */
  author: string;
  /** ISO-8601 author / commit timestamp. */
  authorDate: string;
  /** Compact relative author time (e.g. "3m", "2d"). */
  relTime: string;
}

export interface ShowCommitResult {
  /** Captured VCS show output (possibly truncated). Empty string on error. */
  text: string;
  /** True when stdout exceeded SHOW_COMMIT_MAX_CHARS and was clipped. */
  truncated: boolean;
  /** Human-readable error message; omitted on success. */
  error?: string;
}

/** Cap captured `show` output so giant merge commits can't eat the TUI. */
export const SHOW_COMMIT_MAX_CHARS = 100_000;

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
   *  lost — the verb prints a clear warning. */
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

  /** Last N commits on the project root, newest-first. Used by the
   *  TUI Commits card / popup. Unlike commitsSinceBase, this is NOT
   *  a per-workspace since-fork query. */
  recentCommits(projectRoot: string, limit: number): Promise<CommitSummary[]>;

  /** Show one commit / change from the project root, capped for TUI
   *  rendering. Backend-specific equivalent of `git show <sha>`. */
  showCommit(projectRoot: string, sha: string): Promise<ShowCommitResult>;

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
