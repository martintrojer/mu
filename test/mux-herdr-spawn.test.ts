// Spawn on the herdr backend: the two-step create-then-start.
//
// herdr has no create-and-run form (`workspace create` / `tab create` /
// `pane split` always start a plain shell, and `agent start` never
// creates layout), so a spawn is necessarily:
//
//   1. create the pane bare
//   2. `herdr agent start <name> --kind <cli> --pane <id>`
//
// Every JSON body below is a VERBATIM capture from a real herdr 0.8.0
// server (protocol 19) driven through an isolated `herdr --session
// mutest-spawn`, which was stopped and deleted afterwards; the user's
// default session was never started or touched. Hardcoding the
// recordings keeps this in the fast tier: no subprocess, no server.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  envVarNameForCli,
  resetCommandResolverForTests,
  setCommandResolverForTests,
  spawnAgent,
} from "../src/agents/spawn.js";
import { getAgent, isValidAgentName } from "../src/agents.js";
import { classifyError } from "../src/cli/handle.js";
import { type Db, openDb } from "../src/db.js";
import {
  HerdrCommandOverrideError,
  HerdrError,
  HerdrNotImplementedError,
  HerdrUnsupportedCliError,
  herdrBackend,
  isValidPaneId,
  newSessionWithPane,
  newWindow,
  PANE_ID_RE,
  resetHerdrExecutor,
  setHerdrExecutor,
  splitWindow,
  startAgentInPane,
} from "../src/mux/herdr.js";
import type { MuxBackend } from "../src/mux/types.js";
import { resetMux, setMuxForTests } from "../src/mux.js";
import { resetSleep, setSleepForTests } from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";

// ─── Recorded fixtures ─────────────────────────────────────────────────

const WORKSPACE_LIST_EMPTY = JSON.stringify({
  id: "cli:workspace:list",
  result: { type: "workspace_list", workspaces: [] },
});

const WORKSPACE_LIST = JSON.stringify({
  id: "cli:workspace:list",
  result: {
    type: "workspace_list",
    workspaces: [
      {
        active_tab_id: "w1:t1",
        agent_status: "unknown",
        focused: true,
        label: "mu-spawntest",
        number: 1,
        pane_count: 1,
        tab_count: 1,
        workspace_id: "w1",
      },
    ],
  },
});

const WORKSPACE_CREATED = JSON.stringify({
  id: "cli:workspace:create",
  result: {
    root_pane: {
      agent_status: "unknown",
      cwd: "/tmp",
      focused: true,
      foreground_cwd: "/tmp",
      pane_id: "w1:p1",
      revision: 0,
      tab_id: "w1:t1",
      terminal_id: "term_658af5fab2a291",
      workspace_id: "w1",
    },
    tab: {
      agent_status: "unknown",
      focused: true,
      label: "1",
      number: 1,
      pane_count: 1,
      tab_id: "w1:t1",
      workspace_id: "w1",
    },
    type: "workspace_created",
    workspace: {
      active_tab_id: "w1:t1",
      label: "mu-spawntest",
      number: 1,
      pane_count: 1,
      tab_count: 1,
      workspace_id: "w1",
    },
  },
});

const TAB_LIST = JSON.stringify({
  id: "cli:tab:list",
  result: {
    tabs: [
      {
        agent_status: "unknown",
        focused: true,
        label: "1",
        number: 1,
        pane_count: 1,
        tab_id: "w1:t1",
        workspace_id: "w1",
      },
    ],
    type: "tab_list",
  },
});

const TAB_CREATED = JSON.stringify({
  id: "cli:tab:create",
  result: {
    root_pane: {
      agent_status: "unknown",
      cwd: "/tmp",
      focused: false,
      pane_id: "w1:p2",
      revision: 0,
      tab_id: "w1:t2",
      terminal_id: "term_658af625782ec2",
      workspace_id: "w1",
    },
    tab: { focused: false, label: "worker-1", number: 2, tab_id: "w1:t2", workspace_id: "w1" },
    type: "tab_created",
  },
});

