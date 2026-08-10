// The herdr mux backend, IO half: send, capture, native status.
//
// Every JSON/text body below is a VERBATIM capture from a real herdr
// 0.8.0 server (protocol 19) driven through an isolated `herdr --session
// mutest-io`, with one exception called out at its definition
// (AGENT_PROMPT_STALLED, which needs a wedged agent to provoke and is
// reconstructed from the documented envelope + code). Hardcoding the
// recordings keeps this in the fast tier: no subprocess, no server,
// no sleeps.

import { afterEach, describe, expect, it } from "vitest";
import {
  capturePane,
  HerdrError,
  type HerdrExecResult,
  HerdrSyntaxError,
  herdrBackend,
  mapAgentStatus,
  paneStatus,
  resetHerdrExecutor,
  sendToPane,
  setHerdrExecutor,
} from "../src/mux/herdr.js";
import type { SendWarning } from "../src/mux/types.js";

// ─── Recorded fixtures ─────────────────────────────────────────────────

const AGENT_PROMPTED = JSON.stringify({
  id: "cli:agent:prompt",
  result: {
    agent: {
      agent: "pi",
      agent_status: "idle",
      interactive_ready: true,
      name: "iotest",
      pane_id: "w1:p2",
      state_change_seq: 3,
      tab_id: "w1:t1",
      workspace_id: "w1",
    },
    type: "agent_prompted",
  },
});

/** Verbatim: `herdr agent prompt w1:p1 "echo hi" --wait` against a pane
 *  running a plain shell — herdr will not address a non-agent pane
 *  through the agent surface. This is topology gotcha 9 in the wild. */
const AGENT_NOT_FOUND = JSON.stringify({
  error: { code: "agent_not_found", message: "agent target w1:p1 not found" },
  id: "cli:agent:prompt",
});

/** RECONSTRUCTED, not captured: provoking it needs an agent that accepts
 *  a prompt and then refuses to change state. Shape follows herdr's
 *  documented error envelope; the code string is from `herdr agent
 *  prompt --help` ("otherwise Herdr returns agent_prompt_stalled"). */
const AGENT_PROMPT_STALLED = JSON.stringify({
  error: {
    code: "agent_prompt_stalled",
    message: "no agent state change observed within 5000ms",
  },
  id: "cli:agent:prompt",
});

const PANE_RUN_OK = JSON.stringify({ id: "cli:pane:run", result: { type: "ok" } });

const PANE_NOT_FOUND = JSON.stringify({
  error: { code: "pane_not_found", message: "pane w9:p9 not found" },
  id: "cli:pane:read",
});

/** Verbatim `pane read --source recent-unwrapped` output: plain text, no
 *  JSON envelope. This is the second of herdr's two non-JSON verbs. */
const READ_TEXT = [
  "~ ❯ echo hello-from-mu",
  "hello-from-mu",
  "~ ❯ echo second",
  "second",
  "~ ❯",
].join("\n");

const paneGet = (agentStatus: string | undefined): string =>
  JSON.stringify({
    id: "cli:pane:get",
    result: {
      pane: {
        ...(agentStatus === undefined ? {} : { agent_status: agentStatus }),
        focused: false,
        pane_id: "w1:p2",
        tab_id: "w1:t1",
        workspace_id: "w1",
      },
      type: "pane_info",
    },
  });

// ─── Executor harness ──────────────────────────────────────────────────

interface Call {
  args: readonly string[];
}

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

// ─── Send ──────────────────────────────────────────────────────────────

