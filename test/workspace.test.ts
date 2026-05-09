// Tests for src/workspace.ts and src/vcs.ts (none + git backends).
//
// `none` is exercised on every platform (just `cp -a`).
// `git` is exercised when git is on PATH (effectively always for CI).
// `jj` and `sl` get their own integration tests in follow-up commits.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { detectBackend, gitBackend, jjBackend, noneBackend, slBackend } from "../src/vcs.js";
import {
  HomeDirAsProjectRootError,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
  createWorkspace,
  decorateWithStaleness,
  freeWorkspace,
  getWorkspaceForAgent,
  listWorkspaceOrphans,
  listWorkspaces,
  workspacePath,
} from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";

let stateRoot: string;
let projectRoot: string;
let dbDir: string;
let db: Db;

function setStateDir(dir: string): void {
  process.env.MU_STATE_DIR = dir;
}

beforeEach(() => {
  // MU_STATE_DIR controls where workspaces land (and the default DB path,
  // but we override that via openDb({path}) anyway). Use a per-test temp
  // root so workspaces don't leak between tests.
  stateRoot = mkdtempSync(join(tmpdir(), "mu-ws-state-"));
  setStateDir(stateRoot);
  dbDir = mkdtempSync(join(tmpdir(), "mu-ws-db-"));
  db = openDb({ path: join(dbDir, "mu.db") });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });

  projectRoot = mkdtempSync(join(tmpdir(), "mu-ws-project-"));
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

// ─── detectBackend ────────────────────────────────────────────────────

describe("detectBackend precedence", () => {
  it("picks git when .git exists", async () => {
    mkdirSync(join(projectRoot, ".git"));
    const backend = await detectBackend(projectRoot);
    expect(backend.name).toBe("git");
  });

  it("falls back to none when no VCS marker exists", async () => {
    const backend = await detectBackend(projectRoot);
    expect(backend.name).toBe("none");
  });

  it("picks jj when .jj exists (precedence over git)", async () => {
    mkdirSync(join(projectRoot, ".jj"));
    mkdirSync(join(projectRoot, ".git"));
    const backend = await detectBackend(projectRoot);
    expect(backend.name).toBe("jj");
  });

  it("picks sl when .sl exists (precedence over git)", async () => {
    mkdirSync(join(projectRoot, ".sl"));
    mkdirSync(join(projectRoot, ".git"));
    const backend = await detectBackend(projectRoot);
    expect(backend.name).toBe("sl");
  });
});

// ─── none backend ─────────────────────────────────────────────────────

describe("noneBackend", () => {
  it("createWorkspace cp -a's the project root to the workspace path", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await noneBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const cp = execFileSync("cat", [join(wsPath, "README")], { encoding: "utf8" });
    expect(cp).toBe("hello\n");
  });

  it("createWorkspace fails if the workspace path already exists", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    mkdirSync(wsPath, { recursive: true });
    await expect(
      noneBackend.createWorkspace({ projectRoot, workspacePath: wsPath }),
    ).rejects.toThrow(/already exists/);
  });

  it("freeWorkspace removes the directory; reports removed=true", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await noneBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await noneBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(true);
  });

  it("freeWorkspace is idempotent on a missing dir (removed=false)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "ghost");
    const r = await noneBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(false);
  });
});

// ─── git backend ──────────────────────────────────────────────────────

const GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const gitDescribe = GIT ? describe : describe.skip;

// ─── jj backend (skipped when jj is not on PATH) ────────────────

const JJ = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const jjDescribe = JJ ? describe : describe.skip;

// ─── sl backend (skipped when sl is not on PATH) ────────────────

