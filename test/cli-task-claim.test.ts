// CLI-level tests for `mu task claim --for` accepting a qualified
// cross-workstream ref (`task_claim_for_cross_workstream`).
//
// Per-workstream pools of free workers exist; the orchestrator
// routinely has worker-1 free in workstream A and a queued task in
// workstream B. The bare `--for worker-1` form requires the worker to
// live in the task's workstream. The qualified `--for B/worker-1`
// form (NEW) dispatches across the workstream boundary: the agent
// stays in B, but `tasks.owner_id` on A's task points at B's agent.
//
// Surface assertions:
//   - cross-ws --for: claim succeeds; tasks.owner_id is set; both
//     the task's workstream and the agent's workstream stay correct.
//   - bare --for: today's behaviour (agent must live in the task's
//     workstream) is unchanged.
//   - cross-ws --for to a missing agent in the named workstream:
//     AgentNotFoundError; nothing committed.
//   - cross-ws --for to a non-existent workstream:
//     WorkstreamNotFoundError; nothing committed.
//
// Real SQLite (in-temp-dir), no tmux. Drives the CLI in-process via
// runCli so the assertions cover the whole verb pipeline.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { addTask, getTask } from "../src/tasks.js";
import { gitBackend } from "../src/vcs.js";
import { createWorkspace } from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

