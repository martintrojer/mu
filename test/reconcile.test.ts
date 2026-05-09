// Tests for src/reconcile.ts. Uses a real SQLite DB plus a mocked tmux
// executor so we can drive listPanesInSession + capturePane responses
// deterministically.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentStatus, getAgent, insertAgent, listAgents } from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { reconcile } from "../src/reconcile.js";
import {
  type TmuxExecResult,
  type TmuxExecutor,
  resetTmuxExecutor,
  setTmuxExecutor,
} from "../src/tmux.js";

// ─── Mock tmux harness for reconcile ───────────────────────────────────

interface FakePane {
  windowId: string;
  paneId: string;
  title: string;
  command: string;
  /** Scrollback the capture-pane mock will return. */
  scrollback?: string;
}

function mockTmux(panes: FakePane[]): { calls: string[][]; executor: TmuxExecutor } {
  const calls: string[][] = [];
  const byPaneId = new Map(panes.map((p) => [p.paneId, p]));

  const executor: TmuxExecutor = async (args) => {
    calls.push([...args]);
    const verb = args[0];

    if (verb === "list-panes" && args[1] === "-s") {
      const stdout = panes
        .map((p) => `${p.windowId}\t${p.paneId}\t${p.title}\t${p.command}`)
        .join("\n");
      return ok(stdout);
    }

    if (verb === "capture-pane") {
      const paneId = extractFlag(args, "-t");
      if (!paneId) return ok("");
      const pane = byPaneId.get(paneId);
      if (!pane) return fail(`can't find pane: ${paneId}`);
      return ok(pane.scrollback ?? "");
    }

    return fail(`unmocked tmux call: ${args.join(" ")}`);
  };

  return { calls, executor };
}

function extractFlag(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i < args.length - 1 ? args[i + 1] : undefined;
}

const ok = (stdout = ""): TmuxExecResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1): TmuxExecResult => ({
  stdout: "",
  stderr,
  exitCode,
});

// Realistic scrollback fixtures matching the patterns in detect.ts.
const BUSY_SCROLLBACK = "...\nWorking... (Esc to interrupt)";
const IDLE_SCROLLBACK = "...\n> ";
const PERMISSION_SCROLLBACK = "...\n(Esc to cancel, Enter to submit)";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-reconcile-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  resetTmuxExecutor();
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
});

// ─── Empty cases ───────────────────────────────────────────────────────

describe("reconcile — empty cases", () => {
  it("empty DB and empty tmux → empty report", async () => {
    const { executor } = mockTmux([]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report).toEqual({
      prunedGhosts: 0,
      statusChanges: 0,
      orphans: [],
      mode: "full",
    });
  });

  it("uses tmux session 'mu-<workstream>' by default", async () => {
    const { executor, calls } = mockTmux([]);
    setTmuxExecutor(executor);
    await reconcile(db, { workstream: "auth-refactor" });
    expect(calls[0]?.slice(0, 4)).toEqual(["list-panes", "-s", "-t", "mu-auth-refactor"]);
  });

  it("uses explicit tmuxSession override when provided", async () => {
    const { executor, calls } = mockTmux([]);
    setTmuxExecutor(executor);
    await reconcile(db, { workstream: "auth", tmuxSession: "custom-session" });
    expect(calls[0]?.slice(0, 4)).toEqual(["list-panes", "-s", "-t", "custom-session"]);
  });
});

// ─── Step 1: prune ghosts ──────────────────────────────────────────────