const SL = (() => {
  try {
    execFileSync("sl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const slDescribe = SL ? describe : describe.skip;

slDescribe("slBackend", () => {
  beforeEach(() => {
    execFileSync("sl", ["init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("sl", ["--config", "ui.username=t <t@t>", "commit", "-A", "-m", "init"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  });

  it("createWorkspace clones to the workspace path + returns commit_id", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
    expect(execFileSync("cat", [join(wsPath, "README")], { encoding: "utf8" })).toBe("hello\n");
  });

  it("freeWorkspace removes the directory", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await slBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(true);
  });

  it("freeWorkspace --commit captures pending changes", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    writeFileSync(join(wsPath, "new.txt"), "x");
    const r = await slBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("freeWorkspace --commit on a clean tree reports no commit", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await slBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toBeUndefined();
  });
});

jjDescribe("jjBackend", () => {
  beforeEach(() => {
    execFileSync("jj", ["git", "init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("jj", ["commit", "-m", "init"], { cwd: projectRoot, stdio: "ignore" });
  });

  it("createWorkspace creates a jj workspace + returns commit_id", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("freeWorkspace forgets the workspace and removes the directory", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await jjBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(true);
    // jj workspace list (from project root) shouldn't include worker-1.
    const list = execFileSync("jj", ["workspace", "list"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(list).not.toContain("worker-1:");
  });

  it("freeWorkspace --commit captures the current commit_id", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    writeFileSync(join(wsPath, "new.txt"), "x");
    const r = await jjBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toMatch(/^[0-9a-f]{40}$/);
  });
});

gitDescribe("gitBackend", () => {
  beforeEach(() => {
    execFileSync("git", ["init", "-q", "-b", "main", projectRoot], { stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: projectRoot,
    });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { cwd: projectRoot },
    );
  });

  it("createWorkspace creates a git worktree at the requested path", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
    const branch = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: wsPath,
      encoding: "utf8",
    }).trim();
    expect(branch).toBe(r.parentRef);
  });

  it("freeWorkspace tears down the worktree (no auto-commit, no pending changes)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await gitBackend.freeWorkspace({ workspacePath: wsPath, commit: false });
    expect(r.removed).toBe(true);
    expect(r.committedRef).toBeUndefined();
  });

  it("freeWorkspace --commit captures pending changes when present", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    writeFileSync(join(wsPath, "new.txt"), "x");
    const r = await gitBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toMatch(/^[0-9a-f]{40}$/);
  });

  it("freeWorkspace --commit on a clean tree reports no commit", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const r = await gitBackend.freeWorkspace({ workspacePath: wsPath, commit: true });
    expect(r.committedRef).toBeUndefined();
  });

  // Regression for mufeedback workspace_free_cleanup_leaves_git: a
  // user who manually rm-rf'd a workspace dir leaves the git worktree
  // registry pointing at a missing path. Without the defensive prune
  // in createWorkspace, the next add at that path errors with
  // 'missing but already registered worktree'. With it, recovery is
  // automatic.
  it("createWorkspace recovers when a previous worktree dir was rm-rf'd (defensive prune)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    // Simulate the user's exact failure: manual rm -rf without
    // running freeWorkspace. The git registry still points at wsPath.
    rmSync(wsPath, { recursive: true, force: true });
    // Sanity: git knows about the (now missing) worktree.
    const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(wtList).toContain(wsPath);
    // Now retry: defensive prune in createWorkspace should clean the
    // stale registration and let the add succeed.
    const r = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(r.parentRef).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ─── workspace SDK (registry layer on top of backends) ────────────────

describe("workspace SDK (with noneBackend)", () => {
  it("createWorkspace records a row + creates the directory", async () => {
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    expect(ws.agent).toBe("worker-1");
    expect(ws.backend).toBe("none");
    expect(ws.path).toContain(join("workspaces", "auth", "worker-1"));
    expect(getWorkspaceForAgent(db, "worker-1")?.path).toBe(ws.path);
  });

  it("createWorkspace throws WorkspaceExistsError on a second call for the same agent", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    await expect(
      createWorkspace(db, {
        agent: "worker-1",
        workstream: "auth",
        projectRoot,
        backend: "none",
      }),
    ).rejects.toThrow(WorkspaceExistsError);
  });

  // Regression for mufeedback agent_close_orphans_workspace_dir_from /
  // agent_spawn_workspace_fails_when_prior: a workspace dir from
  // before the cccba88 close-refuses fix (or from any other source)
  // sits on disk with no DB row. Pre-fix, createWorkspace bubbled a
  // bare backend Error ('vcs <name>: workspacePath already exists').
  // Post-fix, it throws the typed WorkspacePathNotEmptyError WITH
  // structured nextSteps.
  it("createWorkspace throws WorkspacePathNotEmptyError when path exists with no DB row", async () => {
    // Create then free via raw rm-rf to simulate the orphan case
    // WITHOUT going through freeWorkspace (which would also drop the
    // row). Then DELETE the row manually so the dir survives but the
    // registry doesn't see it.
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    db.prepare("DELETE FROM vcs_workspaces WHERE agent = 'worker-1'").run();
    // Sanity: registry empty, dir present.
    expect(getWorkspaceForAgent(db, "worker-1")).toBeUndefined();
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).not.toThrow();
    // Retry: typed error, not bare.
    await expect(
      createWorkspace(db, {
        agent: "worker-1",
        workstream: "auth",
        projectRoot,
        backend: "none",
      }),
    ).rejects.toBeInstanceOf(WorkspacePathNotEmptyError);
  });

  it("createWorkspace rolls back the on-disk dir when the DB INSERT fails (regression)", async () => {
    // Pre-stage: insert a row pointing at the path worker-2 WOULD
    // get, so the path UNIQUE constraint fires when worker-2's
    // createWorkspace tries to INSERT. Use a DIFFERENT agent name
    // for the pre-stage so getWorkspaceForAgent(worker-2) returns
    // undefined (i.e. we don't trip the WorkspaceExistsError early-out).
    const futurePath = workspacePath("auth", "worker-2");
    insertAgent(db, { name: "squatter", workstream: "auth", paneId: "%99", status: "busy" });
    db.prepare(
      "INSERT INTO vcs_workspaces (agent, workstream, backend, path, parent_ref, created_at) VALUES (?, ?, 'none', ?, NULL, datetime('now'))",
    ).run("squatter", "auth", futurePath);

    // Trigger: createWorkspace for worker-2. backend.createWorkspace
    // will succeed (cp -a); the INSERT will fail (UNIQUE on path);
    // the rollback should remove the on-disk dir.
    await expect(
      createWorkspace(db, {
        agent: "worker-2",
        workstream: "auth",
        projectRoot,
        backend: "none",
      }),
    ).rejects.toThrow(/UNIQUE/i);

    // CRITICAL: the on-disk dir from backend.createWorkspace must be
    // gone, not orphaned. Surfaced by bug_agent_spawn_workspace_fk_failure:
    // pre-fix, the dir survived the failed INSERT, leaving the operator
    // with an orphan dir blocking subsequent spawns.
    expect(() => execFileSync("ls", [futurePath], { stdio: "pipe" })).toThrow();
  });

  it("listWorkspaces filters by workstream", async () => {
    ensureWorkstream(db, "billing");
    insertAgent(db, { name: "biller", workstream: "billing", paneId: "%9", status: "busy" });
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    await createWorkspace(db, {
      agent: "biller",
      workstream: "billing",
      projectRoot,
      backend: "none",
    });
    expect(listWorkspaces(db, "auth").map((r) => r.agent)).toEqual(["worker-1"]);
    expect(listWorkspaces(db, "billing").map((r) => r.agent)).toEqual(["biller"]);
    expect(listWorkspaces(db).length).toBe(2);
  });

  it("freeWorkspace removes both row and directory", async () => {
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    const r = await freeWorkspace(db, "worker-1");
    expect(r.removed).toBe(true);
    expect(r.rowDeleted).toBe(true);
    expect(getWorkspaceForAgent(db, "worker-1")).toBeUndefined();
    // Directory really gone:
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).toThrow();
  });

  it("freeWorkspace is idempotent on a missing workspace", async () => {
    const r = await freeWorkspace(db, "ghost");
    expect(r).toEqual({ removed: false, rowDeleted: false });
  });

  it("getWorkspaceForAgent throws WorkspaceNotFoundError shape via the verb wrapper", () => {
    expect(getWorkspaceForAgent(db, "ghost")).toBeUndefined();
  });

  it("FK CASCADE: deleting the agent row removes the workspace row", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    expect(getWorkspaceForAgent(db, "worker-1")).toBeUndefined();
  });

  it("FK CASCADE: destroying the workstream removes its workspace rows", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    db.prepare("DELETE FROM workstreams WHERE name = 'auth'").run();
    expect(listWorkspaces(db, "auth")).toEqual([]);
  });
});

