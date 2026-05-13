import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertAgent } from "../src/agents.js";
import { resolveInitialTab } from "../src/cli/tui-launch-focus.js";
import { type Db, openDb } from "../src/db.js";
import { appendLog } from "../src/logs.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";

function has(bin: string): boolean {
  return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
}

function git(repo: string, ...args: string[]): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "tester",
    GIT_AUTHOR_EMAIL: "tester@example.com",
    GIT_COMMITTER_NAME: "tester",
    GIT_COMMITTER_EMAIL: "tester@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  return execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8" }).trim();
}

function initGitRepo(tempDir: string): string {
  const repo = join(tempDir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

function addGitWorktree(repo: string, path: string, branch: string): void {
  rmSync(path, { recursive: true, force: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", path, "-b", branch], {
    stdio: "ignore",
  });
}

function registerWorkspace(
  db: Db,
  workstream: string,
  agent: string,
  workspacePath: string,
  backend: "git" | "none" = "none",
): void {
  mkdirSync(workspacePath, { recursive: true });
  insertAgent(db, { name: agent, workstream, paneId: `%${workstream}-${agent}`, status: "busy" });
  const ws = db.prepare("SELECT id FROM workstreams WHERE name = ?").get(workstream) as
    | { id: number }
    | undefined;
  const ag = db
    .prepare("SELECT id FROM agents WHERE name = ? AND workstream_id = ?")
    .get(agent, ws?.id ?? -1) as { id: number } | undefined;
  if (ws === undefined || ag === undefined) throw new Error("failed to seed workspace fixture");
  db.prepare(
    `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(ag.id, ws.id, backend, workspacePath, new Date().toISOString());
}

const gitDescribe = has("git") ? describe : describe.skip;

describe("resolveInitialTab", () => {
  let tempDir: string;
  let db: Db;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-tui-launch-focus-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    for (const ws of ["a", "b", "c", "z"]) ensureWorkstream(db, ws);
    setTmuxExecutor(async (args) => {
      if (args.join(" ") === "display-message -p #S") {
        return { exitCode: 0, stdout: "mu-b\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
  });

  afterEach(() => {
    chdir(originalCwd);
    db.close();
    resetTmuxExecutor();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rung 1: $MU_SESSION wins over tmux session match", async () => {
    await withEnv("MU_SESSION", "c", async () => {
      await withEnv("TMUX", "/tmp/tmux", async () => {
        await expect(resolveInitialTab(["a", "b", "c"], db)).resolves.toBe(2);
      });
    });
  });

  it('rung 2: tmux session "mu-b" focuses b when b is in the resolved set', async () => {
    await withEnv("MU_SESSION", undefined, async () => {
      await withEnv("TMUX", "/tmp/tmux", async () => {
        await expect(resolveInitialTab(["a", "b", "c"], db)).resolves.toBe(1);
      });
    });
  });

  it('rung 2: tmux session "mu-z" outside the resolved set falls through', async () => {
    setTmuxExecutor(async (args) => {
      if (args.join(" ") === "display-message -p #S") {
        return { exitCode: 0, stdout: "mu-z\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const workspace = join(tempDir, "workspace-b");
    registerWorkspace(db, "b", "worker-1", workspace);
    chdir(workspace);

    await withEnv("MU_SESSION", undefined, async () => {
      await withEnv("TMUX", "/tmp/tmux", async () => {
        await expect(resolveInitialTab(["a", "b", "c"], db)).resolves.toBe(1);
      });
    });
  });

  it("rung 2: outside tmux skips tmux-session focus", async () => {
    const workspace = join(tempDir, "workspace-b");
    registerWorkspace(db, "b", "worker-1", workspace);
    chdir(workspace);

    await withEnv("MU_SESSION", undefined, async () => {
      await withEnv("TMUX", undefined, async () => {
        await expect(resolveInitialTab(["a", "b", "c"], db)).resolves.toBe(1);
      });
    });
  });

  it("rung 3: cwd inside vcs_workspaces.path focuses that workstream", async () => {
    const workspace = join(tempDir, "workspace-b");
    registerWorkspace(db, "b", "worker-1", workspace);
    chdir(workspace);

    await withEnv("MU_SESSION", undefined, async () => {
      await withEnv("TMUX", undefined, async () => {
        await expect(resolveInitialTab(["a", "b", "c"], db)).resolves.toBe(1);
      });
    });
  });

  gitDescribe("project-root rung", () => {
    it("rung 4: cwd equal to one workstream's workspace project root focuses that workstream", async () => {
      const repo = initGitRepo(tempDir);
      const worktree = join(tempDir, "worker-b");
      addGitWorktree(repo, worktree, "worker-b");
      registerWorkspace(db, "b", "worker-1", worktree, "git");
      chdir(repo);

      await withEnv("MU_SESSION", undefined, async () => {
        await withEnv("TMUX", undefined, async () => {
          await expect(resolveInitialTab(["a", "b", "c"], db)).resolves.toBe(1);
        });
      });
    });

    it("rung 4: cwd equal to multiple workstreams' project root picks most-recently-active", async () => {
      const repo = initGitRepo(tempDir);
      const worktreeA = join(tempDir, "worker-a");
      const worktreeB = join(tempDir, "worker-b");
      addGitWorktree(repo, worktreeA, "worker-a");
      addGitWorktree(repo, worktreeB, "worker-b");
      registerWorkspace(db, "a", "worker-1", worktreeA, "git");
      registerWorkspace(db, "b", "worker-1", worktreeB, "git");
      appendLog(db, { workstream: "a", source: "system", kind: "event", payload: "old" });
      appendLog(db, { workstream: "b", source: "system", kind: "event", payload: "new" });
      chdir(repo);

      await withEnv("MU_SESSION", undefined, async () => {
        await withEnv("TMUX", undefined, async () => {
          await expect(resolveInitialTab(["a", "b", "c"], db)).resolves.toBe(1);
        });
      });
    });

    it("rung 4: cwd equal to multi-workstream project root with no logs falls through to tab 0", async () => {
      db.prepare("DELETE FROM agent_logs").run();
      const repo = initGitRepo(tempDir);
      const worktreeB = join(tempDir, "worker-b");
      const worktreeC = join(tempDir, "worker-c");
      addGitWorktree(repo, worktreeB, "worker-b");
      addGitWorktree(repo, worktreeC, "worker-c");
      registerWorkspace(db, "b", "worker-1", worktreeB, "git");
      registerWorkspace(db, "c", "worker-1", worktreeC, "git");
      db.prepare("DELETE FROM agent_logs").run();
      chdir(repo);

      await withEnv("MU_SESSION", undefined, async () => {
        await withEnv("TMUX", undefined, async () => {
          await expect(resolveInitialTab(["a", "b", "c"], db)).resolves.toBe(0);
        });
      });
    });
  });

  it("rung 5: cwd unrelated, no tmux, no MU_SESSION falls back to tab 0", async () => {
    chdir(tempDir);

    await withEnv("MU_SESSION", undefined, async () => {
      await withEnv("TMUX", undefined, async () => {
        await expect(resolveInitialTab(["a", "b", "c"], db)).resolves.toBe(0);
      });
    });
  });
});
