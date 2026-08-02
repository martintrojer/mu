// Fast-tier test: cmdSpawn and cmdEnsure share one workspace-preflight
// helper (maybePrintWorkspacePreflight). This guards against the warning,
// backend detection, and JSON suppression drifting between the two sibling
// entry points (finding_duplicate_workspace_preflight).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdEnsure, cmdSpawn } from "../src/cli/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { freshMockState, type MockState, mockTmux } from "./_verbs-mock.js";

describe("workspace preflight (shared by spawn + ensure)", () => {
  let dir: string;
  // The `none` backend materialises a workspace with `cp -a
  // <projectRoot>/. <stateDir>/workspaces/<ws>/<agent>`. If the state
  // dir IS the project root, that copies a directory into itself and
  // `cp` refuses. Real deployments never nest (state dir is
  // ~/.local/state/mu, project root is the repo), so keep them as
  // sibling subdirs of the one temp dir here too.
  let projectRoot: string;
  let stateDir: string;
  let db: Db;
  let mock: MockState;
  let logs: string[];
  const ws = "preflight";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-preflight-"));
    projectRoot = join(dir, "project");
    stateDir = join(dir, "state");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    db = openDb({ path: join(dir, "mu.db") });
    mock = freshMockState();
    setTmuxExecutor(mockTmux(mock).executor);
    setSleepForTests(async () => {});
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    process.env.MU_STATE_DIR = stateDir;
    ensureWorkstream(db, ws);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const key = "MU_SPAWN_LIVENESS_MS";
    delete process.env[key];
    const stateKey = "MU_STATE_DIR";
    delete process.env[stateKey];
    resetSleep();
    resetTmuxExecutor();
    try {
      db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  function preflightLine(): string | undefined {
    return logs.find((l) => l.includes("[mu] workspace preflight:"));
  }

  it("spawn and ensure emit the same backend=none warning", async () => {
    await cmdSpawn(db, "worker-1", {
      workstream: ws,
      cli: "sh",
      workspace: true,
      workspaceBackend: "none",
      workspaceProjectRoot: projectRoot,
    });
    const spawnLine = preflightLine();
    expect(spawnLine).toBeDefined();
    expect(spawnLine).toContain("backend=");
    expect(spawnLine).toContain("WARNING");

    logs.length = 0;
    await cmdEnsure(db, "worker-2", {
      workstream: ws,
      cli: "sh",
      workspace: true,
      workspaceBackend: "none",
      workspaceProjectRoot: projectRoot,
    });
    const ensureLine = preflightLine();
    expect(ensureLine).toBeDefined();
    // Identical preflight text from both entry points.
    expect(ensureLine).toBe(spawnLine);
  });

  it("suppresses the preflight line under --json for both commands", async () => {
    await cmdSpawn(db, "worker-3", {
      workstream: ws,
      cli: "sh",
      workspace: true,
      workspaceBackend: "none",
      workspaceProjectRoot: projectRoot,
      json: true,
    });
    expect(preflightLine()).toBeUndefined();

    logs.length = 0;
    await cmdEnsure(db, "worker-4", {
      workstream: ws,
      cli: "sh",
      workspace: true,
      workspaceBackend: "none",
      workspaceProjectRoot: projectRoot,
      json: true,
    });
    expect(preflightLine()).toBeUndefined();
  });
});
