// Misc verbs from src/agents.ts: isValidAgentName, cmdAgentShow
// fresh-status reconciliation, adoptAgent (register an existing
// tmux pane as a managed agent).
//
// Split out of test/verbs.test.ts under
// testreview_test_files_past_800loc — see test/_verbs-mock.ts for
// the shared MockState / mockTmux harness, and the sibling
// test/verbs-*.test.ts files for the rest of the verbs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentExistsError,
  getAgent,
  insertAgent,
  isValidAgentName,
  listAgents,
  spawnAgent,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { resetSleep, resetTmuxExecutor, setSleepForTests, setTmuxExecutor } from "../src/tmux.js";
import { type MockState, freshMockState, mockTmux } from "./_verbs-mock.js";

// ─── Setup / teardown ──────────────────────────────────────────────────

let tempDir: string;
let db: Db;
let state: MockState;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-verbs-misc-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  state = freshMockState();
  resetTmuxExecutor();
  setSleepForTests(async () => {}); // no-op delays in send
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetTmuxExecutor();
  resetSleep();
});

// ─── isValidAgentName ─────────────────────────────────────────────────

describe("isValidAgentName", () => {
  it("accepts lowercase identifiers", () => {
    expect(isValidAgentName("alice")).toBe(true);
    expect(isValidAgentName("a")).toBe(true);
    expect(isValidAgentName("worker_1")).toBe(true);
    expect(isValidAgentName("worker-1")).toBe(true);
    expect(isValidAgentName("a".repeat(32))).toBe(true);
  });

  it("rejects names that don't start with a letter", () => {
    expect(isValidAgentName("1alice")).toBe(false);
    expect(isValidAgentName("_alice")).toBe(false);
    expect(isValidAgentName("-alice")).toBe(false);
  });

  it("rejects uppercase, spaces, special chars", () => {
    expect(isValidAgentName("Alice")).toBe(false);
    expect(isValidAgentName("alice bob")).toBe(false);
    expect(isValidAgentName("alice/bob")).toBe(false);
    expect(isValidAgentName("alice@bob")).toBe(false);
  });

  it("rejects empty and >32 char names", () => {
    expect(isValidAgentName("")).toBe(false);
    expect(isValidAgentName("a".repeat(33))).toBe(false);
  });
});

// ─── cmdAgentShow fresh-status reconciliation ─────────────────
//
// Real bug found in real use: `mu agent show <name>` returned the
// last-persisted status, not the current one, because the handler
// read agents.status from the DB row and never re-detected. With
// custom --command wrappers in particular, the orchestrator could
// miss needs_input for minutes. The fix re-runs detectPiStatus on
// the scrollback the handler already captures.

