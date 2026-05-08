// Tests for the `mu hud` verb. Verify each of the 5 modes (line / small /
// mid / full / json) renders the right shape and that mutual-exclusion
// fires. Uses runCli + a real SQLite DB, no tmux side effects (mu hud
// is print-once and tmux-free by design).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./_runCli.js";

describe("mu hud", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-hud-test-"));
    dbPath = join(tempDir, "mu.db");
    // Seed: workstream + 2 tasks (1 ready, 1 blocked → 1 track each
    // since they're independent), 1 agent, 1 claim.
    await runCli(["workstream", "init", "ws", "--json"], dbPath);
    await runCli(
      ["task", "add", "alpha", "-w", "ws", "--title", "A", "-i", "50", "-e", "1", "--json"],
      dbPath,
    );
    await runCli(
      ["task", "add", "beta", "-w", "ws", "--title", "B", "-i", "60", "-e", "1", "--json"],
      dbPath,
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  // ── --line ──────────────────────────────────────────────────────

  it("--line mode prints one line with workstream · counts · tracks", async () => {
    const { stdout, exitCode } = await runCli(["hud", "-w", "ws", "--line"], dbPath);
    expect(exitCode).toBeNull();
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    // 'ws · 2r · 0p · 2trk · last: ...'
    expect(stdout).toContain("ws");
    expect(stdout).toContain("2r");
    expect(stdout).toContain("0p");
    expect(stdout).toContain("2trk");
  });

  // ── --small ─────────────────────────────────────────────────────

  it("--small mode prints counts header + agent histogram (no table)", async () => {
    const { stdout, exitCode } = await runCli(["hud", "-w", "ws", "--small"], dbPath);
    expect(exitCode).toBeNull();
    const lines = stdout.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("mu-ws");
    expect(lines[0]).toContain("2 ready");
    expect(lines[0]).toContain("0 in-progress");
    expect(lines[0]).toContain("2 tracks");
    expect(lines[1]).toContain("agents:");
    expect(lines[1]).toContain("0 active");
    expect(lines[1]).toContain("none");
  });

  // ── --mid (default) ─────────────────────────────────────────────

  it("--mid mode (default) prints counts + agent table", async () => {
    const { stdout, exitCode } = await runCli(["hud", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("mu-ws");
    expect(stdout).toContain("2 ready");
    expect(stdout).toContain("agents (0 active)");
    expect(stdout).toContain("(none)");
    // No tracks section in mid mode.
    expect(stdout).not.toContain("tracks (");
    // No recent section in mid mode.
    expect(stdout).not.toContain("recent (");
  });

  it("--mid is the default when no mode flag is passed", async () => {
    const { stdout: a } = await runCli(["hud", "-w", "ws"], dbPath);
    const { stdout: b } = await runCli(["hud", "-w", "ws", "--mid"], dbPath);
    expect(a).toBe(b);
  });

  // ── --full ──────────────────────────────────────────────────────

  it("--full mode adds tracks list + recent-events tail", async () => {
    const { stdout, exitCode } = await runCli(["hud", "-w", "ws", "--full"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("agents (0 active)");
    expect(stdout).toContain("tracks (2)");
    // Tracks render with the localIds we seeded.
    expect(stdout).toMatch(/Track 1: (alpha|beta)/);
    expect(stdout).toContain("recent (");
    // The seeded `task add alpha` event should be in the tail.
    expect(stdout).toContain("task add alpha");
  });

  it("--full -n 1 caps the recent-events tail", async () => {
    const { stdout } = await runCli(["hud", "-w", "ws", "--full", "-n", "1"], dbPath);
    expect(stdout).toContain("recent (1)");
  });

  // ── --json ──────────────────────────────────────────────────────

  it("--json mode emits structured shape with all keys", async () => {
    const { stdout, exitCode } = await runCli(["hud", "-w", "ws", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.workstream).toBe("ws");
    expect(parsed.summary).toEqual({
      ready: 2,
      inProgress: 0,
      tracks: 2,
      agents: 0,
      orphans: 0,
    });
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(Array.isArray(parsed.orphans)).toBe(true);
    expect(Array.isArray(parsed.tracks)).toBe(true);
    expect(parsed.tracks.length).toBe(2);
    expect(Array.isArray(parsed.ready)).toBe(true);
    expect(parsed.ready.length).toBe(2);
    expect(Array.isArray(parsed.inProgress)).toBe(true);
    expect(Array.isArray(parsed.recent)).toBe(true);
  });

  // ── Mutual exclusion ────────────────────────────────────────────

  it("rejects multiple mode flags with a clear UsageError", async () => {
    const { stderr, exitCode } = await runCli(["hud", "-w", "ws", "--line", "--small"], dbPath);
    expect(exitCode).toBe(2); // UsageError -> exit 2
    expect(stderr).toContain("mutually exclusive");
    expect(stderr).toContain("--line");
    expect(stderr).toContain("--small");
  });
});