describe("herdr sendToPane: one atomic call, no tmux workaround", () => {
  it("issues exactly ONE herdr call: agent prompt <pane> <text> --wait", async () => {
    const calls = mockHerdr([["agent prompt", AGENT_PROMPTED]]);
    await sendToPane("w1:p2", "do the thing");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["agent", "prompt", "w1:p2", "do the thing", "--wait"]);
  });

  it("makes NO capture/quiescence/retry round trips — the tmux dance is not ported", async () => {
    // THE LOAD-BEARING TEST. tmux's send is 6 steps because a TUI
    // rendering a modal swallows a separately-sent Enter
    // (dogfood_send_after_new_dropped): a readiness poll before, a
    // delay in the middle, and a stranded-text check with Enter retries
    // after. `agent prompt` submits text + encoded Enter atomically, so
    // none of that can apply. If this ever fails, someone re-added the
    // workaround to a substrate that does not have the bug.
    const calls = mockHerdr([["agent prompt", AGENT_PROMPTED]]);
    await sendToPane("w1:p2", "do the thing");
    const verbs = calls.map((c) => `${c.args[0]} ${c.args[1]}`);
    expect(verbs).toEqual(["agent prompt"]);
    expect(verbs.filter((v) => v === "pane read")).toEqual([]);
    expect(calls.filter((c) => c.args.includes("send-keys"))).toEqual([]);
  });

  it("does NOT pass --until: --wait's defaults are already the right ones", async () => {
    // herdr's skill doc: "For normal agent work, --wait is enough … Do
    // not repeat those defaults with --until."
    const calls = mockHerdr([["agent prompt", AGENT_PROMPTED]]);
    await sendToPane("w1:p2", "hi");
    expect(calls[0]?.args).not.toContain("--until");
  });

  it("readinessMs: 0 drops --wait (the fire-and-forget opt-out)", async () => {
    const calls = mockHerdr([["agent prompt", AGENT_PROMPTED]]);
    await sendToPane("w1:p2", "hi", { readinessMs: 0 });
    expect(calls[0]?.args).toEqual(["agent", "prompt", "w1:p2", "hi"]);
  });

  it("ignores delayMs: the gap it sizes does not exist on this backend", async () => {
    const calls = mockHerdr([["agent prompt", AGENT_PROMPTED]]);
    await sendToPane("w1:p2", "hi", { delayMs: 5000 });
    expect(calls).toHaveLength(1);
  });

  it("rejects a tmux pane id at the call site", async () => {
    setHerdrExecutor(async () => {
      throw new Error("must not shell out with an invalid pane id");
    });
    await expect(sendToPane("%15", "hi")).rejects.toThrow(/invalid herdr pane id/);
  });

  it("passes text through verbatim — no escaping, no shell", async () => {
    const calls = mockHerdr([["agent prompt", AGENT_PROMPTED]]);
    const text = "/new ? then run `ls -la` --flag\nsecond line";
    await sendToPane("w1:p2", text);
    expect(calls[0]?.args[3]).toBe(text);
  });
});

describe("herdr sendToPane: agent_prompt_stalled warns, never throws", () => {
  it("surfaces a SendWarning and resolves", async () => {
    mockHerdr([["agent prompt", serverError(AGENT_PROMPT_STALLED)]]);
    const warnings: SendWarning[] = [];
    await expect(
      sendToPane("w1:p2", "hi", { onUndelivered: (w) => warnings.push(w) }),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.paneId).toBe("w1:p2");
    expect(warnings[0]?.reason).toBe("paste-vanished");
    expect(warnings[0]?.message).toMatch(/agent_prompt_stalled/);
    expect(warnings[0]?.message).toMatch(/NOT have seen it/);
  });

  it("does not fall through to the pane surface after a stall", async () => {
    // The text WAS submitted; re-sending it through `pane run` would
    // duplicate the prompt.
    const calls = mockHerdr([["agent prompt", serverError(AGENT_PROMPT_STALLED)]]);
    await sendToPane("w1:p2", "hi", { onUndelivered: () => {} });
    expect(calls).toHaveLength(1);
  });

  it("warns on stderr by default — silence is the failure mode", async () => {
    mockHerdr([["agent prompt", serverError(AGENT_PROMPT_STALLED)]]);
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => {
      seen.push(String(msg));
    };
    try {
      await sendToPane("w1:p2", "hi");
    } finally {
      console.warn = original;
    }
    expect(seen.join("\n")).toMatch(/agent_prompt_stalled/);
  });
});