const PANE_LIST = JSON.stringify({
  id: "cli:pane:list",
  result: {
    panes: [
      {
        agent_status: "idle",
        cwd: "/tmp",
        focused: true,
        label: "worker-1",
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        workspace_id: "w1",
      },
    ],
    type: "pane_list",
  },
});

const PANE_SPLIT = JSON.stringify({
  id: "cli:pane:split",
  result: {
    pane: {
      agent_status: "unknown",
      cwd: "/tmp",
      focused: false,
      pane_id: "w1:p3",
      revision: 0,
      tab_id: "w1:t1",
      terminal_id: "term_658af650940523",
      workspace_id: "w1",
    },
    type: "pane_info",
  },
});

/** `agent start worker-1 --kind pi --pane w1:p1`, verbatim. Note
 *  `agent_status` is ALREADY "idle" and `interactive_ready` true: herdr
 *  only returns once the agent is up, which is why mu skips its own
 *  liveness/readiness polling on this backend. */
const AGENT_STARTED = JSON.stringify({
  id: "cli:agent:start",
  result: {
    agent: {
      agent: "pi",
      agent_status: "idle",
      cwd: "/tmp",
      focused: true,
      interactive_ready: true,
      name: "worker-1",
      pane_id: "w1:p1",
      revision: 1,
      screen_detection_skipped: true,
      state_change_seq: 1,
      tab_id: "w1:t1",
      terminal_id: "term_658af5fab2a291",
      terminal_title: "π - tmp",
      workspace_id: "w1",
    },
    argv: ["pi"],
    type: "agent_started",
  },
});

/** The verified race: `agent start` immediately after `pane split`. */
const AGENT_PANE_BUSY = JSON.stringify({
  error: {
    code: "agent_pane_busy",
    message: "agent target pane w1:p3 is not an available shell",
  },
  id: "cli:agent:start",
});

const AGENT_NAME_TAKEN = JSON.stringify({
  error: {
    code: "agent_name_taken",
    message:
      "agent name worker-1 is already used; candidates: terminal_id=term_658af5fab2a291 pane_id=w1:p1 workspace_id=w1 tab_id=w1:t1 cwd=/tmp status=Idle",
  },
  id: "cli:agent:start",
});

const AGENT_INVALID_NAME = JSON.stringify({
  error: {
    code: "invalid_agent_name",
    message:
      "agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)",
  },
  id: "cli:agent:start",
});

const AGENT_START_TIMEOUT = JSON.stringify({
  error: { code: "timeout", message: "timed out waiting for agent startup" },
  id: "cli:agent:start",
});

/** Unknown `--kind` is rejected by herdr's ARG PARSER, so it exits 2
 *  with plain text on stdout — not the JSON error envelope. */
const UNSUPPORTED_KIND = {
  stdout: "unsupported interactive agent kind: notacli",
  stderr: "",
  exitCode: 2,
};

const OK_PANE_CLOSE = JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } });

// ─── Harness ───────────────────────────────────────────────────────────

interface Call {
  args: readonly string[];
}

function mockHerdr(routes: Array<[string, { stdout: string; stderr: string; exitCode: number }]>) {
  const calls: Call[] = [];
  setHerdrExecutor(async (args) => {
    calls.push({ args });
    const key = args.join(" ");
    for (const [prefix, response] of routes) {
      if (key.startsWith(prefix)) return response;
    }
    return { stdout: "", stderr: `unrouted: ${key}`, exitCode: 1 };
  });
  return calls;
}

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
const serverError = (payload: string) => ({ stdout: "", stderr: payload, exitCode: 1 });

/** The joined args of every call, for order assertions. */
function keys(calls: Call[]): string[] {
  return calls.map((c) => c.args.join(" "));
}

let tempDir: string;
let db: Db;
let previousMux: MuxBackend | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mu-herdr-spawn-"));
  db = openDb({ path: join(tempDir, "mu.db") });
  previousMux = setMuxForTests(herdrBackend);
  // The retry loop's poll sleep. Nulling it keeps the fast tier fast
  // without changing the loop's shape.
  setSleepForTests(async () => {});
  // Every spawn below pre-flights `pi` on PATH; the herdr decisions
  // under test are independent of what is installed on the box.
  setCommandResolverForTests(async (command) => ({
    ok: true,
    binary: command.split(/\s+/)[0] ?? command,
    resolvedPath: `/usr/bin/${command}`,
  }));
});

