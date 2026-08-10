// The herdr mux backend, topology half.
//
// Every JSON body below is a VERBATIM capture from a real herdr 0.8.0
// server (protocol 19) driven through an isolated `herdr --session
// mutest-topo`. Hardcoding the recordings keeps this in the fast tier:
// no subprocess, no server, no sleeps.

import { afterEach, describe, expect, it } from "vitest";
import {
  HerdrError,
  type HerdrExecResult,
  HerdrNotImplementedError,
  HerdrSyntaxError,
  herdrBackend,
  isValidPaneId,
  listPanesInSession,
  listSessions,
  listWindows,
  newSession,
  newWindow,
  paneExists,
  resetHerdrExecutor,
  sessionExists,
  setHerdrExecutor,
  setPaneTitle,
  splitWindow,
} from "../src/mux/herdr.js";
import { PaneNotFoundError } from "../src/mux/types.js";

// ─── Recorded fixtures ─────────────────────────────────────────────────

const WORKSPACE_LIST = JSON.stringify({
  id: "cli:workspace:list",
  result: {
    type: "workspace_list",
    workspaces: [
      {
        active_tab_id: "w1:t1",
        agent_status: "unknown",
        focused: true,
        label: "mu-topotest",
        number: 1,
        pane_count: 1,
        tab_count: 1,
        workspace_id: "w1",
      },
    ],
  },
});

const WORKSPACE_LIST_EMPTY = JSON.stringify({
  id: "cli:workspace:list",
  result: { type: "workspace_list", workspaces: [] },
});

const WORKSPACE_CREATED = JSON.stringify({
  id: "cli:workspace:create",
  result: {
    root_pane: {
      agent_status: "unknown",
      cwd: "/var/home/martintrojer",
      focused: true,
      pane_id: "w1:p1",
      tab_id: "w1:t1",
      terminal_id: "term_658aea428bdf51",
      workspace_id: "w1",
    },
    tab: { focused: true, label: "1", number: 1, tab_id: "w1:t1", workspace_id: "w1" },
    type: "workspace_created",
    workspace: { label: "mu-topotest", number: 1, workspace_id: "w1" },
  },
});