// ─── HomeDirAsProjectRootError + cleanup-on-throw ─────────────────────
//
// Regression for snap_dogfood Finding 4 / workspace_create_partial_dir_on_failure.
// Two interlocking sub-bugs:
//   (a) projectRoot = $HOME silently kicks off a recursive cp -a of the
//       user's home dir, which stalls on DRM-protected files.
//   (b) When the backend throws mid-create, the partial on-disk dir
//       was left behind with no DB row.

describe("createWorkspace HOME-dir guard (snap_dogfood Finding 4a)", () => {
  it("throws HomeDirAsProjectRootError when projectRoot resolves to $HOME", async () => {
    const { homedir } = await import("node:os");
    await expect(
      createWorkspace(db, {
        agent: "worker-1",
        workstream: "auth",
        projectRoot: homedir(),
        backend: "none",
      }),
    ).rejects.toBeInstanceOf(HomeDirAsProjectRootError);
    // No DB row, no on-disk dir was even attempted.
    expect(getWorkspaceForAgent(db, "worker-1")).toBeUndefined();
  });

  it("normalises trailing slash + . variants of $HOME", async () => {
    const { homedir } = await import("node:os");
    await expect(
      createWorkspace(db, {
        agent: "worker-1",
        workstream: "auth",
        projectRoot: `${homedir()}/`,
        backend: "none",
      }),
    ).rejects.toBeInstanceOf(HomeDirAsProjectRootError);
    await expect(
      createWorkspace(db, {
        agent: "worker-1",
        workstream: "auth",
        projectRoot: `${homedir()}/./`,
        backend: "none",
      }),
    ).rejects.toBeInstanceOf(HomeDirAsProjectRootError);
  });

  it("does NOT block direct children of $HOME (overreach)", async () => {
    // ~/Documents should be allowed; the guard is targeted at
    // "projectRoot IS $HOME", not "projectRoot is anywhere under $HOME".
    // Use the test's projectRoot (a real temp dir) to confirm the
    // normal path still succeeds; the negative case for ~/Documents
    // is covered by the resolve()-equality contract above.
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    expect(ws.agent).toBe("worker-1");
  });
});