describe("reconcile — pruning ghost rows", () => {
  it("DB row with missing pane → pruned", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%99", status: "busy" });
    const { executor } = mockTmux([]); // no panes
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.prunedGhosts).toBe(1);
    expect(getAgent(db, "alice", "auth")).toBeUndefined();
  });

  it("DB row with matching pane → NOT pruned", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "busy" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.prunedGhosts).toBe(0);
    expect(getAgent(db, "alice", "auth")).toBeDefined();
  });

  it("multiple ghosts pruned at once; survivors kept", async () => {
    insertAgent(db, { name: "alive", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, { name: "dead1", workstream: "auth", paneId: "%99", status: "busy" });
    insertAgent(db, { name: "dead2", workstream: "auth", paneId: "%100", status: "busy" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%1", title: "alive", command: "pi", scrollback: IDLE_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.prunedGhosts).toBe(2);
    expect(listAgents(db).map((r) => r.name)).toEqual(["alive"]);
  });

  it("workstream isolation: ghost in one workstream doesn't touch another", async () => {
    insertAgent(db, { name: "auth-bob", workstream: "auth", paneId: "%1", status: "busy" });
    insertAgent(db, {
      name: "billing-carol",
      workstream: "billing",
      paneId: "%99",
      status: "busy",
    });
    // Reconciling 'auth' should only consider 'auth' agents.
    const { executor } = mockTmux([]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.prunedGhosts).toBe(1);
    // billing-carol untouched.
    expect(getAgent(db, "billing-carol", "billing")).toBeDefined();
  });
});

// ─── Step 2: detect status from scrollback ─────────────────────────────

describe("reconcile — status detection", () => {
  it("spawning → busy when loading animation visible", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "spawning" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.statusChanges).toBe(1);
    expect(getAgent(db, "alice", "auth")?.status).toBe("busy");
  });

  it("spawning → needs_input when prompt visible", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "spawning" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: IDLE_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.statusChanges).toBe(1);
    expect(getAgent(db, "alice", "auth")?.status).toBe("needs_input");
  });

  it("busy → needs_permission when permission prompt appears", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "busy" });
    const { executor } = mockTmux([
      {
        windowId: "@1",
        paneId: "%15",
        title: "alice",
        command: "pi",
        scrollback: PERMISSION_SCROLLBACK,
      },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.statusChanges).toBe(1);
    expect(getAgent(db, "alice", "auth")?.status).toBe("needs_permission");
  });

  it("status unchanged when detected matches current → 0 statusChanges", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "busy" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.statusChanges).toBe(0);
    expect(getAgent(db, "alice", "auth")?.status).toBe("busy");
  });

  it("free + idle scrollback → free stays (sticky)", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "free" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: IDLE_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.statusChanges).toBe(0);
    expect(getAgent(db, "alice", "auth")?.status).toBe("free");
  });

  it("free + busy scrollback → flips to busy (real activity wins)", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "free" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.statusChanges).toBe(1);
    expect(getAgent(db, "alice", "auth")?.status).toBe("busy");
  });

  it("free + permission prompt → flips to needs_permission", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "free" });
    const { executor } = mockTmux([
      {
        windowId: "@1",
        paneId: "%15",
        title: "alice",
        command: "pi",
        scrollback: PERMISSION_SCROLLBACK,
      },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.statusChanges).toBe(1);
    expect(getAgent(db, "alice", "auth")?.status).toBe("needs_permission");
  });

  it("ghost row is pruned BEFORE its status would be detected (no error)", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%99", status: "busy" });
    const { executor, calls } = mockTmux([]); // empty tmux
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.prunedGhosts).toBe(1);
    expect(report.statusChanges).toBe(0);
    // capture-pane should not have been called for the missing pane.
    expect(calls.some((c) => c[0] === "capture-pane")).toBe(false);
  });
});

// ─── Step 3: surface orphans ───────────────────────────────────────────

describe("reconcile — orphan surfacing", () => {
  it("pi pane with no DB row → surfaced as orphan", async () => {
    const { executor } = mockTmux([
      {
        windowId: "@1",
        paneId: "%42",
        title: "stranger",
        command: "pi",
        scrollback: IDLE_SCROLLBACK,
      },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]).toMatchObject({
      paneId: "%42",
      title: "stranger",
      command: "pi",
    });
  });

  it("claude / codex panes with no DB row → also surfaced as orphans", async () => {
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%1", title: "rev", command: "claude", scrollback: "" },
      { windowId: "@2", paneId: "%2", title: "aud", command: "codex", scrollback: "" },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.orphans.map((o) => o.paneId).sort()).toEqual(["%1", "%2"]);
  });

  it("bash pane with no DB row → NOT an orphan", async () => {
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%99", title: "shell", command: "bash", scrollback: "$ " },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.orphans).toEqual([]);
  });

  it("registered pi pane → NOT surfaced (it's already an agent)", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "busy" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.orphans).toEqual([]);
  });

  it("registered + orphan + bash mixed: only orphan agent panes surface", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "busy" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
      { windowId: "@2", paneId: "%42", title: "stranger", command: "pi", scrollback: "" },
      { windowId: "@3", paneId: "%99", title: "shell", command: "bash", scrollback: "" },
    ]);
    setTmuxExecutor(executor);
    const report = await reconcile(db, { workstream: "auth" });
    expect(report.orphans.map((o) => o.paneId)).toEqual(["%42"]);
  });
});

// ─── End-to-end: combined scenarios ────────────────────────────────────

