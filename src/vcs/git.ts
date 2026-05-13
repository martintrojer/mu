// mu — git VCS backend.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  commitSummary,
  ensureParent,
  exec,
  probeVcsRoot,
  rmDirSync,
  run,
  runShow,
  saneLimit,
} from "./helpers.js";
import {
  type CommitSummary,
  type FreeWorkspaceResult,
  type VcsBackend,
  WorkspaceConflictError,
  WorkspaceDirtyError,
} from "./types.js";

// Uses `git worktree` so the new workspace shares the .git store with
// the project root. Cheap (no copy), fast, and integrates with the rest
// of the agent's git workflow (push, log, etc) trivially.

export const gitBackend: VcsBackend = {
  name: "git",

  async detect(projectRoot) {
    return probeVcsRoot("git", ["rev-parse", "--show-toplevel"], projectRoot);
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
      records.push(commitSummary(sha, subject, body, authorDate));
    }
    return records;
  },

  async recentCommits(projectRoot, limit) {
    if (!existsSync(projectRoot)) {
      throw new Error(`vcs git: project root missing: ${projectRoot}`);
    }
    const n = saneLimit(limit);
    if (n === 0) return [];
    const out = await run(
      "git",
      ["log", `--max-count=${n}`, "-z", "--format=%H%x00%s%x00%b%x00%aI%x00%an"],
      projectRoot,
    );
    return parseGitZRecords(out);
  },

  async showCommit(projectRoot, sha) {
    return runShow("git", ["show", sha, "--stat", "-p", "--color=always"], projectRoot);
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
      // Commit only if there's anything to commit. Reuse the same
      // dirty-file semantics as isClean() and rebaseTo(): `git status
      // --porcelain` includes working-tree, staged, and untracked-not-
      // ignored changes.
      const dirty = (await listGitDirtyFiles(opts.workspacePath)).length > 0;
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
  // files appear as `?? path` and are included by default.
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

function parseGitZRecords(raw: string): CommitSummary[] {
  if (raw.length === 0) return [];
  const fields = raw.split("\x00");
  const records: CommitSummary[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const sha = fields[i] ?? "";
    if (sha.length === 0) continue;
    records.push(
      commitSummary(
        sha,
        fields[i + 1] ?? "",
        fields[i + 2] ?? "",
        fields[i + 3] ?? "",
        fields[i + 4] ?? "",
      ),
    );
  }
  return records;
}
