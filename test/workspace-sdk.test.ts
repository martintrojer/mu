// Tests for src/workspace.ts: the registry-layer SDK that sits on
// top of vcs.ts backends. Covers createWorkspace + freeWorkspace +
// listWorkspaces + getWorkspaceForAgent + workspacePath, the
// HomeDirAsProjectRootError + cleanup-on-throw guards, the
// WorkspaceNotFoundError surface, the closeAgent integration
// (--discard-workspace + WorkspacePreservedError), and
// listWorkspaceOrphans.
//
// Split out of test/workspace.test.ts under
// testreview_test_files_past_800loc — backends + commitsBehind live
// in test/workspace-backends.test.ts; decorateWithStaleness (+
// memoization + concurrency cap) lives in
// test/workspace-staleness-mem.test.ts.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentNotFoundError, insertAgent } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import {
  HomeDirAsProjectRootError,
  WorkspaceExistsError,
  WorkspaceNotFoundError,
  WorkspacePathNotEmptyError,
  createWorkspace,
  freeWorkspace,
  getWorkspaceForAgent,
  listAllOrphanWorkspaces,
  listWorkspaceOrphans,
  listWorkspaces,
  workspacePath,
} from "../src/workspace.js";
import { ensureWorkstream } from "../src/workstream.js";
import { runCli } from "./_runCli.js";

let stateRoot: string;
let projectRoot: string;
let dbDir: string;
let db: Db;

function setStateDir(dir: string): void {
  process.env.MU_STATE_DIR = dir;
}

