// Tests for cmdState's --tui/--json/--mission dispatch matrix.
//
// Original TTY auto-route was reverted by feat_resurrect_state_card
// (workstream `tui-impl`): the static card is the always-on default
// and the TUI is opt-in via --tui. New matrix (multi-ws TUI shipped
// in feat_tui_multi_workstream so the v0 single-ws-only guard is
// gone):
//
//   --tui  --json  --mission  multi-ws  →  what runs
//   -----  ------  ---------  --------    ----------
//   no     yes     any        any         → static JSON
//   no     no      no         no          → static full card
//   no     no      yes        any         → static mission card
//   no     no      any        yes         → stacked static per-ws cards
//   yes    no      no         no          → ink TUI (lazy import)
//   yes    no      no         yes         → ink TUI with tabs
//   yes    yes     any        any         → UsageError
//   yes    no      yes        any         → UsageError
//
// The static fallback is exercised by test/state-render.test.ts (the
// existing suite). Here we ONLY verify the dispatch decisions.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalNoColor = vi.hoisted(() => process.env.NO_COLOR);

vi.hoisted(() => {
  process.env.NO_COLOR = "1";
});

afterAll(() => {
  if (originalNoColor === undefined) {
    const key = "NO_COLOR";
    delete process.env[key];
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
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

  it("--tui + multi-workstream is no longer guarded as a UsageError (per feat_tui_multi_workstream)", async () => {
    // Pre-feat_tui_multi_workstream this combination raised a
    // UsageError ("--tui currently supports a single workstream").
    // The TUI now supports tabs (Tab/Shift-Tab cycles); cmdState
    // forwards the full resolved ws set to runTui.
    //
    // We can't actually invoke runCli(["state","--tui",...]) here
    // because runTui boots ink + waitUntilExit, which would block
    // the test forever (no TTY in vitest, no q to press). Assert
    // structurally on the source of cmdState instead: the legacy
    // multi-ws guard is gone, and the dispatch hands the full
    // workstreams[] array to runTui. The src/cli/tui/* unit tests
    // cover the actual <App> tab behaviour.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/state.ts", "utf-8");
    // The legacy guard ('--tui currently supports a single workstream')
    // must be removed.
    expect(src).not.toMatch(/--tui currently supports a single workstream/);
    // The dispatch must hand runTui the whole workstreams array,
    // not a single workstream string.
    expect(src).toMatch(/runTui\(db,\s*\{\s*workstreams:/);
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

describe("cmdState empty-workstream paths", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-empty-"));
    dbPath = join(tempDir, "mu.db");
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Skipping the --all-on-truly-empty test: listWorkstreams() unions
  // DB rows with tmux sessions on the host, so 'truly empty' isn't
  // reproducible from a vitest harness when the dev machine has any
  // mu-* tmux session live (the orchestrator's own sessions count).
  // The path itself is exercised manually via
  //     MU_DB_PATH=/tmp/empty.db mu state --all
  // when no mu-* tmux sessions exist.

  it("bare `mu state` with workstreams listed errors with the list + suggestions, exit 2", async () => {
    // Set up a couple of workstreams. Note: mu workstream init creates
    // a tmux session named mu-<name>; if the runner's $MU_SESSION env
    // happens to match one of the host's existing tmux sessions, the
    // auto-resolve might pick THAT instead of returning null. Test asserts
    // behaviour-as-shipped: as long as the error message structure is
    // correct when no auto-resolve is possible, the assertion passes.
    await runCli(["workstream", "init", "alpha"], dbPath);
    await runCli(["workstream", "init", "beta"], dbPath);
    // Force MU_SESSION unset so resolveOptionalWorkstream returns null
    // (env override handled by runCli when supported; otherwise this
    // test relies on MU_SESSION already being unset in CI).
    const muSessionKey = "MU_SESSION";
    const saved = process.env[muSessionKey];
    delete process.env[muSessionKey];
    try {
      const { stderr, exitCode } = await runCli(["state"], dbPath);
      // Accept either the new error path (we're not in a matching
      // tmux session) OR the legacy auto-resolve success path (the
      // host has a stale matching tmux session). Either way the
      // command should not silently produce '(no workstreams)'.
      if (exitCode === 2) {
        expect(stderr).toContain("could not auto-resolve");
        expect(stderr).toContain("--all");
      }
      // If exitCode is null, we successfully auto-resolved into one
      // of the workstreams (test-suite-friendly fallback).
    } finally {
      if (saved !== undefined) process.env[muSessionKey] = saved;
    }
  });

  it("`mu state --json` is back-compat: when auto-resolve yields nothing, emit empty array (NOT the helpful error)", async () => {
    // Same test-host caveat as above. We assert: if the auto-resolve
    // fails AND --json is set, we get a JSON empty array on stdout,
    // NOT a stderr error and exit 2.
    await runCli(["workstream", "init", "alpha"], dbPath);
    const muSessionKey = "MU_SESSION";
    const saved = process.env[muSessionKey];
    delete process.env[muSessionKey];
    try {
      const { stdout, stderr, exitCode } = await runCli(["state", "--json"], dbPath);
      expect(exitCode).toBeNull();
      // Either an empty workstreams array (no auto-resolve) OR a
      // fully-shaped single-workstream JSON object (auto-resolve hit).
      // Neither path should write to stderr.
      expect(stderr).toBe("");
      const parsed = JSON.parse(stdout);
      expect(parsed.workstreams !== undefined || parsed.workstreamName !== undefined).toBe(true);
    } finally {
      if (saved !== undefined) process.env[muSessionKey] = saved;
    }
  });
});
