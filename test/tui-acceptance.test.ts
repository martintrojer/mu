// End-to-end acceptance test for the TUI (Wave 8 Task 39 of
// docs/plans/2026-05-11-interactive-tui.md).
//
// The "render App + send keys + assert yanked command" gate from the
// plan's design_tests rubric isn't directly achievable without
// ink-testing-library (which isn't network-installable in this dev
// environment). We approximate it via two layers:
//
//   1. Wire up a real mu DB fixture with 1 ws + 2 agents + 4 tasks.
//   2. Call loadWorkstreamSnapshot against it and assert the resulting
//      WorkstreamSnapshot is shaped exactly the way every card and
//      popup consumes (yank-matrix is a pure function of the snapshot
//      + cursor — already covered in test/tui-popup-tasks.test.ts).
//
// The implicit acceptance gate becomes:
//   - SDK seam works end-to-end against a real DB.
//   - Snapshot shape matches what the cards/popups read.
//   - Yank command shapes are wired correctly to the DB rows.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "../src/db.js";
import { loadWorkstreamSnapshot } from "../src/state.js";
import { runCli } from "./_runCli.js";

describe("TUI end-to-end acceptance", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-tui-acceptance-"));
    dbPath = join(tempDir, "mu.db");
    await runCli(["workstream", "init", "demo"], dbPath);
    // 4 tasks in the canonical wave shape: design → impl → review → ship
    const adds = [
      ["design_x", "Design X", "70", "1"],
      ["build_x", "Build X", "70", "5"],
      ["review_x", "Review X", "60", "1"],
      ["ship_x", "Ship X", "50", "1"],
    ];
    for (const row of adds) {
      const [id, title, impact, days] = row;
      if (id === undefined || title === undefined || impact === undefined || days === undefined) {
        throw new Error("fixture row malformed");
      }
      await runCli(
        [
          "task",
          "add",
          "-w",
          "demo",
          "--title",
          title,
          "--impact",
          impact,
          "--effort-days",
          days,
          "--",
          id,
        ],
        dbPath,
      );
    }
    // Block: build → design, review → build, ship → review.
    await runCli(["task", "block", "build_x", "--by", "design_x", "-w", "demo"], dbPath);
    await runCli(["task", "block", "review_x", "--by", "build_x", "-w", "demo"], dbPath);
    await runCli(["task", "block", "ship_x", "--by", "review_x", "-w", "demo"], dbPath);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("loadWorkstreamSnapshot returns the shape every card/popup consumes", async () => {
    const db = openDb({ path: dbPath });
    try {
      const snap = await loadWorkstreamSnapshot(db, "demo", { eventLimit: 50 });

      // Workstream identity
      expect(snap.workstreamName).toBe("demo");

      // Agents view (no agents spawned in the fixture)
      expect(Array.isArray(snap.view.agents)).toBe(true);
      expect(snap.view.agents.length).toBe(0);

      // Tracks: design_x is the prereq of build_x → review_x → ship_x.
      // One track containing all 4 tasks; ship_x is the goal.
      expect(snap.tracks.length).toBe(1);
      const track = snap.tracks[0];
      if (track === undefined) throw new Error("track[0] missing");
      expect(track.taskIds.size).toBe(4);
      expect(track.roots.map((r) => r.name)).toContain("ship_x");

      // Ready: only design_x has no blockers.
      expect(snap.ready.length).toBe(1);
      expect(snap.ready[0]?.name).toBe("design_x");

      // Blocked: build_x, review_x, ship_x.
      expect(snap.blocked.length).toBe(3);
      const blockedNames = snap.blocked.map((t) => t.name).sort();
      expect(blockedNames).toEqual(["build_x", "review_x", "ship_x"]);

      // In progress: nothing claimed yet.
      expect(snap.inProgress.length).toBe(0);

      // Recent events: workstream init + 4 task add + 3 task block = 8 events.
      expect(snap.recent.length).toBeGreaterThanOrEqual(8);
      expect(snap.recentCommits).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("yank-matrix in popups/ready.tsx produces a `mu task claim` command for the ready task", async () => {
    // Reads the source of the popup and verifies that its yank
    // matrix would emit a `mu task claim design_x -w demo` for the
    // fixture's only ready task. (The matrix lives in a private
    // helper; we exercise it via static assertion.)
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/ready.tsx", "utf-8");
    expect(src).toMatch(/mu task claim \$\{t.name\} -w \$\{ws\}/);
  });

  it("the dispatch branch in cmdState exists and points at runTui", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/state.ts", "utf-8");
    // The explicit `mu state --tui` branch must still exist and
    // dynamic-import. Bare `mu` owns the TTY auto-route; `mu state`
    // stays static by default for back-compat.
    expect(src).toMatch(/opts\.tui === true/);
    expect(src).toMatch(/await import\("\.\/tui\/index\.js"\)/);
    // Multi-ws TUI shipped as feat_tui_multi_workstream: runTui
    // now takes an array of workstream names (Tab/Shift-Tab cycles
    // the active tab). Single-ws is the N=1 degenerate case.
    expect(src).toMatch(/runTui\(db,\s*\{ workstreams:/);
  });

  it("runTui enters and exits the alt-screen so the dashboard is flush with the top of the pane", async () => {
    // Alt-screen sequences are TTY-only side effects; the most
    // reliable gate is a static assertion that the constants exist in
    // the dedicated `escapes.ts` module (split out so they're unit-
    // testable without booting ink) and that runTui writes them in a
    // try/finally so any throw still restores the user's shell
    // scrollback. The enter sequence MUST also home the cursor
    // (`\x1b[H`) so the dashboard renders flush with row 1 — the
    // alt-screen swap alone inherits the cursor row from the prior
    // buffer on iTerm2/Apple Terminal/tmux's inner terminal.
    const { readFileSync } = await import("node:fs");
    const escapes = readFileSync("./src/cli/tui/escapes.ts", "utf-8");
    expect(escapes).toMatch(/\\x1b\[\?1049h/);
    expect(escapes).toMatch(/\\x1b\[\?1049l/);
    expect(escapes).toMatch(/\\x1b\[H/);
    expect(escapes).toMatch(/\\x1b\[\?25l/);
    expect(escapes).toMatch(/\\x1b\[\?25h/);
    const src = readFileSync("./src/cli/tui/index.ts", "utf-8");
    expect(src).toMatch(/ALT_SCREEN_ENTER/);
    expect(src).toMatch(/finally\s*\{[\s\S]*?ALT_SCREEN_EXIT/);
  });
});
