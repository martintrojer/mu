// Integration coverage for `mu task wait --first --json` nextSteps
// against real git-backed workspaces.
//
// Regression: the wait hint used to defer to
//   git cherry-pick $(cd $(mu workspace path X) && git log -1 --format=%H)
// If X closed without committing, `git log -1` returned the workspace's
// fork point (base), so orchestration automation appeared to succeed while
// pulling in nothing. These tests pin the safe behaviour: since-fork commits
// are resolved by mu, rendered as inspectable shas/ranges, and no-commit
// workers get a manual-rescue hint instead of a cherry-pick recipe.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, claimTask, closeTask } from "../src/tasks.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { type WorkspaceRow, createWorkspace } from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

const GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const gitDescribe = GIT ? describe : describe.skip;

interface WaitJsonPayload {
  nextSteps: Array<{ intent: string; command: string }>;
}

function initGitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "base\n");
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: root,
  });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], {
    cwd: root,
  });
}

function commitFile(
  workspacePath: string,
  filename: string,
  body: string,
  subject: string,
): string {
  writeFileSync(join(workspacePath, filename), body);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: workspacePath,
  });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", subject],
    { cwd: workspacePath },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    encoding: "utf8",
  }).trim();
}

gitDescribe("mu task wait nextSteps — git workspace commits", () => {
  let tempDir: string;
  let stateRoot: string;
  let dbPath: string;
  let projectRoot: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-wait-nextsteps-"));
    stateRoot = join(tempDir, "state");
    dbPath = join(tempDir, "mu.db");
    projectRoot = join(tempDir, "project");
    process.env.MU_STATE_DIR = stateRoot;
    initGitRepo(projectRoot);
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");

    // `mu task wait` reconciles before its immediate success snapshot.
    // Keep the fake agents alive through that reconcile without touching
    // a real tmux server; git workspaces remain real on disk.
    setTmuxExecutor(async (args) => {
      if (args[0] === "list-panes" && args[1] === "-s") {
        return {
          stdout: [
            "@1\t%1\tcommitter\tpi",
            "@1\t%2\tnoncommitter\tpi",
            "@1\t%3\tmulticommitter\tpi",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "capture-pane") {
        return { stdout: "ready\n> ", stderr: "", exitCode: 0 };
      }
      if (args[0] === "select-pane" || args[0] === "set-option") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: `unmocked tmux call: ${args.join(" ")}`, exitCode: 1 };
    });
  });

  afterEach(() => {
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
    const key = "MU_STATE_DIR";
    delete process.env[key];
  });

  async function seedWorker(agent: string, paneId: string, task: string): Promise<WorkspaceRow> {
    insertAgent(db, { name: agent, workstream: "test", paneId, status: "busy" });
    const workspace = await createWorkspace(db, {
      agent,
      workstream: "test",
      projectRoot,
      backend: "git",
    });
    addTask(db, {
      localId: task,
      workstream: "test",
      title: task,
      impact: 50,
      effortDays: 1,
    });
    await claimTask(db, task, { agentName: agent, workstream: "test" });
    return workspace;
  }

  async function closeAndWait(firingTask: string, otherTask: string): Promise<WaitJsonPayload> {
    closeTask(db, firingTask, { workstream: "test", evidence: "done" });
    closeTask(db, otherTask, { workstream: "test", evidence: "done" });
    const r = await runCli(
      ["task", "wait", firingTask, otherTask, "-w", "test", "--first", "--json"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    return JSON.parse(r.stdout) as WaitJsonPayload;
  }

  it("pins the committer's exact sha instead of shelling out to git log -1", async () => {
    const committer = await seedWorker("committer", "%1", "commit_task");
    await seedWorker("noncommitter", "%2", "other_task");
    const sha = commitFile(committer.path, "commit.txt", "committed\n", "worker commit");

    const payload = await closeAndWait("commit_task", "other_task");

    expect(payload.nextSteps[0]).toEqual({
      intent: "Cherry-pick committer's commit onto your branch",
      command: `git cherry-pick ${sha}`,
    });
    expect(payload.nextSteps[0]?.command).not.toContain("$(");
    expect(payload.nextSteps[0]?.command).not.toContain("git log -1");
  });

  it("surfaces a manual rescue step when the worker closed without committing", async () => {
    const noncommitter = await seedWorker("noncommitter", "%2", "no_commit_task");
    await seedWorker("committer", "%1", "other_task");
    writeFileSync(join(noncommitter.path, "dirty.txt"), "uncommitted\n");

    const payload = await closeAndWait("no_commit_task", "other_task");

    expect(payload.nextSteps[0]?.intent).toMatch(/closed without committing/i);
    expect(payload.nextSteps[0]?.command).not.toContain("git cherry-pick");
    expect(payload.nextSteps[0]?.command).toContain("git status");
  });

  it("pins an oldest-through-tip range when the worker produced multiple commits", async () => {
    const multicommitter = await seedWorker("multicommitter", "%3", "multi_commit_task");
    await seedWorker("noncommitter", "%2", "other_task");
    const first = commitFile(multicommitter.path, "one.txt", "one\n", "first worker commit");
    const last = commitFile(multicommitter.path, "two.txt", "two\n", "second worker commit");

    const payload = await closeAndWait("multi_commit_task", "other_task");

    expect(payload.nextSteps[0]).toEqual({
      intent: "Cherry-pick multicommitter's 2 commits onto your branch",
      command: `git cherry-pick ${first}^..${last}`,
    });
    expect(payload.nextSteps[0]?.command).not.toContain("$(");
    expect(payload.nextSteps[0]?.command).not.toContain("git log -1");
  });
});