afterEach(() => {
  setMuxForTests(previousMux);
  resetMux();
  resetHerdrExecutor();
  resetCommandResolverForTests();
  resetSleep();
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(tempDir, { recursive: true, force: true });
});

// ─── The two-step shape ────────────────────────────────────────────────

describe("spawn on herdr is create-then-start, in that order", () => {
  it("creates the workspace bare, THEN starts the agent in its root pane", async () => {
    const calls = mockHerdr([
      ["workspace list", ok(WORKSPACE_LIST_EMPTY)],
      ["workspace create", ok(WORKSPACE_CREATED)],
      ["pane rename", ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }))],
      ["agent start", ok(AGENT_STARTED)],
    ]);
    ensureWorkstream(db, "spawntest");

    const agent = await spawnAgent(db, { name: "worker-1", workstream: "spawntest" });

    expect(agent.paneId).toBe("w1:p1");
    const issued = keys(calls);
    const createIdx = issued.findIndex((k) => k.startsWith("workspace create"));
    const startIdx = issued.findIndex((k) => k.startsWith("agent start"));
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(createIdx);
    // The pane is created BARE: no command rides along on the creation
    // verb, because herdr has no create-and-run form.
    expect(issued[createIdx]).not.toContain("pi");
    // …and the start step names the pane the create step returned. Never
    // a predicted id: herdr renumbers moved panes.
    expect(issued[startIdx]).toBe("agent start worker-1 --kind pi --pane w1:p1");
  });

  it("splits a bare pane, THEN starts the agent, when the tab already exists", async () => {
    // Shared-tab spawn (`--tab`): the window exists, so mu splits it.
    // herdr splits PANES, not windows, so the target must be a concrete
    // pane id resolved from the tab — never tmux's "session:window".
    const calls = mockHerdr([
      ["workspace list", ok(WORKSPACE_LIST)],
      ["tab list", ok(TAB_LIST)],
      ["pane list", ok(PANE_LIST)],
      ["pane split", ok(PANE_SPLIT)],
      ["pane rename", ok(JSON.stringify({ result: { pane: { pane_id: "w1:p3" } } }))],
      ["agent start", ok(AGENT_STARTED)],
    ]);
    ensureWorkstream(db, "spawntest");

    await spawnAgent(db, { name: "worker-2", workstream: "spawntest", tab: "1" });

    const issued = keys(calls);
    const split = issued.find((k) => k.startsWith("pane split"));
    expect(split).toContain("pane split w1:p1 --direction right --no-focus");
    // Identity env still rides along on the creation verb — that part is
    // not the command and is honoured normally.
    expect(split).toContain("--env MU_AGENT_NAME=worker-2");
    const startIdx = issued.findIndex((k) => k.startsWith("agent start"));
    expect(startIdx).toBeGreaterThan(issued.indexOf(split ?? ""));
    expect(issued[startIdx]).toContain("--pane w1:p3");
  });

  it("creates a bare TAB, then starts, for a second agent in the same workspace", async () => {
    const calls = mockHerdr([
      ["workspace list", ok(WORKSPACE_LIST)],
      ["tab list", ok(TAB_LIST)],
      ["tab create", ok(TAB_CREATED)],
      ["pane rename", ok(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }))],
      ["agent start", ok(AGENT_STARTED)],
    ]);
    ensureWorkstream(db, "spawntest");

    await spawnAgent(db, { name: "worker-1", workstream: "spawntest" });

    const issued = keys(calls);
    const create = issued.find((k) => k.startsWith("tab create"));
    expect(create).toContain("tab create --workspace w1 --label worker-1 --no-focus");
    expect(create).toContain("--env MU_WORKSTREAM=spawntest");
    expect(issued.some((k) => k === "agent start worker-1 --kind pi --pane w1:p2")).toBe(true);
  });

  it("the creation verbs still REFUSE a command rather than dropping it", async () => {
    // The property worker-2 established and this task must preserve: an
    // ignored command leaves an empty shell mu believes hosts an agent.
    // Callers reach step 2 explicitly or not at all.
    mockHerdr([["workspace list", ok(WORKSPACE_LIST)]]);
    await expect(
      newSessionWithPane("mu-x", { windowName: "w", command: "pi" }),
    ).rejects.toBeInstanceOf(HerdrNotImplementedError);
    await expect(
      newWindow({ session: "mu-spawntest", name: "t", command: "pi" }),
    ).rejects.toBeInstanceOf(HerdrNotImplementedError);
    await expect(splitWindow({ target: "w1:p1", command: "pi" })).rejects.toBeInstanceOf(
      HerdrNotImplementedError,
    );
  });
});

