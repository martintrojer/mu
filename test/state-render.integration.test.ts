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
    // v2-log-verb renamed the heading: it is no longer "of kind=event"
    // (that entity is retired), it is the last N ops.
    expect(stdout).toContain("Recent activity");
  });

  it("--json emits the unified flat shape (single workstream)", async () => {
    const { stdout, exitCode } = await runCli(["state", "-w", "ws", "--json"], dbPath);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    // Spec: { workstreamName, agents, orphans, tracks, ready, blocked,
    //         inProgress, recentClosed, workspaces, recent,
    //         recentCommits, commitsBackend } (flat).
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
    expect(parsed.commitsBackend).toBeNull();
    // v2-retire-log-shim: `recent` shows captured ops. Both task adds
    // appear as typed ops keyed by natural key, not as prose events.
    expect(parsed.recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task",
          intent: "task.add",
          workstreamName: "ws/alpha",
        }),
        expect.objectContaining({
          kind: "task",
          intent: "task.add",
          workstreamName: "ws/beta",
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
// v2-log-verb retired the prose parser (classifyEventVerb). Rendering now
// keys on `intent` via src/log-render.ts. These tests pin the FORMATTER
// contract and then drive representative SDK verbs, asserting that every
// op a real session emits renders as prose a human can read.
describe("the op formatter", () => {
  it("renders every known intent with a verb and no raw JSON", async () => {
    const { KNOWN_INTENTS, renderOp } = await import("../src/log-render.js");
    expect(KNOWN_INTENTS.length).toBeGreaterThan(0);
    for (const intent of KNOWN_INTENTS) {
      const r = renderOp({
        intent,
        kind: intent.slice(0, intent.indexOf(".")),
        workstreamName: "alpha/t1",
        payload: '{"status":"OPEN"}',
        source: "system",
        op: "put",
      });
      expect(r, `intent '${intent}' should render`).not.toBeNull();
      expect(r?.verb.length).toBeGreaterThan(0);
    }
  });

  it("returns null for intentless prose so callers show it verbatim", async () => {
    const { renderOp } = await import("../src/log-render.js");
    for (const payload of [
      "random freeform message",
      "approve granted slug",
      "snapshot capture foo",
    ]) {
      expect(
        renderOp({
          intent: null,
          kind: "message",
          workstreamName: "alpha",
          payload,
          source: "user",
          op: "put",
        }),
      ).toBeNull();
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
      insertAgent,
      resetCommandResolverForTests,
      setCommandResolverForTests,
      spawnAgent,
    } = await import("../src/agents.js");
    const { kickAgent, resetKickProcessExecutor, setKickProcessExecutor } = await import(
      "../src/agents/kick.js"
    );
    const { openDb } = await import("../src/db.js");
    const { KNOWN_INTENTS, KNOWN_VERBS, renderOp } = await import("../src/log-render.js");
    const { listLogs } = await import("../src/logs.js");
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
    const { resetTmuxExecutor, setTmuxExecutor } = await import("../src/tmux.js");
    const { createWorkspace, freeWorkspace, recreateWorkspace, refreshWorkspace } = await import(
      "../src/workspace.js"
    );
    const { destroyWorkstream, ensureWorkstream, exportWorkstream } = await import(
      "../src/workstream.js"
    );
    const { freshMockState, mockTmux } = await import("./_verbs-mock.js");

    const tempDir = mkdtempSync(join(tmpdir(), "mu-state-render-events-"));
    const noneProjectRoot = mkdtempSync(join(tmpdir(), "mu-state-render-events-project-"));
    writeFileSync(join(noneProjectRoot, "README"), "hello\n");
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
        // Only hand-written emitEvent survivors are prose. Captured ops
        // carry JSON payloads and a typed intent, and are classified by
        // intent (v2-log-verb), never by prefix — so scope this audit to
        // the entities emitEvent still writes.
        const localEntities = ["agent", "workspace", "workstream"];
        const isLocalEmit = (r: {
          kind: string;
          intent: string | null;
          payload: string;
        }): boolean =>
          r.intent !== null && localEntities.includes(r.kind) && !r.payload.startsWith("{");
        const rows = listLogs(db, {}).filter(isLocalEmit);
        const highWater = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.seq));
        return Promise.resolve(fn()).then(() => {
          for (const event of listLogs(db, { since: highWater })) {
            if (!isLocalEmit(event)) continue;
            const rendered = renderOp(event);
            expect(rendered, `op should render: ${event.intent} ${event.payload}`).not.toBeNull();
            // Every emitted intent must be one the formatter knows, or
            // mu log would fall back to the unknown-intent shape.
            expect(KNOWN_INTENTS, `${event.intent} must be known`).toContain(event.intent);
            if (rendered) captured.set(rendered.verb, event.payload);
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
          projectRoot: noneProjectRoot,
          backend: "none",
        }),
      );
      await captureNewEvents(() =>
        recreateWorkspace(db, "worker-1", {
          workstream: "events",
          projectRoot: noneProjectRoot,
        }),
      );
      await captureNewEvents(() =>
        freeWorkspace(db, "worker-1", { workstream: "events", commit: false }),
      );
      await expect(
        createWorkspace(db, {
          agent: "ghost-1",
          workstream: "events",
          projectRoot: noneProjectRoot,
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
      ensureWorkstream(db, "doomed");
      await captureNewEvents(async () => {
        setTmuxExecutor(async (args) => {
          if (args[0] === "has-session") return { stdout: "", stderr: "missing", exitCode: 1 };
          return { stdout: "", stderr: "unexpected tmux call", exitCode: 1 };
        });
        await destroyWorkstream(db, { workstream: "doomed" });
      });
      resetTmuxExecutor();

      // v2-retire-log-shim: the 11 task.* / workstream.init /
      // workstream.destroy prose emits are GONE — each duplicated a
      // capture-trigger op that already had a real intent and key. What
      // survives is exactly the set no trigger can see: `agents` and
      // `vcs_workspaces` are machine-local, `agent stalled` mutates
      // nothing, and `workstream export` writes files.
      const expected = [
        "agent adopt",
        "agent close",
        "agent kick",
        "agent spawn",
        "agent stalled",
        "workspace create",
        "workspace free",
        "workspace recreate",
        "workspace refresh",
        "workstream export",
      ];
      expect([...captured.keys()].sort()).toEqual(expected.sort());
      // Every verb the session produced must be one the formatter
      // declares, so a new emitter cannot be added without teaching the
      // formatter about it (v2-log-verb replaced the prefix list with
      // the intent-keyed verb table).
      const knownVerbs = new Set(KNOWN_VERBS);
      for (const verb of captured.keys()) {
        expect(knownVerbs, `${verb} must be a declared verb`).toContain(verb);
      }
    } finally {
      setWaitSleepForTests(previousWaitSleep);
      setWaitStuckWarnForTests(previousStuckWarn);
      resetCommandResolverForTests();
      resetTmuxExecutor();
      resetKickProcessExecutor();
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(noneProjectRoot, { recursive: true, force: true });
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
