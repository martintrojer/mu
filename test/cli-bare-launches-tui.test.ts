import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