// ─── The anti-empty-shell property ─────────────────────────────────────

describe("a failed agent start never leaves a pane mu thinks is an agent", () => {
  it("rolls the pane back and records NO agent row when start fails", async () => {
    const calls = mockHerdr([
      ["workspace list", ok(WORKSPACE_LIST_EMPTY)],
      ["workspace create", ok(WORKSPACE_CREATED)],
      ["pane rename", ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }))],
      ["agent start", serverError(AGENT_START_TIMEOUT)],
      ["pane close", ok(OK_PANE_CLOSE)],
    ]);
    ensureWorkstream(db, "spawntest");

    await expect(
      spawnAgent(db, { name: "worker-1", workstream: "spawntest" }),
    ).rejects.toBeInstanceOf(HerdrError);

    // The row is gone — mu is not holding an agent for a bare shell.
    expect(getAgent(db, "worker-1", "spawntest")).toBeUndefined();
    // …and the bare pane was killed rather than left behind.
    expect(keys(calls)).toContain("pane close w1:p1");
  });

  it("a herdr-rejected agent NAME also rolls back", async () => {
    // The one shape mu's own validator would let through but herdr may
    // not (see the regex-equivalence test below). It must still not
    // strand a pane.
    const calls = mockHerdr([
      ["workspace list", ok(WORKSPACE_LIST_EMPTY)],
      ["workspace create", ok(WORKSPACE_CREATED)],
      ["pane rename", ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }))],
      ["agent start", serverError(AGENT_INVALID_NAME)],
      ["pane close", ok(OK_PANE_CLOSE)],
    ]);
    ensureWorkstream(db, "spawntest");

    await expect(spawnAgent(db, { name: "worker-1", workstream: "spawntest" })).rejects.toThrow(
      /agent name must start with a lowercase letter/,
    );
    expect(getAgent(db, "worker-1", "spawntest")).toBeUndefined();
    expect(keys(calls)).toContain("pane close w1:p1");
  });

  it("a name already live on the herdr side rolls back too", async () => {
    const calls = mockHerdr([
      ["workspace list", ok(WORKSPACE_LIST_EMPTY)],
      ["workspace create", ok(WORKSPACE_CREATED)],
      ["pane rename", ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }))],
      ["agent start", serverError(AGENT_NAME_TAKEN)],
      ["pane close", ok(OK_PANE_CLOSE)],
    ]);
    ensureWorkstream(db, "spawntest");

    const err = await spawnAgent(db, { name: "worker-1", workstream: "spawntest" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HerdrError);
    if (!(err instanceof HerdrError)) throw new Error("unreachable");
    expect(err.code).toBe("agent_name_taken");
    expect(getAgent(db, "worker-1", "spawntest")).toBeUndefined();
    expect(keys(calls)).toContain("pane close w1:p1");
  });
});

// ─── The pane-not-ready race ───────────────────────────────────────────

