// Tests for the unified `mu state` verb.
//
// `mu state` owns the static state card and the opt-in TUI:
//
//   mu state             default: full top-to-bottom card
//   mu state --tui       interactive ink dashboard (read-only)
//
// `--tui` is mutually exclusive with `--json`. All
// modes accept variadic `-w X[,Y]...` / `-w X -w Y` and `--all`.
//
// Tests exercise: full render, mutual-exclusion error,
// cross-workstream handling, and JSON shapes per spec. TUI specifics
// live in the `test/tui-*.test.ts` files.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalNoColor = vi.hoisted(() => process.env.NO_COLOR);

// Force colorless output for the whole file (literal-substring
// assertions vs ANSI escapes). The `pc` instance is baked at
// src/output.ts module-load time; vi.hoisted runs before imports.
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

// ── default mode (full top-to-bottom card) ─────────────────────────

describe("mu state — default (full) mode", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-full-"));
    dbPath = join(tempDir, "mu.db");
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
    } catch {}
  });

  it("renders every full-mode section heading top-to-bottom", async () => {
    const { stdout, exitCode } = await runCli(["state", "-w", "ws"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("State of mu-ws");
    expect(stdout).toContain("Agents (");
    expect(stdout).toContain("Tracks (");
    expect(stdout).toContain("Ready (");
    expect(stdout).toContain("In progress (");
    expect(stdout).toContain("Blocked (");
    expect(stdout).toContain("Recent closed (");
    expect(stdout).toContain("Workspaces (");
    expect(stdout).toContain("Recent events");
  });

  it("--json emits the unified flat shape (single workstream)", async () => {
    const { stdout, exitCode } = await runCli(["state", "-w", "ws", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    // Spec: { workstreamName, agents, orphans, tracks, ready, blocked,
    //         inProgress, recentClosed, workspaces, recent,
    //         recentCommits } (flat).
    expect(parsed.workstreamName).toBe("ws");
    expect(parsed.agents).toEqual([]);
    expect(parsed.orphans).toEqual([]);
    expect(parsed.tracks).toEqual([
      expect.objectContaining({
        roots: [expect.objectContaining({ name: "alpha", title: "A" })],
        readyCount: 1,
      }),
      expect.objectContaining({
        roots: [expect.objectContaining({ name: "beta", title: "B" })],
        readyCount: 1,
      }),
    ]);
    expect(parsed.ready).toEqual([
      expect.objectContaining({ name: "beta", title: "B", status: "OPEN", roi: 60 }),
      expect.objectContaining({ name: "alpha", title: "A", status: "OPEN", roi: 50 }),
    ]);
    expect(parsed.blocked).toEqual([]);
    expect(parsed.inProgress).toEqual([]);
    expect(parsed.recentClosed).toEqual([]);
    expect(parsed.workspaces).toEqual([]);
    expect(parsed.recentCommits).toEqual([]);
    expect(parsed.recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          payload: expect.stringContaining("task add alpha"),
        }),
        expect.objectContaining({
          kind: "event",
          payload: expect.stringContaining("task add beta"),
        }),
      ]),
    );
  });

  it("multi-ws --json wraps per-ws shapes in { workstreams: [...] }", async () => {
    await runCli(["workstream", "init", "ws2", "--json"], dbPath);
    await runCli(
      ["task", "add", "gamma", "-w", "ws2", "--title", "G", "-i", "10", "-e", "1", "--json"],
      dbPath,
    );
    const { stdout, exitCode } = await runCli(["state", "-w", "ws,ws2", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.workstreams).toEqual([
      expect.objectContaining({
        workstreamName: "ws",
        ready: expect.arrayContaining([
          expect.objectContaining({ name: "alpha", title: "A", status: "OPEN" }),
          expect.objectContaining({ name: "beta", title: "B", status: "OPEN" }),
        ]),
        blocked: [],
        workspaces: [],
      }),
      expect.objectContaining({
        workstreamName: "ws2",
        ready: [expect.objectContaining({ name: "gamma", title: "G", status: "OPEN" })],
        blocked: [],
        workspaces: [],
      }),
    ]);
  });
});

// ── mutual exclusion + cross-workstream ────────────────────────────