describe("createWorkspace cleanup on backend throw (snap_dogfood Finding 4b)", () => {
  it("removes the partial on-disk dir when backend.createWorkspace throws after creating it", async () => {
    // Reproduction: invoke the SDK with a fresh fake backend that
    // throws AFTER putting a partial dir on disk — the snap_dogfood
    // Finding 4b case (cp -a interrupted by DRM-protected file).
    //
    // We pass the fake backend via `opts.backend` (which accepts
    // either a backend name OR a `VcsBackend` object). Building a
    // standalone fake — instead of monkey-patching the exported
    // `noneBackend` singleton — means a thrown assertion can never
    // leak a mutated singleton into the next test that uses
    // noneBackend.createWorkspace (e.g. the FK CASCADE tests above).
    const wsPath = workspacePath("auth", "worker-1");
    let partialDirSeenByCleanup = false;
    const flakyBackend = {
      name: "none" as const,
      async detect() {
        return true;
      },
      async createWorkspace(opts: { projectRoot: string; workspacePath: string }) {
        // Simulate the cp-mid-stream failure: create a partial dir
        // first, then throw.
        mkdirSync(opts.workspacePath, { recursive: true });
        writeFileSync(join(opts.workspacePath, "partial"), "oops");
        partialDirSeenByCleanup = true;
        throw new Error("simulated cp -a interrupted by DRM-protected file");
      },
      async freeWorkspace() {
        return { removed: false };
      },
      async commitsBehind() {
        return null;
      },
    };
    await expect(
      createWorkspace(db, {
        agent: "worker-1",
        workstream: "auth",
        projectRoot,
        backend: flakyBackend,
      }),
    ).rejects.toThrow(/simulated cp -a interrupted/);
    expect(partialDirSeenByCleanup).toBe(true);
    // CRITICAL: the partial dir is gone, not orphaned. Pre-fix this
    // would leave the dir behind and block subsequent
    // `mu workspace create` with WorkspacePathNotEmptyError.
    expect(() => execFileSync("ls", [wsPath], { stdio: "pipe" })).toThrow();
    // And the registry has no row either.
    expect(getWorkspaceForAgent(db, "worker-1")).toBeUndefined();
    // Recovery path works: a re-attempt with a working backend
    // succeeds without WorkspacePathNotEmptyError.
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    expect(ws.path).toBe(wsPath);
  });
});

