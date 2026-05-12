import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalNoColor = vi.hoisted(() => process.env.NO_COLOR);
const runTuiMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());

vi.hoisted(() => {
  process.env.NO_COLOR = "1";
});

vi.mock("../src/cli/tui/index.js", () => ({
  runTui: runTuiMock,
}));

afterAll(() => {
  if (originalNoColor === undefined) {
    const key = "NO_COLOR";
    delete process.env[key];
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});

function registerWorkspace(
  dbPath: string,
  workstream: string,
  agent: string,
  workspacePath: string,
  backend = "none",
): void {
  mkdirSync(workspacePath, { recursive: true });
  const db = openDb({ path: dbPath });
  try {
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
  } finally {
    db.close();
  }
}

import { insertAgent } from "../src/agents.js";
import { openDb } from "../src/db.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { withEnv } from "./_env.js";
import { runCli } from "./_runCli.js";

function setStdoutTty(isTTY: boolean): () => void {
  const saved = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTTY,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: saved,
      configurable: true,
      writable: true,
    });
  };
}

describe("bare mu TTY dispatch", () => {
  let tempDir: string;
  let dbPath: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-cli-bare-tui-"));
    dbPath = join(tempDir, "mu.db");
    runTuiMock.mockReset();
    setTmuxExecutor(async (args) => {
      if (args[0] === "list-sessions") {
        return { exitCode: 1, stdout: "", stderr: "no server running" };
      }
      if (args[0] === "has-session") return { exitCode: 1, stdout: "", stderr: "no session" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
  });

  afterEach(() => {
    chdir(originalCwd);
    resetTmuxExecutor();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("TTY + workstreams + $MU_SESSION match launches TUI with matching initial tab", async () => {
    for (const ws of ["a", "b", "c"]) {
      await runCli(["workstream", "init", ws, "--json"], dbPath);
    }

    const restoreTty = setStdoutTty(true);
    try {
      await withEnv("MU_SESSION", "b", async () => {
        const { stdout, stderr, exitCode, error } = await runCli([], dbPath);

        expect(error).toBeUndefined();
        expect(exitCode).toBeNull();
        expect(stdout).toBe("");
        expect(stderr).toBe("");
        expect(runTuiMock).toHaveBeenCalledOnce();
        expect(runTuiMock.mock.calls[0]?.[1]).toEqual({
          workstreams: ["a", "b", "c"],
          initialActive: 1,
        });
      });
    } finally {
      restoreTty();
    }
  });

  it("TTY + no workstreams prints help and get-started hint instead of launching TUI", async () => {
    const restoreTty = setStdoutTty(true);
    try {
      const { stdout, exitCode, error } = await runCli([], dbPath);

      expect(error).toBeUndefined();
      expect(exitCode).toBeNull();
      expect(runTuiMock).not.toHaveBeenCalled();
      expect(stdout).toContain("Usage: mu [options] [command]");
      expect(stdout).toContain("Next:");
      expect(stdout).toContain("Get started: mu workstream init <name>");
    } finally {
      restoreTty();
    }
  });

  it("non-TTY prints help and does not launch TUI", async () => {
    await runCli(["workstream", "init", "a", "--json"], dbPath);
    const restoreTty = setStdoutTty(false);
    try {
      const { stdout, exitCode, error } = await runCli([], dbPath);

      expect(error).toBeUndefined();
      expect(exitCode).toBeNull();
      expect(runTuiMock).not.toHaveBeenCalled();
      expect(stdout).toContain("Usage: mu [options] [command]");
    } finally {
      restoreTty();
    }
  });

  it("MU_NO_TUI=1 + TTY prints help and does not launch TUI", async () => {
    await runCli(["workstream", "init", "a", "--json"], dbPath);
    const restoreTty = setStdoutTty(true);
    try {
      await withEnv("MU_NO_TUI", "1", async () => {
        const { stdout, exitCode, error } = await runCli([], dbPath);

        expect(error).toBeUndefined();
        expect(exitCode).toBeNull();
        expect(runTuiMock).not.toHaveBeenCalled();
        expect(stdout).toContain("Usage: mu [options] [command]");
      });
    } finally {
      restoreTty();
    }
  });

  it("--json stays on the non-TUI/help path", async () => {
    await runCli(["workstream", "init", "a", "--json"], dbPath);
    const restoreTty = setStdoutTty(true);
    try {
      const { stdout, exitCode, error } = await runCli(["--json"], dbPath);

      expect(error).toBeUndefined();
      expect(exitCode).toBeNull();
      expect(runTuiMock).not.toHaveBeenCalled();
      expect(stdout).toContain("Usage: mu [options] [command]");
    } finally {
      restoreTty();
    }
  });

  it("tmux session match launches TUI with matching initial tab when $MU_SESSION is unset", async () => {
    for (const ws of ["a", "b", "c"]) await runCli(["workstream", "init", ws, "--json"], dbPath);
    setTmuxExecutor(async (args) => {
      if (args.join(" ") === "display-message -p #S") {
        return { exitCode: 0, stdout: "mu-c\n", stderr: "" };
      }
      if (args[0] === "list-sessions") {
        return { exitCode: 0, stdout: "mu-a\nmu-b\nmu-c\n", stderr: "" };
      }
      if (args[0] === "has-session") return { exitCode: 1, stdout: "", stderr: "no session" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const restoreTty = setStdoutTty(true);
    try {
      await withEnv("MU_SESSION", undefined, async () => {
        await withEnv("TMUX", "/tmp/tmux", async () => {
          const { exitCode, error } = await runCli([], dbPath);
          expect(error).toBeUndefined();
          expect(exitCode).toBeNull();
          expect(runTuiMock.mock.calls[0]?.[1]).toEqual({
            workstreams: ["a", "b", "c"],
            initialActive: 2,
          });
        });
      });
    } finally {
      restoreTty();
    }
  });

  it("$MU_SESSION pointing at a missing workstream falls back to index 0", async () => {
    for (const ws of ["a", "b"]) {
      await runCli(["workstream", "init", ws, "--json"], dbPath);
    }

    const restoreTty = setStdoutTty(true);
    try {
      await withEnv("MU_SESSION", "missing", async () => {
        const { exitCode, error } = await runCli([], dbPath);

        expect(error).toBeUndefined();
        expect(exitCode).toBeNull();
        expect(runTuiMock).toHaveBeenCalledOnce();
        expect(runTuiMock.mock.calls[0]?.[1]).toEqual({
          workstreams: ["a", "b"],
          initialActive: 0,
        });
      });
    } finally {
      restoreTty();
    }
  });

  it("focuses the workstream whose registered workspace contains cwd", async () => {
    for (const ws of ["a", "b", "c"]) await runCli(["workstream", "init", ws, "--json"], dbPath);
    registerWorkspace(dbPath, "b", "worker-1", join(tempDir, "ws-b", "worker-1"));
    chdir(join(tempDir, "ws-b", "worker-1"));

    const restoreTty = setStdoutTty(true);
    try {
      await withEnv("MU_SESSION", undefined, async () => {
        const { exitCode, error } = await runCli([], dbPath);
        expect(error).toBeUndefined();
        expect(exitCode).toBeNull();
        expect(runTuiMock.mock.calls[0]?.[1]).toMatchObject({ initialActive: 1 });
      });
    } finally {
      restoreTty();
    }
  });

  it("lets $MU_SESSION win over cwd detection", async () => {
    for (const ws of ["a", "b", "c"]) await runCli(["workstream", "init", ws, "--json"], dbPath);
    registerWorkspace(dbPath, "c", "worker-1", join(tempDir, "ws-c", "worker-1"));
    chdir(join(tempDir, "ws-c", "worker-1"));

    const restoreTty = setStdoutTty(true);
    try {
      await withEnv("MU_SESSION", "b", async () => {
        const { exitCode, error } = await runCli([], dbPath);
        expect(error).toBeUndefined();
        expect(exitCode).toBeNull();
        expect(runTuiMock.mock.calls[0]?.[1]).toMatchObject({ initialActive: 1 });
      });
    } finally {
      restoreTty();
    }
  });

  it("ignores cwd inside a workspace outside the resolved set", async () => {
    for (const ws of ["a", "b", "z"]) await runCli(["workstream", "init", ws, "--json"], dbPath);
    registerWorkspace(dbPath, "z", "worker-1", join(tempDir, "ws-z", "worker-1"));
    chdir(join(tempDir, "ws-z", "worker-1"));

    const restoreTty = setStdoutTty(true);
    try {
      await withEnv("MU_SESSION", undefined, async () => {
        const { exitCode, error } = await runCli(["--workstream", "a,b"], dbPath);
        expect(error).toBeUndefined();
        expect(exitCode).toBeNull();
        expect(runTuiMock.mock.calls[0]?.[1]).toEqual({
          workstreams: ["a", "b"],
          initialActive: 0,
        });
      });
    } finally {
      restoreTty();
    }
  });

  it("falls back to tab 0 when cwd is outside every workspace", async () => {
    for (const ws of ["a", "b"]) await runCli(["workstream", "init", ws, "--json"], dbPath);
    registerWorkspace(dbPath, "b", "worker-1", join(tempDir, "ws-b", "worker-1"));
    chdir(tempDir);

    const restoreTty = setStdoutTty(true);
    try {
      await withEnv("MU_SESSION", undefined, async () => {
        const { exitCode, error } = await runCli([], dbPath);
        expect(error).toBeUndefined();
        expect(exitCode).toBeNull();
        expect(runTuiMock.mock.calls[0]?.[1]).toMatchObject({ initialActive: 0 });
      });
    } finally {
      restoreTty();
    }
  });

  it("uses workstream order as the deterministic first match for overlapping paths", async () => {
    for (const ws of ["a", "b"]) await runCli(["workstream", "init", ws, "--json"], dbPath);
    const parent = join(tempDir, "nested");
    registerWorkspace(dbPath, "a", "worker-1", parent);
    registerWorkspace(dbPath, "b", "worker-1", join(parent, "child"));
    chdir(join(parent, "child"));

    const restoreTty = setStdoutTty(true);
    try {
      await withEnv("MU_SESSION", undefined, async () => {
        const { exitCode, error } = await runCli([], dbPath);
        expect(error).toBeUndefined();
        expect(exitCode).toBeNull();
        expect(runTuiMock.mock.calls[0]?.[1]).toMatchObject({ initialActive: 0 });
      });
    } finally {
      restoreTty();
    }
  });
});