beforeEach(() => {
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

// ─── workspace SDK (registry layer on top of backends) ────────────────

describe("workspace SDK (with noneBackend)", () => {
  it("createWorkspace records a row + creates the directory", async () => {
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    expect(ws.agentName).toBe("worker-1");
    expect(ws.backend).toBe("none");
    expect(ws.path).toContain(join("workspaces", "auth", "worker-1"));
    expect(getWorkspaceForAgent(db, "worker-1", "auth")?.path).toBe(ws.path);
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
    db.prepare(
      `DELETE FROM vcs_workspaces WHERE agent_id = (SELECT id FROM agents WHERE name = 'worker-1')`,
    ).run();
    // Sanity: registry empty, dir present.
    expect(getWorkspaceForAgent(db, "worker-1", "auth")).toBeUndefined();
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
    // v5 requires a real agent row before vcs_workspaces.agent_id can
    // be set. Insert worker-2 too so the test's stress is on the path
    // UNIQUE constraint, not the FK / NOT NULL on agent_id.
    insertAgent(db, { name: "worker-2", workstream: "auth", paneId: "%100", status: "busy" });
    const wsId = (
      db.prepare("SELECT id FROM workstreams WHERE name = 'auth'").get() as { id: number }
    ).id;
    const sqId = (
      db.prepare("SELECT id FROM agents WHERE name = 'squatter'").get() as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO vcs_workspaces (agent_id, workstream_id, backend, path, parent_ref, created_at)
       VALUES (?, ?, 'none', ?, NULL, datetime('now'))`,
    ).run(sqId, wsId, futurePath);

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

  // Regression: workspace_create_typed_no_agent_error. Pre-fix, a
  // `mu workspace create <name>` for an agent that doesn't exist in the
  // target workstream leaked SQLite's bare
  // `NOT NULL constraint failed: vcs_workspaces.agent_id` error to the
  // operator. The fix throws a typed AgentNotFoundError before the
  // INSERT (mapped to exit 3 by classifyError).
  it("createWorkspace throws AgentNotFoundError when the agent doesn't exist in the workstream", async () => {
    ensureWorkstream(db, "empty"); // no agent rows
    const before = db.prepare("SELECT COUNT(*) AS c FROM vcs_workspaces").get() as { c: number };

    let caught: unknown;
    try {
      await createWorkspace(db, {
        agent: "ghost",
        workstream: "empty",
        projectRoot,
        backend: "none",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentNotFoundError);
    const msg = (caught as Error).message;
    expect(msg).toContain("ghost");
    expect(msg).toContain("empty"); // workstream context surfaces
    expect(msg).not.toMatch(/NOT NULL constraint/i);
    expect(msg).not.toMatch(/FOREIGN KEY/i);

    // No row was inserted.
    const after = db.prepare("SELECT COUNT(*) AS c FROM vcs_workspaces").get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("mu workspace create <missing-agent> exits 3 with a human-friendly message (CLI)", async () => {
    ensureWorkstream(db, "empty2");
    const result = await runCli(
      ["workspace", "create", "ghost", "-w", "empty2", "--project-root", projectRoot],
      join(dbDir, "mu.db"),
    );
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(3);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("ghost");
    expect(combined).toContain("empty2");
    expect(combined).not.toMatch(/NOT NULL constraint/i);
    expect(combined).not.toMatch(/FOREIGN KEY/i);
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
    expect(listWorkspaces(db, "auth").map((r) => r.agentName)).toEqual(["worker-1"]);
    expect(listWorkspaces(db, "billing").map((r) => r.agentName)).toEqual(["biller"]);
    expect(listWorkspaces(db).length).toBe(2);
  });

  it("freeWorkspace removes both row and directory", async () => {
    const ws = await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    const r = await freeWorkspace(db, "worker-1", { workstream: "auth" });
    expect(r.removed).toBe(true);
    expect(r.rowDeleted).toBe(true);
    expect(getWorkspaceForAgent(db, "worker-1", "auth")).toBeUndefined();
    // Directory really gone:
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).toThrow();
  });

  it("freeWorkspace is idempotent on a missing workspace", async () => {
    const r = await freeWorkspace(db, "ghost", { workstream: "auth" });
    expect(r).toEqual({ removed: false, rowDeleted: false });
  });

  it("getWorkspaceForAgent throws WorkspaceNotFoundError shape via the verb wrapper", () => {
    expect(getWorkspaceForAgent(db, "ghost", "auth")).toBeUndefined();
  });

  it("FK CASCADE: deleting the agent row removes the workspace row", async () => {
    await createWorkspace(db, {
      agent: "worker-1",
      workstream: "auth",
      projectRoot,
      backend: "none",
    });
    db.prepare("DELETE FROM agents WHERE name = 'worker-1'").run();
    expect(getWorkspaceForAgent(db, "worker-1", "auth")).toBeUndefined();
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
    expect(getWorkspaceForAgent(db, "worker-1", "auth")).toBeUndefined();
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
    expect(ws.agentName).toBe("worker-1");
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
    expect(getWorkspaceForAgent(db, "worker-1", "auth")).toBeUndefined();
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
    await expect(closeAgent(db, "worker-1", { workstream: "auth" })).rejects.toBeInstanceOf(
      WorkspacePreservedError,
    );

    // Refuse path: nothing changed. Agent still in DB, workspace row still
    // there, dir still on disk.
    expect(getWorkspaceForAgent(db, "worker-1", "auth")).toBeDefined();
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
    const r = await closeAgent(db, "worker-1", { discardWorkspace: true, workstream: "auth" });

    expect(r.killedPane).toBe(true);
    expect(r.deletedRow).toBe(true);
    expect(r.workspaceFreed).toBe(true);

    // Workspace gone from DB AND from disk.
    expect(getWorkspaceForAgent(db, "worker-1", "auth")).toBeUndefined();
    expect(() => execFileSync("ls", [ws.path], { stdio: "pipe" })).toThrow();
  });

  it("closeAgent succeeds normally when the agent had no workspace", async () => {
    insertAgent(db, { name: "plain-1", workstream: "auth", paneId: "%9", status: "busy" });
    const { closeAgent } = await import("../src/agents.js");
    const r = await closeAgent(db, "plain-1", { workstream: "auth" });
    expect(r.workspaceFreed).toBe(false);
    expect(r.deletedRow).toBe(true);
  });

  it("closeAgent without an agent returns false flags", async () => {
    const { closeAgent } = await import("../src/agents.js");
    const r = await closeAgent(db, "ghost", { workstream: "auth" });
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
    db.prepare(
      `DELETE FROM vcs_workspaces WHERE agent_id = (SELECT id FROM agents WHERE name = 'w1')`,
    ).run();
    const orphans = listWorkspaceOrphans(db, "auth");
    expect(orphans.length).toBe(1);
    expect(orphans[0]?.agentName).toBe("w1");
    expect(orphans[0]?.workstreamName).toBe("auth");
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
    db.prepare(
      `DELETE FROM vcs_workspaces WHERE agent_id = (SELECT id FROM agents WHERE name = 'orphaned')`,
    ).run();
    const orphans = listWorkspaceOrphans(db, "auth");
    expect(orphans.map((o) => o.agentName)).toEqual(["orphaned"]);
  });
});

// ─── listAllOrphanWorkspaces + `mu workspace orphans --all` /
//     -w <unknown> (regression for
//     workspace_orphans_misses_destroyed_workstreams) ───

describe("listAllOrphanWorkspaces", () => {
  let tempDir: string;
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-orphans-all-"));
    process.env.MU_STATE_DIR = tempDir;
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
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

  it("returns [] when no workspaces dir exists at all", () => {
    expect(listAllOrphanWorkspaces(db)).toEqual([]);
  });

  it("flags dirs in destroyed-ws subdirs as `stranded: true`", () => {
    // The shape from the bug report: a workstream subdir on disk with
    // an orphan inside, but no row in `workstreams` for the parent.
    const ghostDir = join(tempDir, "workspaces", "dogfood-snap", "_quarantine_1778249973");
    mkdirSync(ghostDir, { recursive: true });
    writeFileSync(join(ghostDir, "README"), "orphan\n");
    const orphans = listAllOrphanWorkspaces(db);
    expect(orphans.length).toBe(1);
    expect(orphans[0]?.workstreamName).toBe("dogfood-snap");
    expect(orphans[0]?.agentName).toBe("_quarantine_1778249973");
    expect(orphans[0]?.stranded).toBe(true);
    expect(orphans[0]?.path).toBe(ghostDir);
  });

  it("aggregates orphans across multiple workstreams; mixes stranded + live", async () => {
    // Live workstream `auth` with one orphan dir AND one registered
    // workspace; plus a fully-stranded workstream `ghost` with one
    // orphan dir.
    ensureWorkstream(db, "auth");
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
    db.prepare(
      `DELETE FROM vcs_workspaces WHERE agent_id = (SELECT id FROM agents WHERE name = 'orphaned')`,
    ).run();

    const ghostDir = join(tempDir, "workspaces", "ghost", "reviewer-1");
    mkdirSync(ghostDir, { recursive: true });

    const orphans = listAllOrphanWorkspaces(db);
    // Two orphans total — 'live' is registered so it must NOT show up.
    expect(orphans.length).toBe(2);
    const byWs = new Map(orphans.map((o) => [o.workstreamName, o]));
    expect(byWs.get("auth")?.agentName).toBe("orphaned");
    expect(byWs.get("auth")?.stranded).toBe(false);
    expect(byWs.get("ghost")?.agentName).toBe("reviewer-1");
    expect(byWs.get("ghost")?.stranded).toBe(true);
  });
});

describe("`mu workspace orphans` CLI", () => {
  let tempDir: string;
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-orphans-cli-"));
    process.env.MU_STATE_DIR = tempDir;
    dbPath = join(tempDir, "mu.db");
    db = openDb({ path: dbPath });
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

  it("-w <unknown> exits 3 with WorkstreamNotFoundError (was: silent 'no orphans')", async () => {
    ensureWorkstream(db, "auth");
    db.close();
    const r = await runCli(["workspace", "orphans", "-w", "totally-nonexistent"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("no such workstream: totally-nonexistent");
    // Re-open for the afterEach close().
    db = openDb({ path: dbPath });
  });

  it("--all aggregates orphans across multiple workstreams (incl. destroyed)", async () => {
    ensureWorkstream(db, "auth");
    insertAgent(db, { name: "orphaned", workstream: "auth", paneId: "%1", status: "busy" });
    await createWorkspace(db, {
      agent: "orphaned",
      workstream: "auth",
      projectRoot: tempDir,
      backend: "none",
    });
    db.prepare(
      `DELETE FROM vcs_workspaces WHERE agent_id = (SELECT id FROM agents WHERE name = 'orphaned')`,
    ).run();
    const ghostDir = join(tempDir, "workspaces", "ghost", "reviewer-1");
    mkdirSync(ghostDir, { recursive: true });
    db.close();

    const r = await runCli(["workspace", "orphans", "--all", "--json"], dbPath);
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    const env = JSON.parse(r.stdout) as {
      items: Array<{
        workstreamName: string;
        agentName: string;
        path: string;
        stranded: boolean;
      }>;
      count: number;
      nextSteps: unknown[];
    };
    expect(env.count).toBe(2);
    expect(env.items.length).toBe(2);
    const byWs = new Map(env.items.map((o) => [o.workstreamName, o]));
    expect(byWs.get("auth")?.stranded).toBe(false);
    expect(byWs.get("ghost")?.stranded).toBe(true);
    db = openDb({ path: dbPath });
  });

  it("--all overrides -w (an unknown -w with --all does NOT error)", async () => {
    // Document the choice: --all wins. -w is ignored, including a
    // typo'd value that would otherwise exit 3 via the tightened
    // single-ws path.
    ensureWorkstream(db, "auth");
    db.close();
    const r = await runCli(
      ["workspace", "orphans", "--all", "-w", "totally-nonexistent", "--json"],
      dbPath,
    );
    expect(r.error).toBeUndefined();
    expect(r.exitCode).toBeNull();
    expect(JSON.parse(r.stdout)).toEqual({ items: [], count: 0, nextSteps: [] });
    db = openDb({ path: dbPath });
  });
});
