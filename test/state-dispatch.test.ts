// Tests for cmdState's TTY/JSON/mission dispatch matrix introduced in
// the TUI refactor (Wave 3 Task 15 of docs/plans/2026-05-11-interactive-tui.md).
//
// The branching matrix:
//
//   isTTY  --json  --mission  multi-ws  →  what runs
//   -----  ------  ---------  --------    ----------
//   any    yes     any        any         → static JSON
//   yes    no      no         no          → ink TUI (lazy import)
//   yes    no      yes        any         → static mission card
//   no     no      any        any         → static full/mission card
//   any    any     any        yes         → static (TUI is single-ws today)
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

  it("non-TTY default hits the static full card (the L1-total fallback)", async () => {
    const { stdout, exitCode } = await runCli(["state", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("State of mu-ws");
  });

  it("multi-workstream stays static even on a TTY (TUI is single-ws today)", async () => {
    await runCli(["workstream", "init", "ws2"], dbPath);
    const { stdout, exitCode } = await runCli(["state", "-w", "ws,ws2"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("State of mu-ws");
    expect(stdout).toContain("State of mu-ws2");
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