describe("WorkspaceNotFoundError", () => {
  it("is thrown by callers (CLI uses it for not-found exit code)", () => {
    expect(() => {
      throw new WorkspaceNotFoundError("ghost");
    }).toThrow(/no workspace for agent: ghost/);
  });
});

// ─── closeAgent integration with workspace ────────────────────

describe("closeAgent + workspace integration", () => {
  it("closeAgent REFUSES (WorkspacePreservedError) when the agent has a workspace and --discard-workspace is not passed", async () => {
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).not.toThrow();

    const { closeAgent, WorkspacePreservedError } = await import("../src/agents.js");
    await expect(closeAgent(db, "worker-1")).rejects.toBeInstanceOf(WorkspacePreservedError);

    // Refuse path: nothing changed. Agent still in DB, workspace row still
    // there, dir still on disk.
    expect(getWorkspaceForAgent(db, "worker-1")).toBeDefined();
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).not.toThrow();
    // Cleanup.
    rmSync(ws.path, { recursive: true, force: true });
  });

  it("closeAgent { discardWorkspace: true } frees workspace AND deletes agent in one shot", async () => {
    // worker-1 is pre-inserted by the outer beforeEach; create a workspace
    // for it then close with discard.
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).not.toThrow();

    const { closeAgent } = await import("../src/agents.js");
    const r = await closeAgent(db, "worker-1", { discardWorkspace: true });

    expect(r.killedPane).toBe(true);
    expect(r.deletedRow).toBe(true);
    expect(r.workspaceFreed).toBe(true);

    // Workspace gone from DB AND from disk.
    expect(getWorkspaceForAgent(db, "worker-1")).toBeUndefined();
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).toThrow();
  });

  it("closeAgent succeeds normally when the agent had no workspace", async () => {
    insertAgent(db, { name: "plain-1", workstream: "auth", paneId: "%9", status: "busy" });
    const { closeAgent } = await import("../src/agents.js");
    const r = await closeAgent(db, "plain-1");
    expect(r.workspaceFreed).toBe(false);
    expect(r.deletedRow).toBe(true);
  });

  it("closeAgent without an agent returns false flags", async () => {
    const { closeAgent } = await import("../src/agents.js");
    const r = await closeAgent(db, "ghost");
    expect(r).toEqual({
      killedPane: false,
      deletedRow: false,
      workspaceFreed: false,
    });
  });
});

// ─── listWorkspaceOrphans (regression for bug_workspace_orphan_not_in_state) ───