describe("mu state — mutual-exclusion + cross-workstream", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-state-mux-"));
    dbPath = join(tempDir, "mu.db");
    for (const w of ["alpha", "beta", "gamma"]) {
      await runCli(["workstream", "init", w, "--json"], dbPath);
      await runCli(
        ["task", "add", `t_${w}`, "-w", w, "--title", `T-${w}`, "-i", "50", "-e", "1", "--json"],
        dbPath,
      );
    }
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("--all + -w errors as a UsageError (mutually exclusive)", async () => {
    const { stderr, exitCode } = await runCli(["state", "--all", "-w", "alpha"], dbPath);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("mutually exclusive");
  });

  it("cross-workstream works in default mode (-w X,Y stacks per-ws cards)", async () => {
    const { stdout, exitCode } = await runCli(["state", "-w", "alpha,beta"], dbPath);
    expect(exitCode).toBeNull();
    expect(stdout).toContain("State of mu-alpha");
    expect(stdout).toContain("State of mu-beta");
    expect(stdout).not.toContain("State of mu-gamma");
  });

  it("-w with one bad name errors as WorkstreamNotFoundError", async () => {
    const { stderr, exitCode } = await runCli(["state", "-w", "alpha,nope"], dbPath);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("nope");
  });
});

// ── classifyEventVerb regression: emitted SDK events are recognised ──
//
// Per the TUI refactor (Wave 2 Task 10): the parsing half of the previous
// event colourer lives at src/logs.ts as `classifyEventVerb` (verb
// extraction only; renderers apply their own colour). These tests pin the
// parser contract and then drive representative SDK verbs that emit every
// known event prefix, asserting the payloads users actually see in
// agent_logs classify successfully.
describe("classifyEventVerb", () => {
  it("recognises every verb in EVENT_VERB_PREFIXES", async () => {
    const { EVENT_VERB_PREFIXES, classifyEventVerb } = await import("../src/logs.js");
    expect(EVENT_VERB_PREFIXES.length).toBeGreaterThan(0);
    for (const verb of EVENT_VERB_PREFIXES) {
      const payload = `${verb} alpha (extra info)`;
      const r = classifyEventVerb(payload);
      expect(r, `verb '${verb}' should classify`).not.toBeNull();
      expect(r?.verb).toBe(verb);
      expect(r?.rest).toBe(" alpha (extra info)");
    }
  });

  it("returns null for unknown payloads (no false-positive matches)", async () => {
    const { classifyEventVerb } = await import("../src/logs.js");
    for (const payload of [
      "random freeform message",
      "approve granted slug",
      "snapshot capture foo",
      "taskaddendum sneaky",
    ]) {
      expect(classifyEventVerb(payload)).toBeNull();
    }
  });

  it("recognises payloads emitted by representative SDK state-changing verbs", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const {
      AgentNotFoundError,
      adoptAgent,
      closeAgent,
      freeAgent,
      insertAgent,
      resetCommandResolverForTests,
      setCommandResolverForTests,
      spawnAgent,
    } = await import("../src/agents.js");
    const { kickAgent, resetKickProcessExecutor, setKickProcessExecutor } = await import(
      "../src/agents/kick.js"
    );
    const { createArchive, addToArchive, removeFromArchive, deleteArchive } = await import(
      "../src/archives.js"
    );
    const { openDb } = await import("../src/db.js");
    const { exportArchive } = await import("../src/exporting.js");
    const { importBucket } = await import("../src/importing.js");
    const { classifyEventVerb, displayEventPayload, listLogs } = await import("../src/logs.js");
    const {
      addBlockEdge,
      addNote,
      addTask,
      closeTask,
      deleteTask,
      removeBlockEdge,
      openTask,
      reparentTask,
      setWaitSleepForTests,
      setWaitStuckWarnForTests,
      waitForTasks,
    } = await import("../src/tasks.js");
    const { claimTask, releaseTask } = await import("../src/tasks/claim.js");
    const { deferTask, rejectTask } = await import("../src/tasks/lifecycle.js");
    const { resetTmuxExecutor, setTmuxExecutor } = await import("../src/tmux.js");
    const { createWorkspace, freeWorkspace, recreateWorkspace, refreshWorkspace } = await import(
      "../src/workspace.js"
    );
    const { destroyWorkstream, ensureWorkstream, exportWorkstream } = await import(
      "../src/workstream.js"
    );
    const { freshMockState, mockTmux } = await import("./_verbs-mock.js");

    const tempDir = mkdtempSync(join(tmpdir(), "mu-state-render-events-"));
    const db = openDb({ path: join(tempDir, "mu.db") });
    const previousWaitSleep = setWaitSleepForTests(async () => {});
    const previousStuckWarn = setWaitStuckWarnForTests(() => {});
    const originalStateDir = process.env.MU_STATE_DIR;
    const originalSpawnLiveness = process.env.MU_SPAWN_LIVENESS_MS;
    process.env.MU_STATE_DIR = join(tempDir, "state");
    process.env.MU_SPAWN_LIVENESS_MS = "0";

    const captured = new Map<string, string>();
    const captureNewEvents = (fn: () => unknown | Promise<unknown>): Promise<void> =>
      Promise.resolve().then(() => {
        const before = listLogs(db, { kind: "event" }).map((r) => r.seq);
        const highWater = before.length === 0 ? 0 : Math.max(...before);
        return Promise.resolve(fn()).then(() => {
          for (const event of listLogs(db, { kind: "event", since: highWater })) {
            const visiblePayload = displayEventPayload(event.payload);
            const classified = classifyEventVerb(visiblePayload);
            expect(classified, `payload should classify: ${visiblePayload}`).not.toBeNull();
            if (classified) captured.set(classified.verb, visiblePayload);
          }
        });
      });

    try {
      setCommandResolverForTests(async (command) => ({
        ok: true,
        binary: command,
        resolvedPath: command,
      }));
      await captureNewEvents(() => ensureWorkstream(db, "events"));
      await captureNewEvents(() => ensureWorkstream(db, "agents"));
      const tmuxState = freshMockState();
      const { executor } = mockTmux(tmuxState);
      setTmuxExecutor(executor);
      await captureNewEvents(() => spawnAgent(db, { name: "worker-1", workstream: "agents" }));
      await captureNewEvents(() => freeAgent(db, "worker-1", "agents"));
      const orphanWindowId = `@${tmuxState.nextWindowId++}`;
      const orphanPaneId = `%${tmuxState.nextPaneId++}`;
      tmuxState.windows.get("mu-agents")?.push({ id: orphanWindowId, name: "orphan" });
      tmuxState.panes.set(orphanPaneId, {
        windowId: orphanWindowId,
        paneId: orphanPaneId,
        title: "orphan-1",
        command: "pi",
      });
      await captureNewEvents(() =>
        adoptAgent(db, { paneId: orphanPaneId, workstream: "agents", cli: "pi" }),
      );
      await captureNewEvents(() => closeAgent(db, "worker-1", { workstream: "agents" }));
      resetTmuxExecutor();

      await captureNewEvents(() =>
        addTask(db, {
          localId: "base",
          workstream: "events",
          title: "Base",
          impact: 50,
          effortDays: 1,
        }),
      );
      addTask(db, {
        localId: "blocked",
        workstream: "events",
        title: "Blocked",
        impact: 40,
        effortDays: 1,
      });
      await captureNewEvents(() => addNote(db, "base", "note", { workstream: "events" }));
      await captureNewEvents(() => addBlockEdge(db, "events", "blocked", "base"));
      await captureNewEvents(() => reparentTask(db, "blocked", [], { workstream: "events" }));
      await captureNewEvents(() => addBlockEdge(db, "events", "blocked", "base"));
      await captureNewEvents(() => removeBlockEdge(db, "events", "blocked", "base"));
      await captureNewEvents(() =>
        claimTask(db, "base", { self: true, actor: "tester", workstream: "events" }),
      );
      await captureNewEvents(() => releaseTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() => openTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() => closeTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() => openTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() => rejectTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() => openTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() => deferTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() => openTask(db, "base", { workstream: "events" }));
      await captureNewEvents(() =>
        deleteTask(db, "blocked", "events", {
          dryRun: false,
        }),
      );

      insertAgent(db, { name: "worker-1", workstream: "events", paneId: "%15", status: "busy" });
      await captureNewEvents(() =>
        createWorkspace(db, {
          agent: "worker-1",
          workstream: "events",
          projectRoot: tempDir,
          backend: "none",
        }),
      );
      await captureNewEvents(() =>
        recreateWorkspace(db, "worker-1", {
          workstream: "events",
          projectRoot: tempDir,
        }),
      );
      await captureNewEvents(() =>
        freeWorkspace(db, "worker-1", { workstream: "events", commit: false }),
      );
      await expect(
        createWorkspace(db, {
          agent: "ghost-1",
          workstream: "events",
          projectRoot: tempDir,
          backend: "none",
        }),
      ).rejects.toBeInstanceOf(AgentNotFoundError);
      const workspaceCreateFailures = listLogs(db, { workstream: "events", kind: "event" }).filter(
        (r) => r.payload.startsWith("workspace create ghost-1"),
      );
      expect(workspaceCreateFailures).toEqual([]);

      const gitRoot = mkdtempSync(join(tempDir, "git-project-"));
      execFileSync("git", ["init"], { cwd: gitRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "mu@test.local"], {
        cwd: gitRoot,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "mu test"], { cwd: gitRoot, stdio: "ignore" });
      writeFileSync(join(gitRoot, "README.md"), "hello\n");
      execFileSync("git", ["add", "README.md"], { cwd: gitRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: gitRoot, stdio: "ignore" });
      await createWorkspace(db, {
        agent: "worker-1",
        workstream: "events",
        projectRoot: gitRoot,
        backend: "git",
      });
      await captureNewEvents(() =>
        refreshWorkspace(db, { agent: "worker-1", workstream: "events", fromRef: "HEAD" }),
      );

      await captureNewEvents(async () => {
        setTmuxExecutor(async (args) => {
          if (args[0] === "display-message" && args.includes("#{pane_tty}")) {
            return { stdout: "/dev/ttys999\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "unexpected tmux call", exitCode: 1 };
        });
        setKickProcessExecutor(async (cmd) => {
          if (cmd === "ps") return { stdout: "12345 12345 R+ find\n", stderr: "", exitCode: 0 };
          if (cmd === "kill") return { stdout: "", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "unexpected process call", exitCode: 1 };
        });
        await kickAgent(db, "worker-1", { workstream: "events" });
      });
      resetTmuxExecutor();
      resetKickProcessExecutor();

      addTask(db, {
        localId: "stalled",
        workstream: "events",
        title: "Stalled",
        impact: 30,
        effortDays: 1,
      });
      insertAgent(db, {
        name: "idle-1",
        workstream: "events",
        paneId: "%16",
        status: "needs_input",
      });
      await claimTask(db, "stalled", {
        agentName: "idle-1",
        workstream: "events",
        evidence: "stall fixture",
      });
      db.prepare("UPDATE agents SET updated_at = ? WHERE name = ?").run(
        "2000-01-01T00:00:00.000Z",
        "idle-1",
      );
      await captureNewEvents(() =>
        waitForTasks(db, ["stalled"], {
          workstream: "events",
          timeoutMs: 1,
          stuckAfterMs: 1,
        }),
      );

      await captureNewEvents(() =>
        exportWorkstream(db, { workstream: "events", outDir: join(tempDir, "bucket") }),
      );
      await captureNewEvents(() => createArchive(db, "arc"));
      await captureNewEvents(() => addToArchive(db, "arc", "events"));
      await captureNewEvents(() =>
        exportArchive(db, { label: "arc", outDir: join(tempDir, "arc-bucket") }),
      );
      await captureNewEvents(() => removeFromArchive(db, "arc", "events"));
      await captureNewEvents(() => deleteArchive(db, "arc"));

      const bucketRoot = join(tempDir, "bucket");
      await captureNewEvents(() =>
        importBucket(db, { bucketDir: bucketRoot, workstreamOverride: "imported" }),
      );

      await captureNewEvents(async () => {
        setTmuxExecutor(async (args) => {
          if (args[0] === "has-session") return { stdout: "", stderr: "missing", exitCode: 1 };
          return { stdout: "", stderr: "unexpected tmux call", exitCode: 1 };
        });
        await destroyWorkstream(db, { workstream: "imported" });
      });
      resetTmuxExecutor();

      const expected = [
        "agent adopt",
        "agent close",
        "agent free",
        "agent kick",
        "agent spawn",
        "agent stalled",
        "archive add",
        "archive create",
        "archive delete",
        "archive export",
        "archive remove",
        "task add",
        "task block",
        "task claim",
        "task delete",
        "task note",
        "task reparent",
        "task release",
        "task status",
        "task unblock",
        "workstream destroy",
        "workstream export",
        "workstream import",
        "workstream init",
        "workspace create",
        "workspace free",
        "workspace recreate",
        "workspace refresh",
      ];
      expect([...captured.keys()].sort()).toEqual(expected.sort());
    } finally {
      setWaitSleepForTests(previousWaitSleep);
      setWaitStuckWarnForTests(previousStuckWarn);
      resetCommandResolverForTests();
      resetTmuxExecutor();
      resetKickProcessExecutor();
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
      if (originalStateDir === undefined) {
        const key = "MU_STATE_DIR";
        delete process.env[key];
      } else {
        process.env.MU_STATE_DIR = originalStateDir;
      }
      if (originalSpawnLiveness === undefined) {
        const key = "MU_SPAWN_LIVENESS_MS";
        delete process.env[key];
      } else {
        process.env.MU_SPAWN_LIVENESS_MS = originalSpawnLiveness;
      }
    }
  });
});