const TAB_LIST = JSON.stringify({
  id: "cli:tab:list",
  result: {
    tabs: [
      { focused: true, label: "1", number: 1, pane_count: 1, tab_id: "w1:t1", workspace_id: "w1" },
      {
        focused: false,
        label: "mytab",
        number: 2,
        pane_count: 1,
        tab_id: "w1:t2",
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
      cwd: "/var/home/martintrojer",
      focused: false,
      pane_id: "w1:p2",
      tab_id: "w1:t2",
      workspace_id: "w1",
    },
    tab: { focused: false, label: "mytab", number: 2, tab_id: "w1:t2", workspace_id: "w1" },
    type: "tab_created",
  },
});

const PANE_LIST = JSON.stringify({
  id: "cli:pane:list",
  result: {
    panes: [
      { focused: true, label: "worker-1", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
      { focused: false, pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" },
    ],
    type: "pane_list",
  },
});

const PANE_SPLIT = JSON.stringify({
  id: "cli:pane:split",
  result: {
    pane: { cwd: "/tmp", focused: false, pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1" },
    type: "pane_info",
  },
});

const PANE_GET = JSON.stringify({
  id: "cli:pane:get",
  result: {
    pane: {
      focused: true,
      label: "mylabel",
      pane_id: "w1:p1",
      tab_id: "w1:t1",
      workspace_id: "w1",
    },
    type: "pane_info",
  },
});

const PANE_NOT_FOUND = JSON.stringify({
  error: { code: "pane_not_found", message: "pane w9:p9 not found" },
  id: "cli:pane:get",
});

const WORKSPACE_NOT_FOUND = JSON.stringify({
  error: { code: "workspace_not_found", message: "workspace w99 not found" },
  id: "cli:workspace:close",
});

const OK = JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } });

const STATUS_RUNNING = [
  "client:",
  "  version: 0.8.0",
  "  protocol: 19",
  "",
  "server:",
  "  status: running",
  "  protocol: 19",
  "  compatible: yes",
].join("\n");

const STATUS_STOPPED = [
  "client:",
  "  version: 0.8.0",
  "",
  "server:",
  "  status: not running",
  "  socket: /home/u/.config/herdr/herdr.sock",
].join("\n");

// ─── Executor harness ──────────────────────────────────────────────────

interface Call {
  args: readonly string[];
}

/** Route by a prefix of the args vector; record every call. */
function mockHerdr(routes: Array<[string, HerdrExecResult | string]>): Call[] {
  const calls: Call[] = [];
  setHerdrExecutor(async (args) => {
    calls.push({ args });
    const key = args.join(" ");
    for (const [prefix, response] of routes) {
      if (key.startsWith(prefix)) {
        return typeof response === "string"
          ? { stdout: response, stderr: "", exitCode: 0 }
          : response;
      }
    }
    return { stdout: "", stderr: `unrouted: ${key}`, exitCode: 1 };
  });
  return calls;
}

const serverError = (payload: string): HerdrExecResult => ({
  stdout: "",
  stderr: payload,
  exitCode: 1,
});

afterEach(() => {
  resetHerdrExecutor();
});

// ─── Pane id validation ────────────────────────────────────────────────

describe("herdr pane-id validation", () => {
  it("accepts herdr's workspace-qualified pane ids", () => {
    expect(isValidPaneId("w1:p1")).toBe(true);
    expect(isValidPaneId("w12:p345")).toBe(true);
  });

  it("REJECTS tmux pane ids", () => {
    // The mirror of the tmux backend's `isValidPaneId("w1:p1") === false`
    // assertion in mux-detect.test.ts. This pair is the whole reason
    // pane-id validation is a backend method and not a global regex:
    // a %15 leaking into a herdr call must fail at the call site.
    expect(herdrBackend.isValidPaneId("%15")).toBe(false);
    expect(herdrBackend.isValidPaneId("%0")).toBe(false);
  });

  it("rejects near-misses: bare ordinals, tab ids, workspace ids", () => {
    expect(isValidPaneId("0")).toBe(false);
    expect(isValidPaneId("w1")).toBe(false);
    expect(isValidPaneId("w1:t1")).toBe(false);
    expect(isValidPaneId("p1")).toBe(false);
    expect(isValidPaneId("w1:p1 ")).toBe(false);
    expect(isValidPaneId("")).toBe(false);
  });

  it("assertValidPaneId throws a TypeError naming the expected shape", () => {
    expect(() => herdrBackend.assertValidPaneId("%15")).toThrow(/invalid herdr pane id/);
  });
});

// ─── Exit codes ────────────────────────────────────────────────────────

describe("herdr exit-code mapping", () => {
  it("exit 2 (syntax) is a PROGRAMMING error, not a substrate failure", async () => {
    // If CLI drift after a herdr upgrade were bucketed as MuxError, it
    // would render as "herdr is down" and send the operator chasing a
    // healthy server. It must read as a bug in mu instead.
    const { MuxError } = await import("../src/mux/types.js");
    mockHerdr([
      ["", { stdout: "herdr pane commands:\n  herdr pane list", stderr: "", exitCode: 2 }],
    ]);
    const err = await listSessions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrSyntaxError);
    expect(err).not.toBeInstanceOf(MuxError);
    expect(err).not.toBeInstanceOf(HerdrError);
  });

  it("the exit-2 message says it is a bug in mu and echoes the command", async () => {
    mockHerdr([["", { stdout: "usage: ...", stderr: "", exitCode: 2 }]]);
    await expect(listSessions()).rejects.toThrow(/bug in mu, not a herdr outage/);
    await expect(listSessions()).rejects.toThrow(/herdr workspace list/);
  });

  it("exit 1 with a JSON error envelope is a HerdrError carrying the code", async () => {
    mockHerdr([["workspace list", serverError(WORKSPACE_NOT_FOUND)]]);
    const err = await listSessions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    if (!(err instanceof HerdrError)) throw new Error("unreachable");
    expect(err.code).toBe("workspace_not_found");
    // The human-readable half of the envelope, not the raw JSON.
    expect(err.message).toContain("workspace w99 not found");
  });

  it("HerdrError is a MuxError, so handle() maps it to exit 5 for free", async () => {
    const { MuxError } = await import("../src/mux/types.js");
    mockHerdr([["workspace list", serverError(WORKSPACE_NOT_FOUND)]]);
    await expect(listSessions()).rejects.toBeInstanceOf(MuxError);
  });

  it("a zero exit with unparseable stdout is a substrate error, not a crash", async () => {
    mockHerdr([
      ["workspace list", { stdout: "<html>proxy error</html>", stderr: "", exitCode: 0 }],
    ]);
    await expect(listSessions()).rejects.toBeInstanceOf(HerdrError);
  });
});

