import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./_runCli.js";

describe("removed CLI surface stays removed", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-removed-surface-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it("mu state --help omits --mission and -n/--lines", async () => {
    const { stdout, exitCode } = await runCli(["state", "--help"], dbPath);

    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toContain("--events <n>");
    expect(stdout).not.toContain("--mission");
    expect(stdout).not.toContain("--lines");
    expect(stdout).not.toContain("-n,");
  });

  it("mu agent list --help omits --all", async () => {
    const { stdout, exitCode } = await runCli(["agent", "list", "--help"], dbPath);

    expect(exitCode === null || exitCode === 0).toBe(true);
    expect(stdout).toContain("Usage: mu agent list");
    expect(stdout).not.toContain("--all");
  });

  it("removed flags fail as unknown options", async () => {
    const mission = await runCli(["state", "--mission"], dbPath);
    expect(mission.exitCode).toBe(2);
    expect(mission.stderr.toLowerCase()).toContain("unknown option");
    expect(mission.stderr).toContain("--mission");

    const lines = await runCli(["state", "--lines", "5"], dbPath);
    expect(lines.exitCode).toBe(2);
    expect(lines.stderr.toLowerCase()).toContain("unknown option");
    expect(lines.stderr).toContain("--lines");

    const agentAll = await runCli(["agent", "list", "--all"], dbPath);
    expect(agentAll.exitCode).toBe(2);
    expect(agentAll.stderr.toLowerCase()).toContain("unknown option");
    expect(agentAll.stderr).toContain("--all");
  });
});
