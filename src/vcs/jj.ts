// mu — jj VCS backend.

import { existsSync } from "node:fs";
import {
  ensureParent,
  parseNulRecords,
  probeVcsRoot,
  rmDirSync,
  run,
  runShow,
  saneLimit,
} from "./helpers.js";
import { type FreeWorkspaceResult, type VcsBackend, WorkspaceConflictError } from "./types.js";

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
    return probeVcsRoot("jj", ["root"], projectRoot);
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
        jjCommitSummaryTemplate,
      ],
      workspacePath,
    );
    return parseNulRecords(out);
  },

  async recentCommits(projectRoot, limit) {
    if (!existsSync(projectRoot)) {
      throw new Error(`vcs jj: project root missing: ${projectRoot}`);
    }
    const n = saneLimit(limit);
    if (n === 0) return [];
    const out = await run(
      "jj",
      [
        "log",
        "--no-graph",
        "--no-pager",
        "--color",
        "never",
        "-r",
        "::@",
        "--limit",
        String(n),
        "--template",
        jjCommitSummaryTemplate,
      ],
      projectRoot,
    );
    return parseNulRecords(out);
  },

  async showCommit(projectRoot, sha) {
    return runShow("jj", ["show", sha, "--color", "always"], projectRoot);
  },

  // jj is always-snapshotted: there is no "uncommitted" state. The
  // working copy is itself a commit; the next snapshot folds any
  // edits in. Surface that by returning [] so `recreateWorkspace`
  // never refuses a jj workspace as "dirty".
  async listDirtyFiles(_workspacePath) {
    return [];
  },
};

const jjCommitSummaryTemplate =
  'commit_id ++ "\\x00" ++ description.first_line() ++ "\\x00" ++ description ++ "\\x00" ++ author.timestamp().format("%Y-%m-%dT%H:%M:%S%:z") ++ "\\x00" ++ author.name() ++ "\\x1e"';

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