describe("herdr sendToPane: surface fallback for panes with no recognized agent", () => {
  it("falls back to `pane run` when herdr reports agent_not_found", async () => {
    // Topology gotcha 9: `agent prompt` only accepts targets herdr has
    // RECOGNIZED as an agent. A plain shell pane needs the pane surface,
    // whose `pane run` is likewise atomic text+Enter.
    const calls = mockHerdr([
      ["agent prompt", serverError(AGENT_NOT_FOUND)],
      ["pane run", PANE_RUN_OK],
    ]);
    await sendToPane("w1:p1", "echo hi");
    expect(calls.map((c) => c.args)).toEqual([
      ["agent", "prompt", "w1:p1", "echo hi", "--wait"],
      ["pane", "run", "w1:p1", "echo hi"],
    ]);
  });

  it("still makes no capture round trips on the fallback path", async () => {
    const calls = mockHerdr([
      ["agent prompt", serverError(AGENT_NOT_FOUND)],
      ["pane run", PANE_RUN_OK],
    ]);
    await sendToPane("w1:p1", "echo hi");
    expect(calls.filter((c) => c.args[1] === "read")).toEqual([]);
  });

  it("propagates any OTHER server error instead of falling back", async () => {
    // A real outage must not be retried as a shell command; that would
    // run agent prose in a shell.
    const calls = mockHerdr([
      [
        "agent prompt",
        serverError(
          JSON.stringify({ error: { code: "pane_not_found", message: "pane w9:p9 not found" } }),
        ),
      ],
    ]);
    await expect(sendToPane("w9:p9", "hi")).rejects.toBeInstanceOf(HerdrError);
    expect(calls).toHaveLength(1);
  });

  it("exit 2 on the agent surface stays a syntax (mu bug) error", async () => {
    mockHerdr([["agent prompt", { stdout: "usage: herdr agent prompt", stderr: "", exitCode: 2 }]]);
    await expect(sendToPane("w1:p2", "hi")).rejects.toBeInstanceOf(HerdrSyntaxError);
  });
});

// ─── Capture ───────────────────────────────────────────────────────────

describe("herdr capturePane: the three CaptureOptions shapes", () => {
  it("no options → everything available, soft wraps joined", async () => {
    const calls = mockHerdr([["pane read", READ_TEXT]]);
    expect(await capturePane("w1:p1")).toBe(READ_TEXT);
    expect(calls[0]?.args).toEqual(["pane", "read", "w1:p1", "--source", "recent-unwrapped"]);
  });

  it("lines: 0 → the rendered viewport only", async () => {
    const calls = mockHerdr([["pane read", READ_TEXT]]);
    await capturePane("w1:p1", { lines: 0 });
    expect(calls[0]?.args).toEqual(["pane", "read", "w1:p1", "--source", "visible"]);
    expect(calls[0]?.args).not.toContain("--lines");
  });

  it("lines: N → the last N rows, still soft-wrap-joined", async () => {
    const calls = mockHerdr([["pane read", READ_TEXT]]);
    await capturePane("w1:p1", { lines: 100 });
    expect(calls[0]?.args).toEqual([
      "pane",
      "read",
      "w1:p1",
      "--source",
      "recent-unwrapped",
      "--lines",
      "100",
    ]);
  });

  it("returns plain text unparsed — `pane read` emits no JSON envelope", async () => {
    mockHerdr([["pane read", READ_TEXT]]);
    const out = await capturePane("w1:p1", { lines: 50 });
    expect(out).toContain("hello-from-mu");
    expect(() => JSON.parse(out)).toThrow();
  });

  it("maps a pane_not_found envelope to a HerdrError carrying the code", async () => {
    mockHerdr([["pane read", serverError(PANE_NOT_FOUND)]]);
    const err = await capturePane("w9:p9").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err instanceof HerdrError ? err.code : undefined).toBe("pane_not_found");
  });

  it("exit 2 is a syntax (mu bug) error, not an outage", async () => {
    mockHerdr([["pane read", { stdout: "usage: herdr pane read", stderr: "", exitCode: 2 }]]);
    await expect(capturePane("w1:p1")).rejects.toBeInstanceOf(HerdrSyntaxError);
  });

  it("rejects a tmux pane id at the call site", async () => {
    setHerdrExecutor(async () => {
      throw new Error("must not shell out with an invalid pane id");
    });
    await expect(capturePane("%15")).rejects.toThrow(/invalid herdr pane id/);
  });
});