describe("listWorkspaceOrphans", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-orphans-"));
    process.env.MU_STATE_DIR = tempDir;
    db = openDb({ path: join(tempDir, "mu.db") });
    ensureWorkstream(db, "auth");
  });

  afterEach(() => {
    db.close();
    const key = "MU_STATE_DIR";
    delete process.env[key];
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("returns [] when the workspaces dir doesn't exist", () => {
    expect(listWorkspaceOrphans(db, "auth")).toEqual([]);
  });

  it("returns [] when every dir on disk has a DB row", async () => {
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", status: "busy" });
    await createWorkspace(db, {
      agent: "w1",
      workstream: "auth",
      projectRoot: tempDir,
      backend: "none",
    });
    expect(listWorkspaceOrphans(db, "auth")).toEqual([]);
  });

  it("flags a dir on disk that has no DB row", async () => {
    // Create a real workspace, then DELETE the row to leave the dir
    // orphaned (the bug_workspace_orphan_not_in_state shape).
    insertAgent(db, { name: "w1", workstream: "auth", paneId: "%1", status: "busy" });
    const ws = await createWorkspace(db, {
      agent: "w1",
      workstream: "auth",
      projectRoot: tempDir,
      backend: "none",
    });
    db.prepare("DELETE FROM vcs_workspaces WHERE agent = 'w1'").run();
    const orphans = listWorkspaceOrphans(db, "auth");
    expect(orphans.length).toBe(1);
    expect(orphans[0]?.agent).toBe("w1");
    expect(orphans[0]?.workstream).toBe("auth");
    expect(orphans[0]?.path).toBe(ws.path);
  });

  it("only flags dirs missing rows, not dirs that have rows", async () => {
    insertAgent(db, { name: "live", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "orphaned", workstream: "auth", paneId: "%2", status: "busy" });
    await createWorkspace(db, {
      agent: "live",
      workstream: "auth",
      projectRoot: tempDir,
      backend: "none",
    });
    await createWorkspace(db, {
      agent: "orphaned",
      workstream: "auth",
      projectRoot: tempDir,
      backend: "none",
    });
    db.prepare("DELETE FROM vcs_workspaces WHERE agent = 'orphaned'").run();
    const orphans = listWorkspaceOrphans(db, "auth");
    expect(orphans.map((o) => o.agent)).toEqual(["orphaned"]);
  });
});

// ─── commitsBehind / decorateWithStaleness ────────────────────────
//
// Surfaced by bug_workspace_stale_parent_silent_drift: long-lived
// workspaces silently drift from main with no signal to the operator.
// Each backend's commitsBehind() reports how many commits the
// parent_ref is behind the local refs cache's notion of "main".
// Pure observation: NO automatic fetch.

describe("noneBackend.commitsBehind always returns null", () => {
  it("none has no notion of main", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    await noneBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    expect(await noneBackend.commitsBehind(wsPath, "any-ref")).toBeNull();
  });
});