describe("reconcile — combined scenarios", () => {
  it("full mixed scenario: prune + detect + orphan in one pass", async () => {
    // Three registered agents, two of which still exist; statuses change;
    // plus one orphan pane.
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%1", status: "spawning" });
    insertAgent(db, { name: "bob", workstream: "auth", paneId: "%2", status: "busy" });
    insertAgent(db, { name: "carol", workstream: "auth", paneId: "%999", status: "busy" }); // ghost

    const { executor } = mockTmux([
      // alice: was spawning, scrollback shows busy → flip
      { windowId: "@1", paneId: "%1", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
      // bob: was busy, scrollback shows idle → flip to needs_input
      { windowId: "@1", paneId: "%2", title: "bob", command: "pi", scrollback: IDLE_SCROLLBACK },
      // orphan pi pane
      {
        windowId: "@2",
        paneId: "%50",
        title: "stranger",
        command: "pi",
        scrollback: IDLE_SCROLLBACK,
      },
      // unrelated bash pane (not an orphan)
      { windowId: "@3", paneId: "%80", title: "shell", command: "bash", scrollback: "" },
    ]);
    setTmuxExecutor(executor);

    const report = await reconcile(db, { workstream: "auth" });

    expect(report).toMatchObject({
      prunedGhosts: 1,
      statusChanges: 2,
    });
    expect(report.orphans.map((o) => o.paneId)).toEqual(["%50"]);

    // DB state matches the report.
    expect(getAgent(db, "alice", "auth")?.status).toBe("busy");
    expect(getAgent(db, "bob", "auth")?.status).toBe("needs_input");
    expect(getAgent(db, "carol", "auth")).toBeUndefined();
  });

  it("repeated reconcile is idempotent when nothing has changed", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "busy" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);

    const first = await reconcile(db, { workstream: "auth" });
    const second = await reconcile(db, { workstream: "auth" });

    // First pass detects nothing (status already busy, matches BUSY_SCROLLBACK).
    expect(first).toEqual({ prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "full" });
    expect(second).toEqual({ prunedGhosts: 0, statusChanges: 0, orphans: [], mode: "full" });
  });

  it("status update bumps updated_at", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "spawning" });
    const before = getAgent(db, "alice", "auth")?.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    await reconcile(db, { workstream: "auth" });
    const after = getAgent(db, "alice", "auth")?.updatedAt;
    expect(after).not.toBe(before);
  });

  it("does not modify rows in unrelated workstreams during status detection", async () => {
    insertAgent(db, { name: "auth-alice", workstream: "auth", paneId: "%1", status: "spawning" });
    insertAgent(db, {
      name: "billing-bob",
      workstream: "billing",
      paneId: "%2",
      status: "spawning",
    });

    const { executor } = mockTmux([
      // Both panes exist in tmux, but reconcile is called for 'auth' only.
      {
        windowId: "@1",
        paneId: "%1",
        title: "auth-alice",
        command: "pi",
        scrollback: BUSY_SCROLLBACK,
      },
      {
        windowId: "@2",
        paneId: "%2",
        title: "billing-bob",
        command: "pi",
        scrollback: BUSY_SCROLLBACK,
      },
    ]);
    setTmuxExecutor(executor);

    await reconcile(db, { workstream: "auth" });

    expect(getAgent(db, "auth-alice", "auth")?.status).toBe("busy");
    // billing-bob was NOT touched.
    expect(getAgent(db, "billing-bob", "billing")?.status).toBe("spawning");
  });
});

// ─── Manual status validation ──────────────────────────────────────────

describe("reconcile — mode: 'report-only' does not mutate (snap_undo_reconcile_destroys_recovered_agents)", () => {
  it("counts ghosts but does NOT delete the agent row", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%99", status: "busy" });
    // Empty tmux: alice's pane %99 is gone.
    const { executor } = mockTmux([]);
    setTmuxExecutor(executor);

    const report = await reconcile(db, { workstream: "auth", mode: "report-only" });

    expect(report.mode).toBe("report-only");
    expect(report.prunedGhosts).toBe(1);
    // The row is still in the DB — the report-only contract.
    expect(getAgent(db, "alice", "auth")).toBeDefined();
  });

  it("a follow-up mode:'full' pass still prunes (mode is opt-in per call)", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%99", status: "busy" });
    const { executor } = mockTmux([]);
    setTmuxExecutor(executor);

    const dry = await reconcile(db, { workstream: "auth", mode: "report-only" });
    expect(dry.prunedGhosts).toBe(1);
    expect(getAgent(db, "alice", "auth")).toBeDefined();

    // Same setup, mode:"full": deletes for real.
    const wet = await reconcile(db, { workstream: "auth" });
    expect(wet.prunedGhosts).toBe(1);
    expect(wet.mode).toBe("full");
    expect(getAgent(db, "alice", "auth")).toBeUndefined();
  });

  it("skips status detection entirely (statusChanges is always 0)", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "spawning" });
    // Pane is alive AND its scrollback would normally flip alice
    // spawning → busy. report-only must suppress that write.
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);

    const report = await reconcile(db, { workstream: "auth", mode: "report-only" });
    expect(report.mode).toBe("report-only");
    expect(report.statusChanges).toBe(0);
    // Status unchanged (no write).
    expect(getAgent(db, "alice", "auth")?.status).toBe("spawning");
  });

  it("orphan-surface still runs in report-only mode", async () => {
    // No agents in DB; one pi pane exists in tmux.
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%42", title: "orphan-1", command: "pi" },
    ]);
    setTmuxExecutor(executor);

    const report = await reconcile(db, { workstream: "auth", mode: "report-only" });
    expect(report.mode).toBe("report-only");
    expect(report.orphans.length).toBe(1);
    expect(report.orphans[0]?.paneId).toBe("%42");
  });

  it("REGRESSION (snap_dogfood Finding 2): snapshot-then-pane-killed scenario doesn't lose the agent row", async () => {
    // Mirrors the exact shape that bit dogfood-snap:
    //   1. snapshot is taken (agent + pane both alive)
    //   2. destroy kills the pane
    //   3. mu undo restores the snapshot's agents row
    //   4. post-restore reconcile sees pane is dead
    //   5. WITHOUT report-only: prunes the agents row + cascades vcs_workspaces away
    //   6. WITH    report-only: counts the would-be-prune; row stays
    insertAgent(db, { name: "dog-1", workstream: "auth", paneId: "%2919", status: "needs_input" });
    // Pane is gone in tmux (the destroy killed it).
    const { executor } = mockTmux([]);
    setTmuxExecutor(executor);

    // Simulate the post-restore reconcile pass.
    const report = await reconcile(db, { workstream: "auth", mode: "report-only" });

    expect(report.prunedGhosts).toBe(1);
    expect(report.mode).toBe("report-only");
    // The contract: the recovered row IS still here.
    const dog = getAgent(db, "dog-1", "auth");
    expect(dog).toBeDefined();
    expect(dog?.workstreamName).toBe("auth");
    expect(dog?.paneId).toBe("%2919");
  });
});