// ─── Status ────────────────────────────────────────────────────────────

describe("herdr status mapping: the mux already knows", () => {
  it("working → busy", () => {
    expect(mapAgentStatus("working")).toBe("busy");
  });

  it("blocked → needs_permission", () => {
    expect(mapAgentStatus("blocked")).toBe("needs_permission");
  });

  it("idle → needs_input", () => {
    expect(mapAgentStatus("idle")).toBe("needs_input");
  });

  it("done → needs_input (idle after UNSEEN background work)", () => {
    expect(mapAgentStatus("done")).toBe("needs_input");
  });

  it("unknown → needs_input, and specifically NOT free", () => {
    // herdr's skill doc: unknown "does not prove completion". A false
    // `free` makes mu hand the worker another task mid-run, which is the
    // worst available failure. `free` is user-set only; no detector,
    // native or scraped, may mint it.
    const mapped: string = mapAgentStatus("unknown");
    expect(mapped).toBe("needs_input");
    expect(mapped).not.toBe("free");
  });

  it("an unrecognised future state also refuses to become free", () => {
    const mapped: string = mapAgentStatus("compacting");
    expect(mapped).toBe("needs_input");
    expect(mapped).not.toBe("free");
  });

  it("paneStatus reads agent_status off `pane get`", async () => {
    const calls = mockHerdr([["pane get", paneGet("working")]]);
    expect(await paneStatus("w1:p2")).toBe("busy");
    expect(calls[0]?.args).toEqual(["pane", "get", "w1:p2"]);
  });

  it("paneStatus NEVER calls a focus or seen-marking verb", async () => {
    // CLI reads deliberately do not mark a tab seen, which is what keeps
    // mu's polling from silently clearing the user's `done` badge.
    const calls = mockHerdr([["pane get", paneGet("done")]]);
    expect(await paneStatus("w1:p2")).toBe("needs_input");
    const verbs = calls.map((c) => c.args.join(" "));
    expect(verbs.filter((v) => /focus|seen|attach/.test(v))).toEqual([]);
  });

  it("paneStatus is undefined for a vanished pane, not a status", async () => {
    mockHerdr([["pane get", serverError(PANE_NOT_FOUND)]]);
    expect(await paneStatus("w9:p9")).toBeUndefined();
  });

  it("paneStatus is undefined when herdr reports no agent_status at all", async () => {
    mockHerdr([["pane get", paneGet(undefined)]]);
    expect(await paneStatus("w1:p2")).toBeUndefined();
  });

  it("paneStatus rejects a tmux pane id without shelling out", async () => {
    setHerdrExecutor(async () => {
      throw new Error("must not shell out with an invalid pane id");
    });
    expect(await paneStatus("%15")).toBeUndefined();
  });

  it("the backend record exposes paneStatus; tmux deliberately does not", async () => {
    const { tmuxBackend } = await import("../src/mux/tmux.js");
    expect(typeof herdrBackend.paneStatus).toBe("function");
    expect(tmuxBackend.paneStatus).toBeUndefined();
  });
});