describe("cmdAgentShow fresh-status reconciliation", () => {
  it("updates agents.status from the freshly captured scrollback", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const agent = await spawnAgent(db, { name: "worker-1", workstream: "auth" });
    const pane = state.panes.get(agent.paneId);
    if (!pane) throw new Error("setup: pane missing after spawn");

    // Force the persisted status to a stale value (not what the
    // scrollback says).
    db.prepare("UPDATE agents SET status = 'free' WHERE name = ?").run("worker-1");
    expect(getAgent(db, "worker-1", "auth")?.status).toBe("free");

    // Now plant a busy-shaped scrollback. detectPiStatus recognises
    // "esc to interrupt" as the active-work marker.
    pane.scrollback = "Working on the refactor... (Esc to interrupt)";

    // Drive the CLI: `mu agent show worker-1 --json`. cmdAgentShow
    // should re-detect from the captured scrollback and flip
    // agents.status to busy.
    const { buildProgram } = await import("../src/cli.js");
    const originalLog = console.log;
    let stdout = "";
    // biome-ignore lint/suspicious/noExplicitAny: shim signature matches what we need
    console.log = (...args: any[]) => {
      stdout += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    };
    const originalDb = process.env.MU_DB_PATH;
    process.env.MU_DB_PATH = join(tempDir, "mu.db");
    try {
      const program = buildProgram();
      program.exitOverride();
      await program.parseAsync(["node", "mu", "agent", "show", "worker-1", "-w", "auth", "--json"]);
    } finally {
      console.log = originalLog;
      if (originalDb === undefined) {
        const key = "MU_DB_PATH";
        delete process.env[key];
      } else {
        process.env.MU_DB_PATH = originalDb;
      }
    }

    // The persisted row should now be 'busy' (status was reconciled).
    expect(getAgent(db, "worker-1", "auth")?.status).toBe("busy");

    // The JSON payload should also reflect 'busy' (the displayed-row
    // refresh path).
    const parsed = JSON.parse(stdout.trim()) as { agent: { status: string } };
    expect(parsed.agent.status).toBe("busy");
  });

  it("keeps 'free' sticky against an idle prompt (mirrors reconcile)", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const agent = await spawnAgent(db, { name: "worker-2", workstream: "auth" });
    const pane = state.panes.get(agent.paneId);
    if (!pane) throw new Error("setup: pane missing after spawn");

    db.prepare("UPDATE agents SET status = 'free' WHERE name = ?").run("worker-2");

    // "❯ " alone is detected as needs_input (idle prompt). 'free' is
    // sticky against needs_input — user-marked-free shouldn't bounce
    // back to busy on a quiet prompt.
    pane.scrollback = "❯ ";

    const { buildProgram } = await import("../src/cli.js");
    const originalLog = console.log;
    // biome-ignore lint/suspicious/noExplicitAny: shim
    console.log = (..._args: any[]) => {};
    const originalDb = process.env.MU_DB_PATH;
    process.env.MU_DB_PATH = join(tempDir, "mu.db");
    try {
      const program = buildProgram();
      program.exitOverride();
      await program.parseAsync(["node", "mu", "agent", "show", "worker-2", "-w", "auth", "--json"]);
    } finally {
      console.log = originalLog;
      if (originalDb === undefined) {
        const key = "MU_DB_PATH";
        delete process.env[key];
      } else {
        process.env.MU_DB_PATH = originalDb;
      }
    }

    // Status should still be 'free' — shouldOverwrite kept it sticky.
    expect(getAgent(db, "worker-2", "auth")?.status).toBe("free");
  });
});

// ─── adoptAgent ────────────────────────────────────────────────────────

