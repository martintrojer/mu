// Tests for src/workspace.ts and src/vcs.ts (none + git backends).
//
// `none` is exercised on every platform (just `cp -a`).
// `git` is exercised when git is on PATH (effectively always for CI).
// `jj` and `sl` get their own integration tests in follow-up commits.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { detectBackend, gitBackend, jjBackend, noneBackend, slBackend } from "../src/vcs.js";
import {
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  createWorkspace,
  freeWorkspace,
  getWorkspaceForAgent,
  listWorkspaces,
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

describe("WorkspaceNotFoundError", () => {
  it("is thrown by callers (CLI uses it for not-found exit code)", () => {
    expect(() => {
      throw new WorkspaceNotFoundError("ghost");
    }).toThrow(/no workspace for agent: ghost/);
  });
});

// ─── closeAgent integration with workspace ────────────────────

describe("closeAgent + workspace integration", () => {
  it("closeAgent leaves the on-disk dir intact (workspace and agent-close are separate concerns)", async () => {
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    // Sanity: dir exists.
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).not.toThrow();

    const { closeAgent } = await import("../src/agents.js");
    const r = await closeAgent(db, "worker-1");
    // Result reports workspaceKept=true so the CLI can prompt the user.
    expect(r.workspaceKept).toBe(true);
    // Workspace ROW cascades via FK on the agents row — the dir is
    // now orphaned (no DB pointer) but it still exists on disk and
    // can be removed manually.
    expect(getWorkspaceForAgent(db, "worker-1")).toBeUndefined();
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).not.toThrow();
    // Cleanup since closeAgent doesn't touch disk anymore.
    rmSync(ws.path, { recursive: true, force: true });
  });

  it("closeAgent reports workspaceKept=false when the agent had no workspace", async () => {
    insertAgent(db, { name: "plain-1", workstream: "auth", paneId: "%9", status: "busy" });
    const { closeAgent } = await import("../src/agents.js");
    const r = await closeAgent(db, "plain-1");
    expect(r.workspaceKept).toBe(false);
  });

  it("closeAgent without an agent returns false flags", async () => {
    const { closeAgent } = await import("../src/agents.js");
    const r = await closeAgent(db, "ghost");
    expect(r).toEqual({ killedPane: false, deletedRow: false, workspaceKept: false });
  });
});