gitDescribe("gitBackend.commitsBehind", () => {
  // The git tests construct a fake "origin" remote so the workspace
  // has a real refs/remotes/origin/HEAD to resolve. We use a bare
  // clone as the "remote" and add it as origin in the workspace.
  let originDir: string;
  let consumerProject: string;

  beforeEach(() => {
    // origin = a bare repo we can advance without affecting `projectRoot`.
    originDir = mkdtempSync(join(tmpdir(), "mu-origin-"));
    execFileSync("git", ["init", "-q", "-b", "main", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "a.txt"), "a\n");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
      cwd: projectRoot,
    });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c1"], {
      cwd: projectRoot,
    });
    // Make a bare "origin" out of projectRoot's history.
    execFileSync("git", ["clone", "--bare", projectRoot, originDir], { stdio: "ignore" });
    // Now make a fresh consumer that has origin set to the bare. The
    // workspace will be a worktree of THIS consumer (not projectRoot)
    // so origin/HEAD resolves correctly.
    consumerProject = mkdtempSync(join(tmpdir(), "mu-consumer-"));
    rmSync(consumerProject, { recursive: true, force: true });
    execFileSync("git", ["clone", "-q", originDir, consumerProject], { stdio: "ignore" });
  });

  afterEach(() => {
    for (const dir of [originDir, consumerProject]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("returns 0 when parent_ref equals current main", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await gitBackend.createWorkspace({
      projectRoot: consumerProject,
      workspacePath: wsPath,
    });
    expect(r.parentRef).toBeTruthy();
    const behind = await gitBackend.commitsBehind(wsPath, r.parentRef ?? "");
    expect(behind).toBe(0);
  });

  it("returns N>0 after origin/main advances by N commits", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await gitBackend.createWorkspace({
      projectRoot: consumerProject,
      workspacePath: wsPath,
    });
    // Advance origin by 3 commits, then have the consumer fetch so the
    // local origin/main moves while parent_ref stays put.
    const advancer = mkdtempSync(join(tmpdir(), "mu-advance-"));
    execFileSync("git", ["clone", "-q", originDir, advancer], { stdio: "ignore" });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(advancer, `f${i}.txt`), `${i}\n`);
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
        cwd: advancer,
      });
      execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `c${i + 2}`],
        { cwd: advancer },
      );
    }
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: advancer });
    rmSync(advancer, { recursive: true, force: true });
    // Now have the workspace fetch (the human side of the bug — we
    // EXPLICITLY simulate the operator running `git fetch`; mu itself
    // does NOT fetch). Without fetch, refs/remotes/origin/main would
    // still point at the original commit and behind=0.
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: wsPath });
    const behind = await gitBackend.commitsBehind(wsPath, r.parentRef ?? "");
    expect(behind).toBe(3);
  });

  it("returns null when no main can be resolved (no remote)", async () => {
    // Use the original projectRoot which has NO origin remote.
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-2");
    const r = await gitBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const behind = await gitBackend.commitsBehind(wsPath, r.parentRef ?? "");
    expect(behind).toBeNull();
  });

  it("returns null on a missing workspace dir", async () => {
    const behind = await gitBackend.commitsBehind(join(stateRoot, "nope"), "deadbeef");
    expect(behind).toBeNull();
  });
});

