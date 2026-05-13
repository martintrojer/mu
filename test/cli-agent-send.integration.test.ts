// CLI-level tests for `mu agent send` warning/refusing on stale workspaces.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { gitBackend } from "../src/vcs.js";
import { createWorkspace } from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let tempDir: string;
let dbPath: string;
let db: Db;
let calls: readonly string[][];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-send-stale-"));
  process.env.MU_STATE_DIR = join(tempDir, "state");
  dbPath = join(tempDir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });
  const seen: string[][] = [];
  calls = seen;
  setSleepForTests(async () => {});
  setTmuxExecutor(async (args) => {
    seen.push([...args]);
    return { stdout: "", stderr: "", exitCode: 0 };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    db.close();
  } catch {}
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
  resetSleep();
  const key = "MU_STATE_DIR";
  delete process.env[key];
});

async function fakeWorkspaceBehind(behind: number): Promise<void> {
  const projectRoot = mkdtempSync(join(tempDir, "project-"));
  writeFileSync(join(projectRoot, "README"), "x\n");
  const row = await createWorkspace(db, {
    agent: "worker-1",
    workstream: "auth",
    projectRoot,
    backend: "none",
  });
  db.prepare("UPDATE vcs_workspaces SET backend = 'git', parent_ref = ? WHERE path = ?").run(
    "parent-worker-1",
    row.path,
  );
  vi.spyOn(gitBackend, "commitsBehind").mockImplementation(async () => behind);
}

describe("mu agent send workspace staleness", () => {
  it("warns on a stale workspace, appends refresh nextStep, and still sends by default", async () => {
    await fakeWorkspaceBehind(12);
    const { exitCode, stdout, stderr, error } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).toContain("WARN: worker-1 workspace is 12 commits behind main");
    expect(stdout).toContain("mu workspace refresh worker-1 -w auth");
    expect(calls.map((c) => c[0])).toEqual([
      "copy-mode",
      "set-buffer",
      "paste-buffer",
      "send-keys",
    ]);
  });

  it("includes staleness in JSON output", async () => {
    await fakeWorkspaceBehind(10);
    const { exitCode, stdout, stderr, error } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).toContain("WARN: worker-1 workspace is 10 commits behind main");
    const out = JSON.parse(stdout) as {
      staleness: {
        agentName: string;
        workstreamName: string;
        commitsBehindMain: number | null;
        isStale: boolean;
      };
      nextSteps: { command: string }[];
    };
    expect(out.staleness).toEqual({
      agentName: "worker-1",
      workstreamName: "auth",
      commitsBehindMain: 10,
      isStale: true,
    });
    expect(out.nextSteps.some((s) => s.command === "mu workspace refresh worker-1 -w auth")).toBe(
      true,
    );
  });

  it("--strict-staleness refuses without sending", async () => {
    await fakeWorkspaceBehind(14);
    const { exitCode, stderr, error } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--strict-staleness", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr) as {
      error: string;
      message: string;
      nextSteps: { command: string }[];
    };
    expect(env.error).toBe("TaskClaimStaleWorkspaceError");
    expect(env.message).toContain("14 commits behind main");
    expect(env.nextSteps[0]?.command).toBe("mu workspace refresh worker-1 -w auth");
    expect(calls).toEqual([]);
  });

  it("skips agents without a workspace", async () => {
    const { exitCode, stdout, stderr, error } = await runCli(
      ["agent", "send", "worker-1", "hello", "-w", "auth", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).toBe("");
    const out = JSON.parse(stdout) as { staleness: null };
    expect(out.staleness).toBeNull();
    expect(calls.map((c) => c[0])).toEqual([
      "copy-mode",
      "set-buffer",
      "paste-buffer",
      "send-keys",
    ]);
  });
});