// ─── Workspaces = mu sessions ──────────────────────────────────────────

describe("herdr sessions (= workspaces, addressed by label)", () => {
  it("listSessions maps workspace labels to session names", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST]]);
    expect(await listSessions()).toEqual([{ name: "mu-topotest" }]);
  });

  it("listSessions returns [] when no workspaces exist", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    expect(await listSessions()).toEqual([]);
  });

  it("sessionExists matches on label, not on the opaque workspace id", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST]]);
    expect(await sessionExists("mu-topotest")).toBe(true);
    expect(await sessionExists("w1")).toBe(false);
    expect(await sessionExists("mu-other")).toBe(false);
  });

  it("newSession labels the workspace and never steals focus", async () => {
    const calls = mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    await newSession("mu-auth", { cwd: "/repo" });
    expect(calls[0]?.args).toEqual([
      "workspace",
      "create",
      "--label",
      "mu-auth",
      "--no-focus",
      "--cwd",
      "/repo",
    ]);
  });

  it("newSession passes --no-focus even when the caller asks for attached", async () => {
    // mu must never move the user's focus, so `detached: false` is not
    // honoured on herdr. Regression guard for a plausible "map detached
    // to --focus" refactor.
    const calls = mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    await newSession("mu-auth", { detached: false });
    expect(calls[0]?.args).toContain("--no-focus");
    expect(calls[0]?.args).not.toContain("--focus");
  });

  it("newSession forwards env as --env KEY=VALUE", async () => {
    const calls = mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    await newSession("mu-auth", { env: { MU_AGENT_NAME: "w1" } });
    expect(calls[0]?.args).toEqual([
      "workspace",
      "create",
      "--label",
      "mu-auth",
      "--no-focus",
      "--env",
      "MU_AGENT_NAME=w1",
    ]);
  });

  it("newSession rejects an env key containing '=' at the call site", async () => {
    mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    await expect(newSession("mu-auth", { env: { "A=B": "c" } })).rejects.toBeInstanceOf(TypeError);
  });

  it("newSessionWithPane READS the pane id from the response", async () => {
    // Never predict an id: herdr does not reuse closed ids.
    mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    expect(
      await herdrBackend.newSessionWithPane("mu-topotest", { windowName: "x", command: "" }),
    ).toBe("w1:p1");
  });

  it("killSession resolves the label to an id, then closes it", async () => {
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["workspace close", OK],
    ]);
    await herdrBackend.killSession("mu-topotest");
    expect(calls[1]?.args).toEqual(["workspace", "close", "w1"]);
  });

  it("killSession is idempotent for a workspace that is already gone", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    await expect(herdrBackend.killSession("mu-vanished")).resolves.toBeUndefined();
  });

  it("killSession tolerates a workspace closing between list and close", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["workspace close", serverError(WORKSPACE_NOT_FOUND)],
    ]);
    await expect(herdrBackend.killSession("mu-topotest")).resolves.toBeUndefined();
  });
});

// ─── Tabs = mu windows ─────────────────────────────────────────────────

describe("herdr windows (= tabs)", () => {
  it("listWindows resolves the session label and reads tab ids + labels", async () => {
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["tab list", TAB_LIST],
    ]);
    expect(await listWindows("mu-topotest")).toEqual([
      { id: "w1:t1", name: "1" },
      { id: "w1:t2", name: "mytab" },
    ]);
    expect(calls[1]?.args).toEqual(["tab", "list", "--workspace", "w1"]);
  });

  it("listWindows returns [] for a workspace that no longer exists", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    expect(await listWindows("mu-gone")).toEqual([]);
  });

  it("listWindows with no session fans out and tags rows with the label", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["tab list", TAB_LIST],
    ]);
    const windows = await listWindows();
    expect(windows).toHaveLength(2);
    expect(windows[0]?.sessionName).toBe("mu-topotest");
  });

  it("newWindow creates a labelled tab in the resolved workspace", async () => {
    const calls = mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["tab create", TAB_CREATED],
    ]);
    expect(await newWindow({ session: "mu-topotest", name: "mytab", command: "" })).toBe("w1:p2");
    expect(calls[1]?.args).toEqual([
      "tab",
      "create",
      "--workspace",
      "w1",
      "--label",
      "mytab",
      "--no-focus",
    ]);
  });

  it("newWindow with a command defers to mux-herdr-spawn instead of dropping it", async () => {
    // Silently ignoring the command would produce an empty shell pane
    // that mu believes is running an agent — the worst failure mode.
    mockHerdr([["workspace list", WORKSPACE_LIST]]);
    await expect(
      newWindow({ session: "mu-topotest", name: "t", command: "pi --yolo" }),
    ).rejects.toBeInstanceOf(HerdrNotImplementedError);
  });

  it("selectLayout is a no-op: herdr splits are explicit", async () => {
    // No executor installed on purpose — a no-op must not shell out.
    setHerdrExecutor(async () => {
      throw new Error("selectLayout must not call herdr");
    });
    await expect(herdrBackend.selectLayout("w1:t1", "tiled")).resolves.toBeUndefined();
  });
});

