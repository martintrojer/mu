// mu — Sapling VCS backend.

import { existsSync } from "node:fs";
import {
  ensureParent,
  isSaplingDotdir,
  parseNulRecords,
  probeVcsRootPath,
  rmDirSync,
  run,
  runShow,
  saneLimit,
} from "./helpers.js";
import {
  type FreeWorkspaceResult,
  type VcsBackend,
  WorkspaceConflictError,
  WorkspaceDirtyError,
} from "./types.js";

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
    const root = await probeVcsRootPath("sl", ["root"], projectRoot);
    if (root === null) return false;
    // Meta's Sapling build can transparently operate in plain git repos
    // by creating `.git/sl`. That should not beat git in BACKENDS order.
    // `--dotdir` keeps true sl / hg-compat repos (`.sl` / `.hg`) distinct.
    const dotdir = await probeVcsRootPath("sl", ["root", "--dotdir"], projectRoot);
    return dotdir !== null && isSaplingDotdir(dotdir);
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
      ["log", "-r", `${baseRef}::. - ${baseRef}`, "--template", slCommitSummaryTemplate],
      workspacePath,
    );
    // sl emits oldest-last by default; reverse to oldest-first to match
    // the git/jj contract.
    return parseNulRecords(out).reverse();
  },

  async recentCommits(projectRoot, limit) {
    if (!existsSync(projectRoot)) {
      throw new Error(`vcs sl: project root missing: ${projectRoot}`);
    }
    const n = saneLimit(limit);
    if (n === 0) return [];
    const out = await run(
      "sl",
      ["log", "-l", String(n), "--template", slCommitSummaryTemplate],
      projectRoot,
    );
    return parseNulRecords(out);
  },

  async showCommit(projectRoot, sha) {
    return runShow("sl", ["show", sha, "--color=always"], projectRoot);
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

const slCommitSummaryTemplate =
  "{node}\\0{desc|firstline}\\0{desc}\\0{date|isodatesec}\\0{author|user}\\x1e";

async function slCommitId(workspacePath: string): Promise<string> {
  return run("sl", ["log", "-r", ".", "--template", "{node}"], workspacePath);
}

async function slIsDirty(workspacePath: string): Promise<boolean> {
  // sl status prints one line per changed file; empty stdout = clean.
  const out = await run("sl", ["status"], workspacePath);
  return out.length > 0;
}
