// CLI tests for `mu task close` success-path Next: hints.
//
// fb_close_post_emit_commit_hint: when a worker closes a task from a
// dirty per-agent workspace, the close succeeds AND the Next: block
// reminds them to commit before the orchestrator starts the next wave.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertAgent } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { addTask } from "../src/tasks.js";
import { type WorkspaceRow, createWorkspace } from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { withEnv } from "./_env.js";
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

interface JsonClosePayload {
  nextSteps: { intent: string; command: string }[];
}

function initGitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "hello\n");
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: root,
  });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], {
    cwd: root,
  });
}

gitDescribe("mu task close dirty-workspace commit hint", () => {
  let tempDir: string;
  let stateRoot: string;
  let dbPath: string;
  let projectRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-close-"));
    stateRoot = join(tempDir, "state");
    dbPath = join(tempDir, "mu.db");
    projectRoot = join(tempDir, "project");
    process.env.MU_STATE_DIR = stateRoot;
    initGitRepo(projectRoot);
  });

  afterEach(() => {
    const key = "MU_STATE_DIR";
    delete process.env[key];
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function seedDb(opts: { withWorkspace: boolean }): Promise<WorkspaceRow | undefined> {
    const db = openDb({ path: dbPath });
    ensureWorkstream(db, "test");
    insertAgent(db, { name: "worker-1", workstream: "test", paneId: "%1", status: "busy" });
    addTask(db, {
      localId: "dirty_human",
      workstream: "test",
      title: "Implement Helpful Thing",
      impact: 50,
      effortDays: 1,
    });
    addTask(db, {
      localId: "dirty_json",
      workstream: "test",
      title: "Emit JSON Hint",
      impact: 50,
      effortDays: 1,
    });
    let workspace: WorkspaceRow | undefined;
    if (opts.withWorkspace) {
      workspace = await createWorkspace(db, {
        agent: "worker-1",
        workstream: "test",
        projectRoot,
        backend: "git",
      });
    }
    db.close();
    return workspace;
  }

  it("adds the commit hint to human stdout and --json nextSteps when the actor's workspace is dirty", async () => {
    const workspace = await seedDb({ withWorkspace: true });
    expect(workspace).toBeDefined();
    if (workspace === undefined) return;
    writeFileSync(join(workspace.path, "dirty.txt"), "remember to commit me\n");

    await withEnv("MU_AGENT_NAME", "worker-1", async () => {
      const human = await runCli(["task", "close", "dirty_human", "-w", "test"], dbPath);
      expect(human.error).toBeUndefined();
      expect(human.exitCode).toBeNull();
      expect(human.stdout).toContain("Don't forget to commit");
      expect(human.stdout).toContain(
        "cd $(mu workspace path worker-1 -w test) && git commit -am 'Implement Helpful Thing'",
      );

      const json = await runCli(["task", "close", "dirty_json", "-w", "test", "--json"], dbPath);
      expect(json.error).toBeUndefined();
      expect(json.exitCode).toBeNull();
      const payload = JSON.parse(json.stdout) as JsonClosePayload;
      expect(payload.nextSteps).toContainEqual({
        intent: "Don't forget to commit",
        command: "cd $(mu workspace path worker-1 -w test) && git commit -am 'Emit JSON Hint'",
      });
    });
  });

  it("does not add the commit hint when the actor's workspace is clean", async () => {
    await seedDb({ withWorkspace: true });

    await withEnv("MU_AGENT_NAME", "worker-1", async () => {
      const json = await runCli(["task", "close", "dirty_json", "-w", "test", "--json"], dbPath);
      expect(json.error).toBeUndefined();
      const payload = JSON.parse(json.stdout) as JsonClosePayload;
      expect(payload.nextSteps.map((s) => s.intent)).not.toContain("Don't forget to commit");
      expect(json.stdout).not.toContain("git commit -am");
    });
  });

  it("does not add the commit hint when the actor has no workspace", async () => {
    await seedDb({ withWorkspace: false });

    await withEnv("MU_AGENT_NAME", "worker-1", async () => {
      const json = await runCli(["task", "close", "dirty_json", "-w", "test", "--json"], dbPath);
      expect(json.error).toBeUndefined();
      const payload = JSON.parse(json.stdout) as JsonClosePayload;
      expect(payload.nextSteps.map((s) => s.intent)).not.toContain("Don't forget to commit");
      expect(json.stdout).not.toContain("git commit -am");
    });
  });
});