describe("mu task claim --for: cross-workstream qualified ref", () => {
  let tempDir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-claim-x-"));
    process.env.MU_STATE_DIR = join(tempDir, "state");
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
    ensureWorkstream(db, "wsa");
    ensureWorkstream(db, "wsb");
    // Task lives in wsa; worker lives in wsb. The dispatch crosses
    // the boundary.
    addTask(db, { localId: "foo", workstream: "wsa", title: "Foo", impact: 50, effortDays: 1 });
    insertAgent(db, { name: "worker-1", workstream: "wsb", paneId: "%1", status: "busy" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
    const key = "MU_STATE_DIR";
    delete process.env[key];
  });

  async function fakeWorkspaceBehind(
    agent: string,
    workstream: string,
    behind: number,
  ): Promise<void> {
    const projectRoot = mkdtempSync(join(tempDir, "project-"));
    writeFileSync(join(projectRoot, "README"), "x\n");
    const row = await createWorkspace(db, { agent, workstream, projectRoot, backend: "none" });
    db.prepare("UPDATE vcs_workspaces SET backend = 'git', parent_ref = ? WHERE path = ?").run(
      `parent-${agent}`,
      row.path,
    );
    vi.spyOn(gitBackend, "commitsBehind").mockImplementation(async () => behind);
  }

  it("--for <ws>/<name> dispatches across workstreams; owner set", async () => {
    const { exitCode, stdout, stderr, error } = await runCli(
      ["task", "claim", "foo", "-w", "wsa", "--for", "wsb/worker-1", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stderr).toBe("");
    expect(exitCode).toBeNull();
    const out = JSON.parse(stdout);
    expect(out.ownerName).toBe("worker-1");
    expect(out.previousStatus).toBe("OPEN");
    expect(out.status).toBe("IN_PROGRESS");
    // Task stays in wsa; only the FK to the agent crosses.
    const task = getTask(db, "foo", "wsa");
    expect(task?.ownerName).toBe("worker-1");
    expect(task?.workstreamName).toBe("wsa");
    expect(task?.status).toBe("IN_PROGRESS");
    // Agent untouched in wsb.
    const agentRow = db
      .prepare(
        "SELECT ws.name AS ws FROM agents a JOIN workstreams ws ON ws.id = a.workstream_id WHERE a.name = ?",
      )
      .get("worker-1") as { ws: string } | undefined;
    expect(agentRow?.ws).toBe("wsb");
  });

  it("bare --for keeps today's same-workstream resolution (agent must live in task's ws)", async () => {
    // worker-1 is in wsb; bare --for searches wsa → ClaimerNotRegisteredError.
    const { exitCode, stderr, error } = await runCli(
      ["task", "claim", "foo", "-w", "wsa", "--for", "worker-1"],
      dbPath,
    );
    expect(error).toBeUndefined();
    // ClaimerNotRegisteredError → exit 4 (conflict) per cli classifyError.
    expect(exitCode).toBe(4);
    expect(stderr).toContain("worker-1");
    expect(stderr).toContain("not a registered mu agent");
    // Task untouched.
    expect(getTask(db, "foo", "wsa")?.ownerName).toBeNull();
    expect(getTask(db, "foo", "wsa")?.status).toBe("OPEN");
  });

  it("bare --for to an agent in the SAME workstream still works (regression guard)", async () => {
    // Add a worker-2 in wsa; bare --for resolves there.
    insertAgent(db, { name: "worker-2", workstream: "wsa", paneId: "%2", status: "busy" });
    const { exitCode, stderr, error } = await runCli(
      ["task", "claim", "foo", "-w", "wsa", "--for", "worker-2", "--json"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(stderr).toBe("");
    expect(exitCode).toBeNull();
    expect(getTask(db, "foo", "wsa")?.ownerName).toBe("worker-2");
  });

  it("--for <ws>/<name> with non-existent agent in named ws → AgentNotFoundError, nothing committed", async () => {
    const { exitCode, stderr, error } = await runCli(
      ["task", "claim", "foo", "-w", "wsa", "--for", "wsb/ghost"],
      dbPath,
    );
    expect(error).toBeUndefined();
    // AgentNotFoundError → exit 3 (not found).
    expect(exitCode).toBe(3);
    expect(stderr).toContain("ghost");
    // Message is enriched with `(in workstream wsb)` per AgentNotFoundError.
    expect(stderr).toContain("wsb");
    // Task untouched.
    expect(getTask(db, "foo", "wsa")?.ownerName).toBeNull();
    expect(getTask(db, "foo", "wsa")?.status).toBe("OPEN");
  });

  it("--for <ws>/<name> with non-existent workstream → WorkstreamNotFoundError, nothing committed", async () => {
    const { exitCode, stderr, error } = await runCli(
      ["task", "claim", "foo", "-w", "wsa", "--for", "ghostws/worker-1"],
      dbPath,
    );
    expect(error).toBeUndefined();
    // WorkstreamNotFoundError → exit 3 (not found) per cli classifyError.
    expect(exitCode).toBe(3);
    expect(stderr).toContain("ghostws");
    // Task untouched.
    expect(getTask(db, "foo", "wsa")?.ownerName).toBeNull();
    expect(getTask(db, "foo", "wsa")?.status).toBe("OPEN");
  });

  it("warns on stale --for workspace, appends refresh nextStep, and still claims by default", async () => {
    await fakeWorkspaceBehind("worker-1", "wsb", 12);
    const { exitCode, stdout, stderr, error } = await runCli(
      ["task", "claim", "foo", "-w", "wsa", "--for", "wsb/worker-1"],
      dbPath,
    );
    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).toContain("WARN: worker-1 workspace is 12 commits behind main");
    expect(stdout).toContain("mu workspace refresh worker-1 -w wsb");
    expect(getTask(db, "foo", "wsa")?.ownerName).toBe("worker-1");
    expect(getTask(db, "foo", "wsa")?.status).toBe("IN_PROGRESS");
  });

  it("includes staleness in JSON output", async () => {
    await fakeWorkspaceBehind("worker-1", "wsb", 10);
    const { exitCode, stdout, stderr, error } = await runCli(
      ["task", "claim", "foo", "-w", "wsa", "--for", "wsb/worker-1", "--json"],
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
      workstreamName: "wsb",
      commitsBehindMain: 10,
      isStale: true,
    });
    expect(out.nextSteps.some((s) => s.command === "mu workspace refresh worker-1 -w wsb")).toBe(
      true,
    );
  });

  it("--strict-staleness refuses stale --for workspace without claiming", async () => {
    await fakeWorkspaceBehind("worker-1", "wsb", 14);
    const { exitCode, stderr, error } = await runCli(
      [
        "task",
        "claim",
        "foo",
        "-w",
        "wsa",
        "--for",
        "wsb/worker-1",
        "--strict-staleness",
        "--json",
      ],
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
    expect(env.nextSteps[0]?.command).toBe("mu workspace refresh worker-1 -w wsb");
    expect(getTask(db, "foo", "wsa")?.ownerName).toBeNull();
    expect(getTask(db, "foo", "wsa")?.status).toBe("OPEN");
  });
});
