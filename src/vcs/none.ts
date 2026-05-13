// mu — non-VCS fallback backend.

import { existsSync } from "node:fs";
import { ensureParent, rmDirSync, run } from "./helpers.js";
import { type VcsBackend, WorkspaceVcsRequiredError } from "./types.js";

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

  async recentCommits(_projectRoot, _limit) {
    return [];
  },

  async showCommit(_projectRoot, _sha) {
    return { text: "", truncated: false, error: "vcs none: no commits to show" };
  },

  // No VCS → nothing to compare against; "dirty" is unanswerable.
  // Caller (`recreateWorkspace`) treats [] as "clean" and proceeds.
  async listDirtyFiles(_workspacePath) {
    return [];
  },
};
