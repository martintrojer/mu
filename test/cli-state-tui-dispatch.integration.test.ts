import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalNoColor = vi.hoisted(() => process.env.NO_COLOR);
const runTuiMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
const loadWorkstreamSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("static snapshot should not be loaded before state --tui launches");
  }),
);

vi.hoisted(() => {
  process.env.NO_COLOR = "1";
});

vi.mock("../src/cli/tui/index.js", () => ({
  runTui: runTuiMock,
}));

vi.mock("../src/state.js", () => ({
  loadWorkstreamSnapshot: loadWorkstreamSnapshotMock,
}));

import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";
import { runCli } from "./_runCli.js";

const envKeyNoColor = "NO_COLOR";

afterAll(() => {
  if (originalNoColor === undefined) {
    delete process.env[envKeyNoColor];
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});

describe("mu state --tui dispatch", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-tui-dispatch-"));
    dbPath = join(tempDir, "mu.db");
    runTuiMock.mockReset();
    loadWorkstreamSnapshotMock.mockClear();
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

  it("launches runTui without preloading static snapshots", async () => {
    await runCli(["workstream", "init", "a", "--json"], dbPath);
    await runCli(["workstream", "init", "b", "--json"], dbPath);

    const { exitCode, error, stderr, stdout } = await runCli(
      ["state", "--tui", "-w", "a,b"],
      dbPath,
    );

    expect(error).toBeUndefined();
    expect(exitCode).toBeNull();
    expect(stderr).toBe("");
    expect(stdout).toBe("");
    expect(loadWorkstreamSnapshotMock).not.toHaveBeenCalled();
    expect(runTuiMock).toHaveBeenCalledOnce();
    expect(runTuiMock.mock.calls[0]?.[1]).toEqual({
      workstreams: ["a", "b"],
      initialActive: 0,
    });
  });
});
