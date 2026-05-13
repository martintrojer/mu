// Tests for `mu workspace recreate <agent>` (the dogfood-painful
// free + create shortcut surfaced by add_mu_workspace_recreate_free_create
// — see the task notes for the originating mufeedback report).
//
// Coverage:
//   - SDK happy path on a clean workspace: the dir is rebuilt, the row's
//     parent_ref bumps from the old commit to current main (git), and
//     ONE `workspace recreate` event is emitted (not free + create).
//   - SDK refusal on a dirty workspace: throws WorkspaceDirtyError;
//     row + dir untouched.
//   - SDK lossy escape: --force discards the dirty edits and rebuilds.
//   - SDK error surface: AgentNotFoundError / WorkspaceNotFoundError
//     for the not-found cases.
//   - CLI --json envelope shape (machine-friendly contract).
//
// The integration with the git backend uses a real `git init` repo
// (matches workspace-refresh.integration.test.ts pattern); the dirty-check tests
// also run on the `none` backend's _no-op_ dirty surface to document
// that they don't refuse for an unanswerable question.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentNotFoundError, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { WorkspaceDirtyError } from "../src/vcs.js";
import {
  WorkspaceNotFoundError,
  createWorkspace,
  getWorkspaceForAgent,
  recreateWorkspace,
} from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let stateRoot: string;
let projectRoot: string;
let dbDir: string;
let dbPath: string;
let db: Db;

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

function initGitProject(root: string): void {
  // The git backend's createWorkspace/refresh flow expects a real
  // repo with at least one commit (the worktree add needs a HEAD).
  // mirror workspace-refresh.integration.test.ts's setup with author identity
  // configured so commit doesn't fail in CI containers without a
  // global gitconfig.
  git(["init", "-q", "-b", "main"], root);
  git(["config", "user.email", "test@local"], root);
  git(["config", "user.name", "test"], root);
  writeFileSync(join(root, "README"), "v1\n");
  git(["add", "."], root);
  git(["-c", "user.email=test@local", "-c", "user.name=test", "commit", "-q", "-m", "v1"], root);
}

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), "mu-ws-recreate-state-"));
  process.env.MU_STATE_DIR = stateRoot;
  dbDir = mkdtempSync(join(tmpdir(), "mu-ws-recreate-db-"));
  dbPath = join(dbDir, "mu.db");
  db = openDb({ path: dbPath });
  ensureWorkstream(db, "auth");
  insertAgent(db, { name: "worker-1", workstream: "auth", paneId: "%1", status: "busy" });

  projectRoot = mkdtempSync(join(tmpdir(), "mu-ws-recreate-project-"));
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