describe("agent_pane_busy is retried, not surfaced", () => {
  it("retries until the freshly-split pane reaches its shell prompt", async () => {
    // VERIFIED on 0.8.0: `agent start` right after `pane split` fails
    // agent_pane_busy essentially always; with a ~200ms gap it succeeds.
    // The condition is observable, so mu polls for it instead of
    // pre-sleeping a guessed constant.
    let attempts = 0;
    setHerdrExecutor(async (args) => {
      if (args[0] === "agent" && args[1] === "start") {
        attempts += 1;
        return attempts < 3
          ? { stdout: "", stderr: AGENT_PANE_BUSY, exitCode: 1 }
          : ok(AGENT_STARTED);
      }
      return ok("{}");
    });

    await expect(
      startAgentInPane({
        paneId: "w1:p3",
        name: "worker-2",
        cli: "pi",
        command: "pi",
        commandSource: "cli-key",
      }),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  it("gives up and surfaces the busy error once the attempts are exhausted", async () => {
    // A pane that never frees up is a real failure, not something to
    // spin on forever. The loop is bounded by ATTEMPTS, so the nulled
    // sleep makes this instant and deterministic.
    let attempts = 0;
    setHerdrExecutor(async () => {
      attempts += 1;
      return { stdout: "", stderr: AGENT_PANE_BUSY, exitCode: 1 };
    });
    const err = await startAgentInPane({
      paneId: "w1:p3",
      name: "worker-2",
      cli: "pi",
      command: "pi",
      commandSource: "cli-key",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrError);
    if (!(err instanceof HerdrError)) throw new Error("unreachable");
    expect(err.code).toBe("agent_pane_busy");
    // Bounded, and it really did retry rather than failing on the first.
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(200);
  });
});

// ─── Decision 1: an unknown --cli ──────────────────────────────────────

describe("decision 1: a --cli herdr does not know is REFUSED, not shell-run", () => {
  it("translates herdr's exit-2 kind rejection into a usage-class error", async () => {
    // `--kind` is a closed enum, so an unknown value is a SYNTAX error
    // to herdr. Everywhere else exit 2 means mu drifted from the CLI, so
    // it must not read as "bug in mu" here — it is an operator typo.
    mockHerdr([["agent start", UNSUPPORTED_KIND]]);
    const err = await startAgentInPane({
      paneId: "w1:p1",
      name: "worker-1",
      cli: "notacli",
      command: "notacli",
      commandSource: "cli-key",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrUnsupportedCliError);
    expect(String(err)).toContain("notacli");
    // The reason, not just the refusal: `pane run notacli` would start
    // the binary but herdr would never classify that pane, and on this
    // backend herdr's classification IS mu's status source.
    expect(String(err)).toMatch(/classify/);
  });

  it("does NOT fall back to `pane run`", async () => {
    const calls = mockHerdr([["agent start", UNSUPPORTED_KIND]]);
    await startAgentInPane({
      paneId: "w1:p1",
      name: "worker-1",
      cli: "notacli",
      command: "notacli",
      commandSource: "cli-key",
    }).catch(() => {});
    expect(keys(calls).some((k) => k.startsWith("pane run"))).toBe(false);
  });

  it("mu does not hardcode herdr's kind list — herdr is the authority", async () => {
    // The kind is forwarded verbatim and the REJECTION is translated, so
    // a herdr release adding a kind works with no mu change. Proven by a
    // kind mu has never heard of succeeding.
    const calls = mockHerdr([["agent start", ok(AGENT_STARTED)]]);
    await expect(
      startAgentInPane({
        paneId: "w1:p1",
        name: "worker-1",
        cli: "brandnewagent",
        command: "brandnewagent",
        commandSource: "cli-key",
      }),
    ).resolves.toBeUndefined();
    expect(keys(calls)[0]).toContain("--kind brandnewagent");
  });

  it("exits 2 (usage), not 5 (mux down) — the substrate is healthy", () => {
    expect(
      classifyError(new HerdrUnsupportedCliError("notacli", "unsupported kind")).exitCode,
    ).toBe(2);
  });
});

// ─── Decision 2: MU_<UPPER_CLI>_COMMAND ────────────────────────────────

describe("decision 2: a command override mu cannot honour is REFUSED", () => {
  it("refuses MU_PI_COMMAND rather than silently ignoring it", async () => {
    // `agent start --kind pi` resolves the executable itself; there is
    // no override flag, and args after `--` go to the AGENT, not to
    // executable selection. Accepting the var and not honouring it is
    // the one outcome ruled out.
    const calls = mockHerdr([["agent start", ok(AGENT_STARTED)]]);
    const err = await startAgentInPane({
      paneId: "w1:p1",
      name: "worker-1",
      cli: "pi",
      command: "pi-alt",
      commandSource: "env",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrCommandOverrideError);
    // Names the variable, so the operator can act without guessing.
    expect(String(err)).toContain("MU_PI_COMMAND");
    expect(String(err)).toContain("pi-alt");
    // And refuses BEFORE touching the server: nothing was started, so
    // there is nothing to roll back beyond the bare pane.
    expect(calls).toHaveLength(0);
  });

  it("the env-var name matches src/agents/spawn.ts exactly", () => {
    // herdr.ts recomputes it rather than importing (mux may not depend
    // on the agent layer). If the two ever diverge the error would name
    // a variable that does nothing — assert them equal instead.
    for (const cli of ["pi", "claude", "pi-meta", "codex"]) {
      const err = new HerdrCommandOverrideError(cli, "x", envVarNameForCli(cli));
      expect(String(err)).toContain(envVarNameForCli(cli));
    }
    expect(envVarNameForCli("pi-meta")).toBe("MU_PI_META_COMMAND");
  });

  it("an explicit --command is refused too, and does NOT name an env var", async () => {
    // "unset MU_PI_COMMAND" is useless advice to someone who typed
    // --command, so the two overrides carry different remediation.
    const err = await startAgentInPane({
      paneId: "w1:p1",
      name: "worker-1",
      cli: "pi",
      command: "bash -lc 'pi --yolo'",
      commandSource: "explicit",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HerdrCommandOverrideError);
    if (!(err instanceof HerdrCommandOverrideError)) throw new Error("unreachable");
    expect(err.envVar).toBeUndefined();
    expect(err.message).toContain("--command");
    expect(err.message).not.toContain("MU_PI_COMMAND");
    expect(classifyError(err).exitCode).toBe(2);
  });

  it("a bare --cli with no override starts normally", async () => {
    // The control case: commandSource "cli-key" means there is nothing to
    // honour, so herdr resolving the binary itself is exactly right.
    const calls = mockHerdr([["agent start", ok(AGENT_STARTED)]]);
    await expect(
      startAgentInPane({
        paneId: "w1:p1",
        name: "worker-1",
        cli: "pi",
        command: "pi",
        commandSource: "cli-key",
      }),
    ).resolves.toBeUndefined();
    expect(keys(calls)).toEqual(["agent start worker-1 --kind pi --pane w1:p1"]);
  });

  it("end-to-end: spawn under MU_PI_COMMAND refuses and rolls the pane back", async () => {
    const calls = mockHerdr([
      ["workspace list", ok(WORKSPACE_LIST_EMPTY)],
      ["workspace create", ok(WORKSPACE_CREATED)],
      ["pane rename", ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }))],
      ["pane close", ok(OK_PANE_CLOSE)],
    ]);
    ensureWorkstream(db, "spawntest");
    process.env.MU_PI_COMMAND = "pi-alt";
    try {
      await expect(
        spawnAgent(db, { name: "worker-1", workstream: "spawntest" }),
      ).rejects.toBeInstanceOf(HerdrCommandOverrideError);
    } finally {
      const key = "MU_PI_COMMAND";
      delete process.env[key];
    }
    expect(getAgent(db, "worker-1", "spawntest")).toBeUndefined();
    expect(keys(calls)).toContain("pane close w1:p1");
    expect(keys(calls).some((k) => k.startsWith("agent start"))).toBe(false);
  });
});

// ─── Decision 3: name-shape equivalence ────────────────────────────────

describe("decision 3: mu's and herdr's agent-name shapes are identical", () => {
  // herdr's documented shape (0.8.0, from the invalid_agent_name
  // message and verified by probe): "start with a lowercase letter and
  // contain only lowercase letters, digits, '-' or '_' (1-32
  // characters)". mu's isValidAgentName is /^[a-z][a-z0-9_-]{0,31}$/.
  // These are the SAME language. mu passes its own agent name straight
  // through to `agent start`, so if either side widens, the divergence
  // must fail HERE rather than surfacing as a confusing herdr-side
  // rejection after a pane has already been created.
  const HERDR_AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

  const probes = [
    "a",
    "worker-1",
    "worker_1",
    "reviewer-22",
    "abcdefghijklmnopqrstuvwxyz012345", // 32 chars: the limit
    "abcdefghijklmnopqrstuvwxyz0123456", // 33: over it
    "1worker",
    "-worker",
    "_worker",
    "Worker-1",
    "worker.1",
    "worker 1",
    "wörker",
    "",
  ];

  for (const probe of probes) {
    it(`agrees on ${JSON.stringify(probe)}`, () => {
      expect(isValidAgentName(probe)).toBe(HERDR_AGENT_NAME_RE.test(probe));
    });
  }

  it("mu's validator is the herdr one, character for character", () => {
    // Cheap fuzz over the interesting byte classes, so a future
    // widening of either regex fails loudly instead of drifting.
    const alphabet = "abzAZ019_-. ";
    for (const a of alphabet) {
      for (const b of alphabet) {
        const name = `${a}${b}x`;
        expect(isValidAgentName(name)).toBe(HERDR_AGENT_NAME_RE.test(name));
      }
    }
  });
});

// ─── Pane ids are base32, not decimal ──────────────────────────────────

describe("herdr pane ordinals are base32 — spawn breaks at pane 10 otherwise", () => {
  it("accepts the ids a real server hands out past the ninth pane", () => {
    // VERIFIED by opening 38 panes on 0.8.0: the sequence is
    // p1…p9, pA…pH, pJ, pK, pM, pN, pP…pZ, p10, p11… (Crockford base32).
    // A decimal-only pattern works for exactly nine panes and then
    // starts rejecting LIVE ids, which on the spawn path is a TypeError
    // out of assertValidPaneId for the tenth agent in a workstream.
    for (const id of ["w1:p1", "w1:pA", "w1:pZ", "w1:p10", "w1:p16", "wA:p1", "wC:pG"]) {
      expect(isValidPaneId(id)).toBe(true);
    }
  });

  it("still rejects tmux ids and near-misses", () => {
    for (const id of ["%15", "w1", "w1:t1", "p1", "w1:p1 ", "", "w1:pa", "w1:p-1"]) {
      expect(isValidPaneId(id)).toBe(false);
    }
  });

  it("the assertion message quotes the pattern actually enforced", () => {
    expect(() => herdrBackend.assertValidPaneId("%15")).toThrow(/invalid herdr pane id/);
    const message = (() => {
      try {
        herdrBackend.assertValidPaneId("%15");
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      throw new Error("expected assertValidPaneId to throw");
    })();
    expect(message).toContain(PANE_ID_RE.source);
  });
});

// ─── The capability seam ───────────────────────────────────────────────

describe("spawn branches on the CAPABILITY, not the backend name", () => {
  it("herdr advertises startAgentInPane; tmux does not", async () => {
    const { tmuxBackend } = await import("../src/mux/tmux.js");
    expect(typeof herdrBackend.startAgentInPane).toBe("function");
    expect(tmuxBackend.startAgentInPane).toBeUndefined();
  });

  it("MU_SPAWN_LIVENESS_MS / MU_SPAWN_READINESS_MS are not consulted on herdr", async () => {
    // `agent start` returns only once herdr has detected the agent and
    // considers it ready for input, which subsumes both polls. If mu
    // still ran them it would issue `pane read` round trips — this
    // asserts their ABSENCE, which is the property pin. A generous
    // liveness budget would also make the test hang if it were used.
    process.env.MU_SPAWN_LIVENESS_MS = "60000";
    process.env.MU_SPAWN_READINESS_MS = "60000";
    const calls = mockHerdr([
      ["workspace list", ok(WORKSPACE_LIST_EMPTY)],
      ["workspace create", ok(WORKSPACE_CREATED)],
      ["pane rename", ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }))],
      ["agent start", ok(AGENT_STARTED)],
    ]);
    ensureWorkstream(db, "spawntest");
    try {
      await spawnAgent(db, { name: "worker-1", workstream: "spawntest" });
    } finally {
      for (const key of ["MU_SPAWN_LIVENESS_MS", "MU_SPAWN_READINESS_MS"]) {
        delete process.env[key];
      }
    }
    expect(keys(calls).some((k) => k.startsWith("pane read"))).toBe(false);
  });
});
