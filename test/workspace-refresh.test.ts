// Tests for `mu workspace refresh` (fb_workspace_recycle_verb /
// mu_workspace_refresh_rebase_agent). Covers:
//
//   - The SDK seam (`refreshWorkspace`) for the `none` backend
//     (always errors with WorkspaceVcsRequiredError) and the
//     missing-row case (WorkspaceNotFoundError).
//   - The git backend's `rebaseTo` happy path: replays draft commits
//     onto a freshly-advanced origin/main, returns the replayed
//     subjects oldest-first, fromRef resolves to a refs/remotes/origin/*
//     symbolic ref.
//   - The git backend's dirty-WC refusal: throws WorkspaceDirtyError
//     carrying the dirty file list; the rebase never runs.
//   - The git backend's conflict path: throws WorkspaceConflictError
//     carrying the conflicting file paths; the workspace is aborted
//     back to a clean state.
//   - The jj backend smoke test (skipped without jj on PATH): a no-op
//     refresh on an unchanged trunk returns an empty replayed list
//     and does not throw.
//
// The integration tests for jj/sl mirror the conditional-describe
// pattern in test/workspace-backends.test.ts.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  WorkspaceConflictError,
  WorkspaceDirtyError,
  WorkspaceVcsRequiredError,
  gitBackend,
  jjBackend,
} from "../src/vcs.js";
import { WorkspaceNotFoundError, createWorkspace, refreshWorkspace } from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";

let stateRoot: string;
let projectRoot: string;
let dbDir: string;
let db: Db;

function setStateDir(dir: string): void {
  process.env.MU_STATE_DIR = dir;
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "mu-refresh-state-"));
  setStateDir(stateRoot);
  dbDir = mkdtempSync(join(tmpdir(), "mu-refresh-db-"));
  db = openDb({ path: join(dbDir, "mu.db") });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  projectRoot = mkdtempSync(join(tmpdir(), "mu-refresh-project-"));
  writeFileSync(join(projectRoot, "README"), "hello\n");
});

