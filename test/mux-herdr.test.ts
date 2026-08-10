// The herdr mux backend, topology half.
//
// Fast tier: every response is a recorded fixture from test/_mux-fixtures.ts
// (verbatim captures from a real herdr 0.8.0 server, protocol 19). No
// subprocess, no server, no sleeps. The backend + executor pair is
// installed through the shared seam in test/_mux.ts, so this file never
// has to know that "testing herdr" means calling two setters.

import { afterEach, describe, expect, it } from "vitest";
import {
  HerdrError,
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
  sessionExists,
  setPaneTitle,
  splitWindow,
} from "../src/mux/herdr.js";
import { PaneNotFoundError } from "../src/mux/types.js";
import { installMux, type MuxExecResult, type MuxExecutor, type MuxHarness } from "./_mux.js";
import {
  OK,
  PANE_GET,
  PANE_LIST,
  PANE_NOT_FOUND,
  PANE_SPLIT,
  STATUS_INCOMPATIBLE,
  STATUS_RUNNING,
  STATUS_STOPPED,
  TAB_CREATED,
  TAB_LIST,
  WORKSPACE_CREATED,
  WORKSPACE_LIST,
  WORKSPACE_LIST_EMPTY,
  WORKSPACE_NOT_FOUND,
} from "./_mux-fixtures.js";

// ─── Executor harness ──────────────────────────────────────────────────

let harness: MuxHarness | undefined;

/** Install the herdr backend with a prefix-routed executor. */
function mockHerdr(routes: Array<[string, MuxExecResult | string]>): MuxHarness {
  harness = installMux("herdr", routes);
  return harness;
}

/** Install an executor with arbitrary behaviour (throwing, counting). */
function mockHerdrWith(executor: MuxExecutor): MuxHarness {
  harness = installMux("herdr", executor);
  return harness;
}

const serverError = (payload: string): MuxExecResult => ({
  stdout: "",
  stderr: payload,
  exitCode: 1,
});

afterEach(() => {
  harness?.restore();
  harness = undefined;
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
    expect(calls.argsOf(0)).toEqual([
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
    expect(calls.argsOf(0)).toContain("--no-focus");
    expect(calls.argsOf(0)).not.toContain("--focus");
  });

  it("newSession forwards env as --env KEY=VALUE", async () => {
    const calls = mockHerdr([["workspace create", WORKSPACE_CREATED]]);
    await newSession("mu-auth", { env: { MU_AGENT_NAME: "w1" } });
    expect(calls.argsOf(0)).toEqual([
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
    expect(calls.argsOf(1)).toEqual(["workspace", "close", "w1"]);
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
    expect(calls.argsOf(1)).toEqual(["tab", "list", "--workspace", "w1"]);
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
    expect(calls.argsOf(1)).toEqual([
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
    mockHerdrWith(async () => {
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
    expect(calls.argsOf(0)).toEqual(["pane", "list", "--workspace", "w1"]);
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
    expect(calls.argsOf(0)).toEqual([
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
    expect(calls.argsOf(0)).toContain("down");
    expect(calls.argsOf(0)).not.toContain("right");
  });

  it("splitWindow rejects a tmux target before it ever reaches herdr", async () => {
    const calls = mockHerdr([["pane split", PANE_SPLIT]]);
    await expect(splitWindow({ target: "%15", command: "" })).rejects.toBeInstanceOf(TypeError);
    expect(calls.calls).toHaveLength(0);
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
    expect(calls.calls).toHaveLength(0);
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
    expect(calls.argsOf(0)).toEqual(["pane", "rename", "w1:p1", "worker-2 · ⏳ · t-17"]);
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
    mockHerdrWith(async () => {
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
          stdout: STATUS_INCOMPATIBLE,
          stderr: "",
          exitCode: 0,
        },
      ],
    ]);
    expect(await herdrBackend.available()).toBe(false);
  });

  it("is false when the binary is not installed", async () => {
    mockHerdrWith(async () => {
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
    mockHerdrWith(async () => {
      throw new Error("chrome no-ops must not shell out");
    });
    expect(await herdrBackend.enableMuPaneBordersForSession("mu-x")).toBe(0);
    await expect(herdrBackend.enableMuPaneBordersForPane("w1:p1")).resolves.toBeUndefined();
  });
});