// ─── Panes = mu agents ─────────────────────────────────────────────────

describe("herdr panes", () => {
  it("listPanesInSession resolves the label and tags rows with it", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["pane list", PANE_LIST],
    ]);
    const panes = await listPanesInSession("mu-topotest");
    expect(panes).toEqual([
      {
        paneId: "w1:p1",
        title: "worker-1",
        command: "",
        windowId: "w1:t1",
        sessionName: "mu-topotest",
      },
      { paneId: "w1:p2", title: "", command: "", windowId: "w1:t2", sessionName: "mu-topotest" },
    ]);
  });

  it("listPanesInSession returns [] for a vanished workspace, like tmux does", async () => {
    mockHerdr([["workspace list", WORKSPACE_LIST_EMPTY]]);
    expect(await listPanesInSession("mu-gone")).toEqual([]);
  });

  it("listPanes filters by tab when given a tab id", async () => {
    const calls = mockHerdr([["pane list", PANE_LIST]]);
    expect(await herdrBackend.listPanes("w1:t2")).toEqual([
      { paneId: "w1:p2", title: "", command: "", windowId: "w1:t2" },
    ]);
    // Filtering is client-side: herdr's pane list is workspace-scoped.
    expect(calls[0]?.args).toEqual(["pane", "list", "--workspace", "w1"]);
  });

  it("listPanes('*') fans out across every workspace", async () => {
    mockHerdr([
      ["workspace list", WORKSPACE_LIST],
      ["pane list", PANE_LIST],
    ]);
    const panes = await herdrBackend.listPanes("*");
    expect(panes).toHaveLength(2);
    expect(panes[0]?.sessionName).toBe("mu-topotest");
  });

  it("splitWindow defaults to a right split and never steals focus", async () => {
    const calls = mockHerdr([["pane split", PANE_SPLIT]]);
    expect(await splitWindow({ target: "w1:p1", command: "", cwd: "/tmp" })).toBe("w1:p3");
    expect(calls[0]?.args).toEqual([
      "pane",
      "split",
      "w1:p1",
      "--direction",
      "right",
      "--no-focus",
      "--cwd",
      "/tmp",
    ]);
  });

  it("splitWindow maps horizontal:false to --direction down", async () => {
    const calls = mockHerdr([["pane split", PANE_SPLIT]]);
    await splitWindow({ target: "w1:p1", command: "", horizontal: false });
    expect(calls[0]?.args).toContain("down");
    expect(calls[0]?.args).not.toContain("right");
  });

  it("splitWindow rejects a tmux target before it ever reaches herdr", async () => {
    const calls = mockHerdr([["pane split", PANE_SPLIT]]);
    await expect(splitWindow({ target: "%15", command: "" })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("killPane is idempotent when the pane is already gone", async () => {
    mockHerdr([["pane close", serverError(PANE_NOT_FOUND)]]);
    await expect(herdrBackend.killPane("w1:p9")).resolves.toBeUndefined();
  });

  it("killPane still propagates unexpected server errors", async () => {
    mockHerdr([
      [
        "pane close",
        serverError(JSON.stringify({ error: { code: "server_busy", message: "try later" } })),
      ],
    ]);
    await expect(herdrBackend.killPane("w1:p1")).rejects.toBeInstanceOf(HerdrError);
  });

  it("paneExists is true for a live pane and false for a missing one", async () => {
    mockHerdr([["pane get w1:p1", PANE_GET]]);
    expect(await paneExists("w1:p1")).toBe(true);
    mockHerdr([["pane get", serverError(PANE_NOT_FOUND)]]);
    expect(await paneExists("w1:p9")).toBe(false);
  });

  it("paneExists is false for a tmux id without shelling out", async () => {
    const calls = mockHerdr([["", OK]]);
    expect(await paneExists("%15")).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("paneTTY throws PaneNotFoundError when the pane is gone", async () => {
    mockHerdr([["pane process-info", serverError(PANE_NOT_FOUND)]]);
    await expect(herdrBackend.paneTTY("w1:p9")).rejects.toBeInstanceOf(PaneNotFoundError);
  });
});

// ─── Identity ──────────────────────────────────────────────────────────

describe("herdr identity", () => {
  it("setPaneTitle writes herdr's pane label", async () => {
    const calls = mockHerdr([["pane rename", PANE_GET]]);
    await setPaneTitle("w1:p1", "worker-2 · ⏳ · t-17");
    expect(calls[0]?.args).toEqual(["pane", "rename", "w1:p1", "worker-2 · ⏳ · t-17"]);
  });

  it("getPaneTitle reads the label back", async () => {
    mockHerdr([["pane get", PANE_GET]]);
    expect(await herdrBackend.getPaneTitle("w1:p1")).toBe("mylabel");
  });

  it("getPaneTitle returns undefined for an unlabelled or missing pane", async () => {
    mockHerdr([["pane get", serverError(PANE_NOT_FOUND)]]);
    expect(await herdrBackend.getPaneTitle("w1:p9")).toBeUndefined();
    expect(await herdrBackend.getPaneTitle("%15")).toBeUndefined();
  });

  it("currentAgentName parses the name token out of a composed title", async () => {
    mockHerdr([
      [
        "pane get",
        JSON.stringify({
          result: { pane: { pane_id: "w1:p1", label: "worker-2 · ⏳ · t-17", tab_id: "w1:t1" } },
        }),
      ],
    ]);
    process.env.HERDR_PANE_ID = "w1:p1";
    try {
      expect(await herdrBackend.currentAgentName()).toBe("worker-2");
    } finally {
      const key = "HERDR_PANE_ID";
      delete process.env[key];
    }
  });

  it("currentAgentName is undefined outside a herdr-managed pane", async () => {
    const key = "HERDR_PANE_ID";
    delete process.env[key];
    setHerdrExecutor(async () => {
      throw new Error("must not shell out without $HERDR_PANE_ID");
    });
    expect(await herdrBackend.currentAgentName()).toBeUndefined();
  });
});

// ─── Availability ──────────────────────────────────────────────────────

describe("herdrBackend.available", () => {
  it("is true when the server reports running and compatible", async () => {
    mockHerdr([["status", { stdout: STATUS_RUNNING, stderr: "", exitCode: 0 }]]);
    expect(await herdrBackend.available()).toBe(true);
  });

  it("is false when the binary exists but no server is running", async () => {
    // A herdr with a dead server cannot drive a single pane, so it is
    // not an available backend — the same rule tmux -V encodes.
    mockHerdr([["status", { stdout: STATUS_STOPPED, stderr: "", exitCode: 0 }]]);
    expect(await herdrBackend.available()).toBe(false);
  });

  it("is false when the server speaks an incompatible protocol", async () => {
    mockHerdr([
      [
        "status",
        {
          stdout: STATUS_RUNNING.replace("compatible: yes", "compatible: no"),
          stderr: "",
          exitCode: 0,
        },
      ],
    ]);
    expect(await herdrBackend.available()).toBe(false);
  });

  it("is false when the binary is not installed", async () => {
    setHerdrExecutor(async () => {
      throw new Error("ENOENT");
    });
    expect(await herdrBackend.available()).toBe(false);
  });
});

// ─── Deferred surfaces ─────────────────────────────────────────────────

describe("the IO half is a clear stub, not a guess", () => {
  it("sendToPane names the owning task", async () => {
    await expect(herdrBackend.sendToPane("w1:p1", "hi")).rejects.toThrow(/mux-herdr-io/);
  });

  it("capturePane names the owning task", async () => {
    await expect(herdrBackend.capturePane("w1:p1")).rejects.toBeInstanceOf(
      HerdrNotImplementedError,
    );
  });

  it("pane borders are a no-op: herdr owns its own chrome", async () => {
    setHerdrExecutor(async () => {
      throw new Error("chrome no-ops must not shell out");
    });
    expect(await herdrBackend.enableMuPaneBordersForSession("mu-x")).toBe(0);
    await expect(herdrBackend.enableMuPaneBordersForPane("w1:p1")).resolves.toBeUndefined();
  });
});