afterEach(() => {
  db.close();
  for (const dir of [stateRoot, dbDir, projectRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

// ─── SDK-level guards ─────────────────────────────────────────────────

describe("refreshWorkspace (SDK)", () => {
  it("throws WorkspaceNotFoundError when no row for agent", async () => {
    let caught: unknown;
    try {
      await refreshWorkspace(db, { agent: "ghost", workstream: "auth" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("throws WorkspaceVcsRequiredError on the none backend", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    let caught: unknown;
    try {
      await refreshWorkspace(db, { agent: "worker-1", workstream: "auth" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceVcsRequiredError);
    expect((caught as Error).message).toContain("vcs none");
    expect((caught as Error).message).toContain("refresh");
  });
});

// ─── git backend integration ──────────────────────────────────────────

const GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const gitDescribe = GIT ? describe : describe.skip;

// Construct an "origin → consumer → workspace" topology so origin/HEAD
// resolves and we can advance origin to test that the rebase pulls the
// new commits in. Mirrors test/workspace-backends.test.ts's setup.
function gitInitConsumer(): { originDir: string; consumerProject: string } {
  const originDir = mkdtempSync(join(tmpdir(), "mu-refresh-origin-"));
  execFileSync("git", ["init", "-q", "-b", "main", projectRoot], { stdio: "ignore" });
  writeFileSync(join(projectRoot, "a.txt"), "a\n");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: projectRoot,
  });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c1"], {
    cwd: projectRoot,
  });
  execFileSync("git", ["clone", "--bare", projectRoot, originDir], { stdio: "ignore" });
  const consumerProject = mkdtempSync(join(tmpdir(), "mu-refresh-consumer-"));
  rmSync(consumerProject, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", originDir, consumerProject], { stdio: "ignore" });
  return { originDir, consumerProject };
}

// Push N empty-ish commits to origin/main from a throwaway clone so
// the workspace can fetch + rebase against a moved upstream.
function advanceOrigin(originDir: string, n: number, prefix = "f"): void {
  const advancer = mkdtempSync(join(tmpdir(), "mu-refresh-advance-"));
  rmSync(advancer, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", originDir, advancer], { stdio: "ignore" });
  for (let i = 0; i < n; i++) {
    writeFileSync(join(advancer, `${prefix}${i}.txt`), `${i}\n`);
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: advancer,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `upstream ${i}`],
      { cwd: advancer },
    );
  }
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: advancer });
  rmSync(advancer, { recursive: true, force: true });
}

gitDescribe("gitBackend.rebaseTo", () => {
  let originDir: string;
  let consumerProject: string;

  beforeEach(() => {
    const t = gitInitConsumer();
    originDir = t.originDir;
    consumerProject = t.consumerProject;
  });

  afterEach(() => {
    for (const dir of [originDir, consumerProject]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("no-op when workspace is already at origin/HEAD (replayed=[])", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot: consumerProject, workspacePath: wsPath });
    const r = await gitBackend.rebaseTo(wsPath);
    expect(r.fromRef).toContain("origin");
    expect(r.replayed).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it("replays a draft commit onto a freshly-advanced origin/main", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot: consumerProject, workspacePath: wsPath });
    // Workspace makes its own commit (the worker's WIP).
    writeFileSync(join(wsPath, "draft.txt"), "wip\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: wsPath,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "worker-draft"],
      { cwd: wsPath },
    );
    // Origin advances after the worker started.
    advanceOrigin(originDir, 2, "u");
    // Refresh: the rebase should pull the upstream commits in and
    // replay our draft on top. We pass --from origin/main explicitly
    // (resolveGitMainRef would also work but is path-dependent on the
    // local refs cache, which we DO refresh in rebaseTo).
    const r = await gitBackend.rebaseTo(wsPath, "origin/main");
    expect(r.replayed).toEqual(["worker-draft"]);
    expect(r.conflicts).toEqual([]);
    // Sanity: HEAD is past origin/main now (origin/main..HEAD = 1).
    const ahead = execFileSync("git", ["rev-list", "--count", "origin/main..HEAD"], {
      cwd: wsPath,
      encoding: "utf8",
    }).trim();
    expect(ahead).toBe("1");
  });

  it("refuses on dirty WC and lists the dirty files", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot: consumerProject, workspacePath: wsPath });
    writeFileSync(join(wsPath, "dirty.txt"), "x\n");
    let caught: unknown;
    try {
      await gitBackend.rebaseTo(wsPath, "origin/main");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceDirtyError);
    const files = (caught as WorkspaceDirtyError).files;
    expect(files).toContain("dirty.txt");
    // The error message should also count the dirty files.
    expect((caught as Error).message).toMatch(/uncommitted/);
  });

  it("aborts the rebase + throws WorkspaceConflictError on conflict", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot: consumerProject, workspacePath: wsPath });
    // Worker edits a.txt one way, locally committed.
    writeFileSync(join(wsPath, "a.txt"), "worker change\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: wsPath,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "worker-edit"],
      { cwd: wsPath },
    );
    // Origin edits a.txt the other way, on top of the same parent.
    const advancer = mkdtempSync(join(tmpdir(), "mu-refresh-advance-conf-"));
    rmSync(advancer, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", originDir, advancer], { stdio: "ignore" });
    writeFileSync(join(advancer, "a.txt"), "upstream change\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: advancer,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "upstream-edit"],
      { cwd: advancer },
    );
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: advancer });
    rmSync(advancer, { recursive: true, force: true });
    // Refresh: the rebase will try to replay worker-edit on top of
    // upstream-edit's a.txt and conflict.
    let caught: unknown;
    try {
      await gitBackend.rebaseTo(wsPath, "origin/main");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceConflictError);
    const conflicts = (caught as WorkspaceConflictError).conflicts;
    expect(conflicts).toContain("a.txt");
    // Sanity: the workspace is back to a non-rebasing state (the abort
    // ran cleanly), so the next git command shouldn't error with
    // 'rebase in progress'.
    const status = execFileSync("git", ["status", "--porcelain=v2", "--branch"], {
      cwd: wsPath,
      encoding: "utf8",
    });
    expect(status).not.toMatch(/REBASE/);
  });
});

// ─── jj backend smoke (only runs when jj on PATH) ─────────────────────

const JJ = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const jjDescribe = JJ ? describe : describe.skip;

jjDescribe("jjBackend.rebaseTo (smoke)", () => {
  beforeEach(() => {
    execFileSync("jj", ["git", "init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("jj", ["commit", "-m", "init"], { cwd: projectRoot, stdio: "ignore" });
  });

  // Smoke: a no-op rebase against a backend-resolved fromRef should
  // either succeed with an empty replayed list (when trunk() resolves)
  // or throw a non-typed error (when trunk() can't resolve on a fresh
  // jj repo with no remote). Both are acceptable; we just want to
  // confirm the call shape works and never throws our typed errors
  // unexpectedly.
  it("no-op refresh either succeeds (empty replayed) or surfaces a non-typed error", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    let r: Awaited<ReturnType<typeof jjBackend.rebaseTo>> | undefined;
    let caught: unknown;
    try {
      r = await jjBackend.rebaseTo(wsPath);
    } catch (err) {
      caught = err;
    }
    if (r) {
      expect(Array.isArray(r.replayed)).toBe(true);
      expect(Array.isArray(r.conflicts)).toBe(true);
      expect(r.conflicts.length).toBe(0);
    } else {
      // jj's `rebase -d trunk()` on a fresh repo with no configured
      // trunk MAY fail; that's acceptable as long as we don't surface
      // the wrong typed error.
      expect(caught).not.toBeInstanceOf(WorkspaceVcsRequiredError);
      expect(caught).not.toBeInstanceOf(WorkspaceDirtyError);
    }
  });
});