describe("adoptAgent (register an existing tmux pane as a managed agent)", () => {
  // Seed an orphan pane: pretend a session exists with one pane that
  // wasn't created via spawn. mu adopt then registers it.
  function seedOrphanPane(opts: {
    sessionName: string;
    title: string;
    paneId?: string;
    command?: string;
  }): { paneId: string; windowId: string } {
    state.sessions.add(opts.sessionName);
    const windowId = `@${state.nextWindowId++}`;
    const paneId = opts.paneId ?? `%${state.nextPaneId++}`;
    state.windows.set(opts.sessionName, [{ id: windowId, name: "main" }]);
    state.panes.set(paneId, {
      windowId,
      paneId,
      title: opts.title,
      command: opts.command ?? "pi",
    });
    return { paneId, windowId };
  }

  it("(case 1) adopt by pane id, pane title is already a valid agent name -> insert, no retitle", async () => {
    const { calls, executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");

    const { paneId } = seedOrphanPane({ sessionName: "mu-auth", title: "worker-2" });
    const result = await adoptAgent(db, { paneId, workstream: "auth" });

    expect(result.alreadyAdopted).toBe(false);
    expect(result.previousTitle).toBe("worker-2");
    expect(result.paneTitleSetTo).toBe("worker-2");
    expect(result.agent.name).toBe("worker-2");
    expect(result.agent.paneId).toBe(paneId);
    expect(result.agent.workstreamName).toBe("auth");
    expect(result.agent.status).toBe("free");
    expect(getAgent(db, "worker-2", "auth")).toMatchObject({ name: "worker-2", paneId });
    // No select-pane -T call (no retitle).
    expect(calls.find((c) => c[0] === "select-pane")).toBeUndefined();
  });

  it("(case 2) adopt by pane id, --name differs from title -> retitle + insert", async () => {
    const { calls, executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");

    const { paneId } = seedOrphanPane({ sessionName: "mu-auth", title: "old-title" });
    const result = await adoptAgent(db, { paneId, workstream: "auth", name: "worker-2" });

    expect(result.alreadyAdopted).toBe(false);
    expect(result.previousTitle).toBe("old-title");
    expect(result.paneTitleSetTo).toBe("worker-2");
    expect(result.agent.name).toBe("worker-2");
    // pane retitled
    expect(state.panes.get(paneId)?.title).toBe("worker-2");
    // exactly one select-pane -T call
    const retitleCalls = calls.filter(
      (c) => c[0] === "select-pane" && c.includes("-T") && c.includes("worker-2"),
    );
    expect(retitleCalls.length).toBe(1);
  });

  it("(case 3) adopt by pane id that doesn't exist -> PaneNotFoundError", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");
    const { PaneNotFoundError } = await import("../src/tmux.js");

    state.sessions.add("mu-auth"); // session exists, pane doesn't
    state.windows.set("mu-auth", [{ id: "@1", name: "main" }]);
    await expect(adoptAgent(db, { paneId: "%999", workstream: "auth" })).rejects.toBeInstanceOf(
      PaneNotFoundError,
    );
  });

  it("(case 4) adopt where the resolved name collides with existing agent -> AgentExistsError", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");

    // Pre-seed a different agent named "worker-2".
    insertAgent(db, {
      name: "worker-2",
      workstream: "auth",
      paneId: "%50",
      status: "free",
    });
    const { paneId } = seedOrphanPane({ sessionName: "mu-auth", title: "worker-2" });
    await expect(adoptAgent(db, { paneId, workstream: "auth" })).rejects.toBeInstanceOf(
      AgentExistsError,
    );
  });

  it("(case 5) adopt by pane id from a different tmux session -> AgentNotInWorkstreamError", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");
    const { AgentNotInWorkstreamError } = await import("../src/agents.js");

    // Pane lives in session 'mu-other', adopt is targeting workstream 'auth'.
    const { paneId } = seedOrphanPane({ sessionName: "mu-other", title: "worker-2" });
    state.sessions.add("mu-auth"); // target session also exists, just empty
    state.windows.set("mu-auth", []);
    await expect(adoptAgent(db, { paneId, workstream: "auth" })).rejects.toBeInstanceOf(
      AgentNotInWorkstreamError,
    );
  });

  it("(case 6) adopt twice with same input -> alreadyAdopted=true (idempotent)", async () => {
    const { calls, executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");

    const { paneId } = seedOrphanPane({ sessionName: "mu-auth", title: "worker-2" });
    const first = await adoptAgent(db, { paneId, workstream: "auth" });
    expect(first.alreadyAdopted).toBe(false);

    const callsBefore = calls.length;
    const second = await adoptAgent(db, { paneId, workstream: "auth" });
    expect(second.alreadyAdopted).toBe(true);
    expect(second.agent.name).toBe("worker-2");
    expect(second.agent.paneId).toBe(paneId);
    // Idempotent path should not insert again — exactly one row.
    expect(listAgents(db).length).toBe(1);
    // The second call may make tmux probe calls (paneExists, list-panes) but
    // must NOT call select-pane (no retitle on idempotent path).
    const retitlesAfter = calls
      .slice(callsBefore)
      .filter((c) => c[0] === "select-pane" && c.includes("-T"));
    expect(retitlesAfter.length).toBe(0);
  });

  it("(case 7) adopt by pane id whose title is not a valid agent name and no --name -> error", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");

    // Title is 'pi' (the bare CLI name) — not a valid agent name? Actually
    // 'pi' IS valid (lowercase, starts with letter). Use a clearly invalid one.
    const { paneId } = seedOrphanPane({ sessionName: "mu-auth", title: "Bad Title!" });
    await expect(adoptAgent(db, { paneId, workstream: "auth" })).rejects.toThrow(
      /not a valid agent name/,
    );
  });

  it("(case 8) adopt --cli claude --role read-only sets those columns correctly", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");

    const { paneId } = seedOrphanPane({
      sessionName: "mu-auth",
      title: "worker-2",
      command: "claude",
    });
    const result = await adoptAgent(db, {
      paneId,
      workstream: "auth",
      cli: "claude",
      role: "read-only",
    });
    expect(result.agent.cli).toBe("claude");
    expect(result.agent.role).toBe("read-only");
  });

  it("auto-creates the workstreams row if missing (matches spawn ergonomics)", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");

    const { paneId } = seedOrphanPane({ sessionName: "mu-fresh", title: "worker-2" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name='fresh'").get()).toEqual({
      n: 0,
    });

    await adoptAgent(db, { paneId, workstream: "fresh" });

    expect(db.prepare("SELECT COUNT(*) AS n FROM workstreams WHERE name='fresh'").get()).toEqual({
      n: 1,
    });
  });

  it("emits an 'agent adopt' event into agent_logs", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { adoptAgent } = await import("../src/agents.js");
    const { listLogs } = await import("../src/logs.js");

    const { paneId } = seedOrphanPane({ sessionName: "mu-auth", title: "worker-2" });
    await adoptAgent(db, { paneId, workstream: "auth" });

    const logs = listLogs(db, { workstream: "auth", kind: "event" });
    const adoptEvents = logs.filter((l) => l.payload.startsWith("agent adopt"));
    expect(adoptEvents.length).toBe(1);
    expect(adoptEvents[0]?.payload).toContain("worker-2");
    expect(adoptEvents[0]?.payload).toContain(paneId);
  });

  // Regression: bug_adopt_verb_unwired. cmdAdopt + adoptAgent are
  // implemented and tested above, but the f42e86d wireXxxCommands
  // refactor dropped the `program.command("adopt")` registration on
  // the floor, so `mu adopt %15` returned commander's "too many
  // arguments" parse error. The verb is intentionally TOP-LEVEL
  // (`mu adopt <pane>`, not `mu agent adopt <pane>`) per its design
  // and per every doc/skill/orphan-hint reference. This test asserts
  // commander accepts the verb shape — the body of cmdAdopt is
  // covered by the (case 1–8) tests above.
  it("is wired on the top-level program (mu adopt <pane>, not mu agent adopt)", async () => {
    const { executor } = mockTmux(state);
    setTmuxExecutor(executor);
    const { paneId } = seedOrphanPane({ sessionName: "mu-auth", title: "worker-9" });

    const { runCli } = await import("./_runCli.js");
    const result = await runCli(["adopt", paneId, "-w", "auth"], join(tempDir, "mu.db"));

    // Pre-fix: stderr would contain commander's "too many arguments.
    // Expected 0 arguments but got 2." Now: the verb is wired, so
    // either it succeeds or it surfaces a typed error from cmdAdopt /
    // adoptAgent (e.g. AgentNotInWorkstreamError if the seeded pane
    // were in another session). Whatever happens, it must NOT be the
    // commander parse error.
    expect(result.error).toBeUndefined();
    expect(result.stderr).not.toMatch(/too many arguments/);
    expect(result.stderr).not.toMatch(/unknown command/);
    // And the agent should now be adopted (the seed put it in mu-auth,
    // matching the -w auth target).
    expect(getAgent(db, "worker-9", "auth")?.paneId).toBe(paneId);
  });

  it("`mu adopt --help` produces the verb's own help screen, not the program-level one", async () => {
    const { runCli } = await import("./_runCli.js");
    const result = await runCli(["adopt", "--help"], join(tempDir, "mu.db"));
    // commander.exitOverride() throws CommanderError on --help (code
    // 'commander.helpDisplayed') which runCli filters — so error is
    // undefined and the help text lands on stdout.
    expect(result.error).toBeUndefined();
    expect(result.stdout).toMatch(/Usage: mu adopt/);
    expect(result.stdout).toMatch(/<pane-or-title>/);
  });
});