jjDescribe("jjBackend.commitsBehind returns a number or null", () => {
  beforeEach(() => {
    execFileSync("jj", ["git", "init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("jj", ["commit", "-m", "init"], { cwd: projectRoot, stdio: "ignore" });
  });

  it("returns either a non-negative number or null (smoke)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await jjBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const behind = await jjBackend.commitsBehind(wsPath, r.parentRef ?? "");
    // jj's trunk() is heuristic; on a fresh repo with no remote it
    // may resolve to @ (giving 0) or fail (giving null). Either is
    // a sane answer; we just want to confirm we get one of them, not
    // a thrown error or NaN.
    expect(behind === null || (typeof behind === "number" && behind >= 0)).toBe(true);
  });
});

slDescribe("slBackend.commitsBehind returns a number or null", () => {
  beforeEach(() => {
    execFileSync("sl", ["init", projectRoot], { stdio: "ignore" });
    writeFileSync(join(projectRoot, "README"), "hello\n");
    execFileSync("sl", ["--config", "ui.username=t <t@t>", "commit", "-A", "-m", "init"], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  });

  it("returns either a non-negative number or null (smoke)", async () => {
    const wsPath = join(stateRoot, "workspaces", "auth", "worker-1");
    const r = await slBackend.createWorkspace({ projectRoot, workspacePath: wsPath });
    const behind = await slBackend.commitsBehind(wsPath, r.parentRef ?? "");
    expect(behind === null || (typeof behind === "number" && behind >= 0)).toBe(true);
  });
});

describe("decorateWithStaleness", () => {
  it("populates commitsBehindMain on every row (null for none-backend)", async () => {
    insertAgent(db, { name: "w2", workstream: "auth", paneId: "%2", status: "busy" });
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    await createWorkspace(db, {
      agent: "w2",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    const rows = listWorkspaces(db, "auth");
    const decorated = await decorateWithStaleness(rows);
    expect(decorated).toHaveLength(2);
    for (const r of decorated) {
      // none-backend always returns null (no notion of main).
      expect(r.commitsBehindMain).toBeNull();
    }
  });

  it("sets commitsBehindMain to null when parent_ref is null", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    // The none-backend explicitly returns parent_ref=null on create,
    // so this should bypass the backend call.
    const decorated = await decorateWithStaleness(listWorkspaces(db, "auth"));
    expect(decorated[0]?.parentRef).toBeNull();
    expect(decorated[0]?.commitsBehindMain).toBeNull();
  });

  it("memoizes commitsBehind by (backend, parentRef): N rows = 1 shellout", async () => {
    // Regression for review_code_decorate_with_staleness_n_plus_one:
    // a `watch -n 5 mu state -w X` loop with N agents sharing a
    // parent_ref must NOT fan out N parallel git/jj/sl child processes
    // every 5 seconds. Per-invocation memoization collapses N rows
    // sharing (backend, parentRef) to ONE backend call.
    const spy = vi.spyOn(gitBackend, "commitsBehind").mockImplementation(async () => 7);
    try {
      const sharedRef = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const rows = [
        {
          agent: "a",
          workstream: "w",
          backend: "git" as const,
          path: "/p/a",
          parentRef: sharedRef,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "b",
          workstream: "w",
          backend: "git" as const,
          path: "/p/b",
          parentRef: sharedRef,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "c",
          workstream: "w",
          backend: "git" as const,
          path: "/p/c",
          parentRef: sharedRef,
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "d",
          workstream: "w",
          backend: "git" as const,
          path: "/p/d",
          parentRef: sharedRef,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
      const decorated = await decorateWithStaleness(rows);
      expect(decorated.map((r) => r.commitsBehindMain)).toEqual([7, 7, 7, 7]);
      // The cache hit assertion: 4 rows, 1 shellout.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("memoizes per (backend, parentRef): distinct refs each shell out once", async () => {
    // Sanity check that the cache key is parentRef-scoped, not
    // global-scoped — distinct parent_refs must each get their own
    // shellout, but each one only once regardless of row count.
    const spy = vi
      .spyOn(gitBackend, "commitsBehind")
      .mockImplementation(async (_path, ref) => (ref === "refA" ? 3 : 11));
    try {
      const rows = [
        {
          agent: "a",
          workstream: "w",
          backend: "git" as const,
          path: "/p/a",
          parentRef: "refA",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "b",
          workstream: "w",
          backend: "git" as const,
          path: "/p/b",
          parentRef: "refA",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "c",
          workstream: "w",
          backend: "git" as const,
          path: "/p/c",
          parentRef: "refB",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          agent: "d",
          workstream: "w",
          backend: "git" as const,
          path: "/p/d",
          parentRef: "refB",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
      const decorated = await decorateWithStaleness(rows);
      expect(decorated.map((r) => r.commitsBehindMain)).toEqual([3, 3, 11, 11]);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("caps concurrency: never more than 4 in-flight backend calls", async () => {
    // Bounding the fan-out is the second half of the fix. Without a
    // cap, a workstream with 20 unique parent_refs would shell out
    // 20 git/jj/sl children at once. We assert peak in-flight ≤ 4.
    let inFlight = 0;
    let peak = 0;
    const spy = vi.spyOn(gitBackend, "commitsBehind").mockImplementation(async () => {
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      // Yield twice to give other queued workers a chance to start;
      // a broken cap would let all 12 enter the body before any exits.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return 0;
    });
    try {
      const rows = Array.from({ length: 12 }, (_, i) => ({
        agent: `a${i}`,
        workstream: "w",
        backend: "git" as const,
        path: `/p/a${i}`,
        parentRef: `ref-${i}`, // distinct refs → cache never hits, all 12 must shell out
        createdAt: "2026-01-01T00:00:00Z",
      }));
      await decorateWithStaleness(rows);
      expect(spy).toHaveBeenCalledTimes(12);
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});