describe("reconcile — mode: 'status-only' refreshes status without pruning (bug_pane_title_glyph_stuck_at_needs_input)", () => {
  it("DOES update status from scrollback (the whole point of status-only)", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "spawning" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);

    const report = await reconcile(db, { workstream: "auth", mode: "status-only" });
    expect(report.mode).toBe("status-only");
    expect(report.statusChanges).toBe(1);
    expect(getAgent(db, "alice", "auth")?.status).toBe("busy");
  });

  it("DOES NOT prune ghost rows (the whole point of NOT being mode:'full')", async () => {
    insertAgent(db, { name: "ghost", workstream: "auth", paneId: "%999", status: "busy" });
    const { executor } = mockTmux([]); // ghost's pane is gone
    setTmuxExecutor(executor);

    const report = await reconcile(db, { workstream: "auth", mode: "status-only" });
    expect(report.mode).toBe("status-only");
    expect(report.prunedGhosts).toBe(1); // counted…
    expect(getAgent(db, "ghost", "auth")).toBeDefined(); // …but row survives
  });

  it("SKIPS status detection on placeholder agents whose pane id starts with %pending- (mid-spawn safety)", async () => {
    // Mid-spawn: spawnAgent has inserted the agent row with the
    // %pending-<name> sentinel pane id; createWorkspace is still
    // running. status-only must not capturePane on the placeholder.
    insertAgent(db, {
      name: "alice",
      workstream: "auth",
      paneId: "%pending-alice",
      status: "spawning",
    });
    // Empty tmux session (placeholder doesn't exist as a real pane).
    const { executor, calls } = mockTmux([]);
    setTmuxExecutor(executor);

    const report = await reconcile(db, { workstream: "auth", mode: "status-only" });
    expect(report.mode).toBe("status-only");
    // Status unchanged (no scrollback capture, no detector run).
    expect(getAgent(db, "alice", "auth")?.status).toBe("spawning");
    expect(report.statusChanges).toBe(0);
    // No capturePane against the fake pane id (would have errored).
    const sawCapture = calls.some((c) => c[0] === "capture-pane" && c.includes("%pending-alice"));
    expect(sawCapture).toBe(false);
    // Placeholder is NOT in tmux but status-only doesn't prune
    // (load-bearing for bug_agent_spawn_workspace_fk_failure):
    // the row survives so createWorkspace's FK insert succeeds.
    expect(getAgent(db, "alice", "auth")).toBeDefined();
  });
});

describe("reconcile — status sanity", () => {
  it("does not introduce statuses outside the AgentStatus union", async () => {
    insertAgent(db, { name: "alice", workstream: "auth", paneId: "%15", status: "spawning" });
    const { executor } = mockTmux([
      { windowId: "@1", paneId: "%15", title: "alice", command: "pi", scrollback: BUSY_SCROLLBACK },
    ]);
    setTmuxExecutor(executor);
    await reconcile(db, { workstream: "auth" });
    const status = getAgent(db, "alice", "auth")?.status;
    const valid: AgentStatus[] = [
      "spawning",
      "busy",
      "needs_input",
      "needs_permission",
      "free",
      "unreachable",
      "terminated",
    ];
    expect(status).toBeDefined();
    expect(valid).toContain(status);
  });
});