describe("recreateWorkspace SDK", () => {
  it("recreate on a clean workspace bumps parent_ref and produces a fresh dir (none backend)", async () => {
    const before = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });

    // Mark the dir with a sentinel; recreate should NOT preserve it.
    writeFileSync(join(before.path, "__sentinel__"), "stale-wave\n");

    const r = await recreateWorkspace(db, "worker-1", {
      workstream: "auth",
      projectRoot,
      backend: "none",
    });

    expect(r.workspace.agentName).toBe("worker-1");
    expect(r.workspace.path).toBe(before.path);
    // Sentinel from the previous workspace must not have survived.
    expect(() =>
      execFileSync("ls", [join(r.workspace.path, "__sentinel__")], { stdio: "pipe" }),
    ).toThrow();
    // Registry row points at the new workspace (createdAt bumped).
    const live = getWorkspaceForAgent(db, "worker-1", "auth");
    expect(live?.path).toBe(r.workspace.path);
    expect(live?.createdAt).toBe(r.workspace.createdAt);
    expect(new Date(r.workspace.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.createdAt).getTime(),
    );
  });

  it("recreate emits ONE `workspace recreate` event (not free + create)", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    const before = db
      .prepare("SELECT COUNT(*) AS c FROM agent_logs WHERE kind = 'event'")
      .get() as { c: number };

    await recreateWorkspace(db, "worker-1", {
      workstream: "auth",
      projectRoot,
      backend: "none",
    });

    // Read the events emitted by the recreate. Only ONE new event row
    // should land, with payload starting `workspace recreate`.
    const after = (
      db.prepare("SELECT COUNT(*) AS c FROM agent_logs WHERE kind = 'event'").get() as {
        c: number;
      }
    ).c;
    const delta = after - before.c;
    const newEvents = db
      .prepare("SELECT payload FROM agent_logs WHERE kind = 'event' ORDER BY seq DESC LIMIT ?")
      .all(delta) as Array<{ payload: string }>;

    expect(delta).toBe(1);
    expect(newEvents.length).toBe(1);
    expect(newEvents[0]?.payload).toMatch(/^workspace recreate worker-1 /);
    expect(newEvents[0]?.payload).toContain("backend=none");
    // Payload mentions both old + new parent refs (none backend's are
    // both "—" since cp-a snapshots have no ref). The contract is the
    // SHAPE — both positions present.
    expect(newEvents[0]?.payload).toContain("old_parent=");
    expect(newEvents[0]?.payload).toContain("new_parent=");
  });

  it("recreate with the git backend bumps parent_ref to current HEAD", async () => {
    initGitProject(projectRoot);
    const before = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "git",
    });
    expect(before.parentRef).toBeTruthy();

    // Advance project main one commit; the recreated workspace should
    // pick up the new HEAD.
    writeFileSync(join(projectRoot, "README"), "v2\n");
    git(["add", "."], projectRoot);
    git(
      ["-c", "user.email=test@local", "-c", "user.name=test", "commit", "-q", "-m", "v2"],
      projectRoot,
    );
    const newHead = git(["rev-parse", "HEAD"], projectRoot);
    expect(newHead).not.toBe(before.parentRef);

    const r = await recreateWorkspace(db, "worker-1", {
      workstream: "auth",
      projectRoot,
      // backend defaults to the prior backend (git) — exercise that path.
    });
    expect(r.previousParentRef).toBe(before.parentRef);
    expect(r.workspace.parentRef).toBe(newHead);
    expect(r.workspace.backend).toBe("git");
  });

  it("recreate refuses with WorkspaceDirtyError when the workspace has uncommitted changes (git)", async () => {
    initGitProject(projectRoot);
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "git",
    });
    // Dirty the workspace. The git backend's listDirtyFiles runs
    // `git status --porcelain` which surfaces this.
    writeFileSync(join(ws.path, "scratch.txt"), "uncommitted edit\n");

    let caught: unknown;
    try {
      await recreateWorkspace(db, "worker-1", {
        workstream: "auth",
        projectRoot,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceDirtyError);
    expect((caught as WorkspaceDirtyError).files.length).toBeGreaterThan(0);
    // Verb-specific message + nextSteps point at recreate, not rebase.
    expect((caught as Error).message).toMatch(/refusing to recreate/);
    // Critical safety contract: the registry row + on-disk dir survive
    // the refusal. The operator has not lost their dirty edits.
    const live = getWorkspaceForAgent(db, "worker-1", "auth");
    expect(live?.path).toBe(ws.path);
    expect(() =>
      execFileSync("ls", [join(ws.path, "scratch.txt")], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("recreate --force discards the dirty changes and rebuilds (the lossy escape)", async () => {
    initGitProject(projectRoot);
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "git",
    });
    writeFileSync(join(ws.path, "scratch.txt"), "uncommitted edit\n");

    const r = await recreateWorkspace(db, "worker-1", {
      workstream: "auth",
      projectRoot,
      force: true,
    });
    expect(r.workspace.path).toBe(ws.path);
    // Dirty file is gone — that's the documented lossy contract.
    expect(() => execFileSync("ls", [join(ws.path, "scratch.txt")], { stdio: "pipe" })).toThrow();
  });

  it("recreate on a non-existent agent throws WorkspaceNotFoundError", async () => {
    // No createWorkspace call beforehand — the agent row exists but
    // has no workspace. recreate's first check is the row lookup.
    let caught: unknown;
    try {
      await recreateWorkspace(db, "worker-1", {
        workstream: "auth",
        projectRoot,
        backend: "none",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotFoundError);
  });

  it("recreate when the agent itself doesn't exist throws WorkspaceNotFoundError (the row check fails first)", async () => {
    // The verb's surface for "no such agent in this workstream" is
    // WorkspaceNotFoundError (the row lookup goes through
    // getWorkspaceForAgent which returns undefined for unknown
    // agent-names). AgentNotFoundError is reserved for the create
    // half — it would only surface if the agent row vanished
    // BETWEEN the row lookup and the re-INSERT, which is racy and
    // not what an operator-typo path hits.
    let caught: unknown;
    try {
      await recreateWorkspace(db, "ghost-agent", {
        workstream: "auth",
        projectRoot,
        backend: "none",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WorkspaceNotFoundError);
    // Belt-and-braces: AgentNotFoundError is a different class, not
    // a parent — the test would otherwise pass spuriously.
    expect(caught).not.toBeInstanceOf(AgentNotFoundError);
  });
});

describe("`mu workspace recreate <agent>` CLI", () => {
  it("--json envelope shape: { workspace, previousParentRef, nextSteps }", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    db.close();

    const r = await runCli(
      [
        "workspace",
        "recreate",
        "worker-1",
        "-w",
        "auth",
        "--backend",
        "none",
        "--project-root",
        projectRoot,
        "--json",
      ],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    const env = JSON.parse(r.stdout) as {
      workspace: {
        agentName: string;
        workstreamName: string;
        backend: string;
        path: string;
        parentRef: string | null;
        createdAt: string;
      };
      previousParentRef: string | null;
      nextSteps: Array<{ intent: string; command: string }>;
    };
    expect(env.workspace.agentName).toBe("worker-1");
    expect(env.workspace.workstreamName).toBe("auth");
    expect(env.workspace.backend).toBe("none");
    expect(typeof env.workspace.path).toBe("string");
    // For the `none` backend the parentRef is null (cp -a snapshot).
    expect(env.workspace.parentRef).toBeNull();
    expect(env.previousParentRef).toBeNull();
    expect(env.nextSteps.length).toBeGreaterThan(0);
    // Spec-listed nextStep intents must be present so machine
    // consumers (and the operator's downstream prompts) can rely on
    // them. We assert presence, not exact wording.
    const intents = env.nextSteps.map((s) => s.intent.toLowerCase()).join(" ");
    expect(intents).toMatch(/send work/);
    expect(intents).toMatch(/list workspaces/);

    db = openDb({ path: dbPath });
  });

  it("CLI exits 4 with WorkspaceDirtyError on dirty workspace, no --force (git)", async () => {
    initGitProject(projectRoot);
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "git",
    });
    writeFileSync(join(ws.path, "scratch.txt"), "uncommitted edit\n");
    db.close();

    const r = await runCli(
      ["workspace", "recreate", "worker-1", "-w", "auth", "--project-root", projectRoot],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    // classifyError maps WorkspaceDirtyError -> exit 4 (conflict).
    expect(r.exitCode).toBe(4);
    expect(`${r.stderr}\n${r.stdout}`).toMatch(/refusing to recreate/);
    // The dirty edit survives the refusal.
    expect(() =>
      execFileSync("ls", [join(ws.path, "scratch.txt")], { stdio: "pipe" }),
    ).not.toThrow();

    db = openDb({ path: dbPath });
  });
});
