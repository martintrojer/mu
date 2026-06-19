// Fast-tier test: cmdSpawn and cmdEnsure share one workspace-preflight
// helper (maybePrintWorkspacePreflight). This guards against the warning,
// backend detection, and JSON suppression drifting between the two sibling
// entry points (finding_duplicate_workspace_preflight).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdEnsure, cmdSpawn } from "../src/cli/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { type MockState, freshMockState, mockTmux } from "./_verbs-mock.js";

describe("workspace preflight (shared by spawn + ensure)", () => {
  let dir: string;
  let db: Db;
  let mock: MockState;
  let logs: string[];
  const ws = "preflight";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mu-preflight-"));
    db = openDb({ path: join(dir, "mu.db") });
    mock = freshMockState();
    setTmuxExecutor(mockTmux(mock).executor);
    setSleepForTests(async () => {});
    process.env.MU_SPAWN_LIVENESS_MS = "0";
    process.env.MU_STATE_DIR = dir;
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
      workspaceProjectRoot: dir,
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
      workspaceProjectRoot: dir,
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
      workspaceProjectRoot: dir,
      json: true,
    });
    expect(preflightLine()).toBeUndefined();

    logs.length = 0;
    await cmdEnsure(db, "worker-4", {
      workstream: ws,
      cli: "sh",
      workspace: true,
      workspaceBackend: "none",
      workspaceProjectRoot: dir,
      json: true,
    });
    expect(preflightLine()).toBeUndefined();
  });
});
