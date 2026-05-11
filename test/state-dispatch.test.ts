// Tests for cmdState's --tui/--json/--mission dispatch matrix.
//
// Original TTY auto-route was reverted by feat_resurrect_state_card
// (workstream `tui-impl`): the static card is the always-on default
// and the TUI is opt-in via --tui. New matrix:
//
//   --tui  --json  --mission  multi-ws  →  what runs
//   -----  ------  ---------  --------    ----------
//   no     yes     any        any         → static JSON
//   no     no      no         no          → static full card
//   no     no      yes        any         → static mission card
//   no     no      any        yes         → stacked static per-ws cards
//   yes    no      no         no          → ink TUI (lazy import)
//   yes    yes     any        any         → UsageError
//   yes    no      yes        any         → UsageError
//   yes    no      no         yes         → UsageError (single-ws only in v0)
//
// The static fallback is exercised by test/state-render.test.ts (the
// existing suite). Here we ONLY verify the dispatch decisions.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NO_COLOR = "1";
});

import { runCli } from "./_runCli.js";

describe("cmdState dispatch", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-dispatch-"));
    dbPath = join(tempDir, "mu.db");
    await runCli(["workstream", "init", "ws"], dbPath);
    await runCli(
      [
        "task",
        "add",
        "-w",
        "ws",
        "--title",
        "hello",
        "--impact",
        "50",
        "--effort-days",
        "1",
        "--",
        "hello",
      ],
      dbPath,
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("--json on a non-TTY emits JSON regardless of the new TUI branch", async () => {
    // runCli pipes stdout, so isTTY is always false in tests; the
    // dispatch goes to renderStateStatic / renderStateJson.
    const { stdout, exitCode } = await runCli(["state", "-w", "ws", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.workstreamName).toBe("ws");
  });

  it("--mission on a non-TTY hits the static mission renderer", async () => {
    const { stdout, exitCode } = await runCli(["state", "--mission", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("mu-ws");
  });

  it("default (no --tui) hits the static full card", async () => {
    const { stdout, exitCode } = await runCli(["state", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("State of mu-ws");
  });

  it("multi-workstream renders stacked static cards (TUI is single-ws today)", async () => {
    await runCli(["workstream", "init", "ws2"], dbPath);
    const { stdout, exitCode } = await runCli(["state", "-w", "ws,ws2"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("State of mu-ws");
    expect(stdout).toContain("State of mu-ws2");
  });

  it("--tui + --json is a UsageError (TUI is render-only)", async () => {
    const { stderr, exitCode } = await runCli(["state", "--tui", "--json", "-w", "ws"], dbPath);
    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBeNull();
    expect(stderr.toLowerCase()).toContain("--tui");
    expect(stderr.toLowerCase()).toContain("--json");
  });

  it("--tui + --mission is a UsageError (mission is a static glance card)", async () => {
    const { stderr, exitCode } = await runCli(["state", "--tui", "--mission", "-w", "ws"], dbPath);
    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBeNull();
    expect(stderr.toLowerCase()).toContain("--tui");
    expect(stderr.toLowerCase()).toContain("--mission");
  });

  it("--tui + multi-workstream is a UsageError (single-ws only in v0)", async () => {
    await runCli(["workstream", "init", "ws2"], dbPath);
    const { stderr, exitCode } = await runCli(["state", "--tui", "-w", "ws,ws2"], dbPath);
    expect(exitCode).not.toBe(0);
    expect(exitCode).not.toBeNull();
    expect(stderr.toLowerCase()).toContain("--tui");
  });

  it("--hud option no longer exists (removed in this refactor)", async () => {
    // --hud is silently ignored by commander as an unknown option in
    // some configurations; the strict commander config in mu errors
    // it out as an unknown option. Either way the legacy --hud
    // muscle-memory call should NOT produce HUD output.
    const { exitCode } = await runCli(["state", "--hud", "-w", "ws"], dbPath);
    // commander rejects unknown options with exit 1 (commander) or
    // 2 (mu's UsageError). Both indicate "this option is gone".
    expect(exitCode).not.toBeNull();
    expect(exitCode).not.toBe(0);
  });
});
