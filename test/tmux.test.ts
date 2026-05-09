// Unit tests for src/tmux.ts. Uses a mocked executor so we can verify
// exactly which tmux args each function emits, without needing a real
// tmux server. Integration tests against real tmux live in
// test/tmux.integration.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STATUS_EMOJI } from "../src/agents.js";
import {
  PANE_ID_RE,
  TmuxError,
  type TmuxExecResult,
  type TmuxExecutor,
  assertValidPaneId,
  capturePane,
  defaultSendDelayMs,
  enableMuPaneBorders,
  isValidPaneId,
  killPane,
  killSession,
  listPanes,
  listSessions,
  listWindows,
  newSession,
  newSessionWithPane,
  newWindow,
  paneExists,
  parseAgentNameFromTitle,
  resetSleep,
  resetTmuxExecutor,
  selectLayout,
  sendToPane,
  sessionExists,
  setPaneTitle,
  setSleepForTests,
  setTmuxExecutor,
  splitWindow,
  tmux,
} from "../src/tmux.js";

// ─── Mock executor harness ────────────────────────────────────────────

interface RecordedCall {
  args: string[];
}

function harness(responder: (args: string[]) => TmuxExecResult): {
  calls: RecordedCall[];
  executor: TmuxExecutor;
} {
  const calls: RecordedCall[] = [];
  const executor: TmuxExecutor = async (args) => {
    calls.push({ args: [...args] });
    return responder([...args]);
  };
  return { calls, executor };
}

const ok = (stdout = ""): TmuxExecResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1, stdout = ""): TmuxExecResult => ({
  stdout,
  stderr,
  exitCode,
});

beforeEach(() => {
  resetTmuxExecutor();
  // Replace sleep with no-op so send tests don't actually wait.
  setSleepForTests(async () => {});
});

afterEach(() => {
  resetTmuxExecutor();
  resetSleep();
});

// ─── Pane ID validation ────────────────────────────────────────────────

describe("pane id validation", () => {
  it("accepts %0, %15, %999", () => {
    expect(isValidPaneId("%0")).toBe(true);
    expect(isValidPaneId("%15")).toBe(true);
    expect(isValidPaneId("%999")).toBe(true);
    expect(PANE_ID_RE.test("%42")).toBe(true);
  });

  it("rejects pane indexes (0, 1, 2)", () => {
    expect(isValidPaneId("0")).toBe(false);
    expect(isValidPaneId("1")).toBe(false);
  });

  it("rejects window ids (@1)", () => {
    expect(isValidPaneId("@1")).toBe(false);
  });

  it("rejects session ids ($1)", () => {
    expect(isValidPaneId("$1")).toBe(false);
  });

  it("rejects empty/garbage", () => {
    expect(isValidPaneId("")).toBe(false);
    expect(isValidPaneId("%")).toBe(false);
    expect(isValidPaneId("%abc")).toBe(false);
    expect(isValidPaneId("%15;rm -rf")).toBe(false);
    expect(isValidPaneId(" %15")).toBe(false);
  });

  it("assertValidPaneId throws on bad input", () => {
    expect(() => assertValidPaneId("0")).toThrow(TypeError);
    expect(() => assertValidPaneId("%abc")).toThrow(/invalid tmux pane id/);
  });

  it("assertValidPaneId returns void on good input", () => {
    expect(() => assertValidPaneId("%15")).not.toThrow();
  });
});

// ─── Low-level tmux() wrapper ─────────────────────────────────────────

describe("tmux() wrapper", () => {
  it("returns stdout on success", async () => {
    const { executor } = harness(() => ok("hello\n"));
    setTmuxExecutor(executor);
    expect(await tmux(["foo"])).toBe("hello\n");
  });

  it("throws TmuxError on non-zero exit", async () => {
    const { executor } = harness(() => fail("bad arg"));
    setTmuxExecutor(executor);
    await expect(tmux(["bad"])).rejects.toBeInstanceOf(TmuxError);
  });

  it("TmuxError carries args, stderr, stdout, exitCode", async () => {
    const { executor } = harness(() => fail("nope", 2, "partial"));
    setTmuxExecutor(executor);
    try {
      await tmux(["x", "y"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TmuxError);
      const e = err as TmuxError;
      expect(e.args).toEqual(["x", "y"]);
      expect(e.stderr).toBe("nope");
      expect(e.stdout).toBe("partial");
      expect(e.exitCode).toBe(2);
      expect(e.message).toContain("tmux x y failed (exit 2)");
      expect(e.message).toContain("nope");
    }
  });

  it("records exact args passed to executor", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await tmux(["a", "b", "c"]);
    expect(calls).toEqual([{ args: ["a", "b", "c"] }]);
  });
});

// ─── defaultSendDelayMs ───────────────────────────────────────────────

describe("defaultSendDelayMs", () => {
  // env var deletion: must use `delete process.env[key]` (computed-key form);
  // assigning `undefined` would coerce to the literal string "undefined".
  function withEnv(value: string | undefined, fn: () => void): void {
    const key = "MU_SEND_DELAY_MS";
    const original = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    try {
      fn();
    } finally {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }

  it("defaults to 500 when env unset", () => {
    withEnv(undefined, () => expect(defaultSendDelayMs()).toBe(500));
  });

  it("respects MU_SEND_DELAY_MS env var", () => {
    withEnv("100", () => expect(defaultSendDelayMs()).toBe(100));
    withEnv("0", () => expect(defaultSendDelayMs()).toBe(0));
    withEnv("2000", () => expect(defaultSendDelayMs()).toBe(2000));
  });

  it("falls back to 500 on garbage", () => {
    withEnv("not-a-number", () => expect(defaultSendDelayMs()).toBe(500));
    withEnv("-1", () => expect(defaultSendDelayMs()).toBe(500));
  });
});

// ─── Sessions ──────────────────────────────────────────────────────────

describe("listSessions", () => {
  it("parses tab-separated names", async () => {
    const { executor } = harness(() => ok("alpha\nbeta\ngamma\n"));
    setTmuxExecutor(executor);
    expect(await listSessions()).toEqual([{ name: "alpha" }, { name: "beta" }, { name: "gamma" }]);
  });

  it("returns empty list when no server is running", async () => {
    const { executor } = harness(() => fail("no server running on /tmp/tmux-501/default"));
    setTmuxExecutor(executor);
    expect(await listSessions()).toEqual([]);
  });

  it("returns empty list when no sessions", async () => {
    const { executor } = harness(() => fail("no sessions"));
    setTmuxExecutor(executor);
    expect(await listSessions()).toEqual([]);
  });

  it("propagates other errors", async () => {
    const { executor } = harness(() => fail("permission denied"));
    setTmuxExecutor(executor);
    await expect(listSessions()).rejects.toBeInstanceOf(TmuxError);
  });
});

describe("sessionExists", () => {
  it("true on exit 0", async () => {
    const { executor } = harness(() => ok());
    setTmuxExecutor(executor);
    expect(await sessionExists("foo")).toBe(true);
  });

  it("false on non-zero exit", async () => {
    const { executor } = harness(() => fail("can't find session: foo"));
    setTmuxExecutor(executor);
    expect(await sessionExists("foo")).toBe(false);
  });

  it("calls tmux has-session -t <name>", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await sessionExists("foo");
    expect(calls).toEqual([{ args: ["has-session", "-t", "foo"] }]);
  });
});

describe("newSession", () => {
  it("invokes new-session -d -s <name>", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await newSession("foo");
    expect(calls[0]?.args).toEqual(["new-session", "-d", "-s", "foo"]);
  });

  it("includes window name and command when provided", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await newSession("foo", { windowName: "main", command: "bash" });
    expect(calls[0]?.args).toEqual(["new-session", "-d", "-s", "foo", "-n", "main", "bash"]);
  });
});

describe("killSession", () => {
  it("succeeds on normal kill", async () => {
    const { executor } = harness(() => ok());
    setTmuxExecutor(executor);
    await expect(killSession("foo")).resolves.toBeUndefined();
  });

  it("succeeds idempotently when session is already gone", async () => {
    const { executor } = harness(() => fail("can't find session: foo"));
    setTmuxExecutor(executor);
    await expect(killSession("foo")).resolves.toBeUndefined();
  });

  it("propagates other errors", async () => {
    const { executor } = harness(() => fail("server unreachable"));
    setTmuxExecutor(executor);
    await expect(killSession("foo")).rejects.toBeInstanceOf(TmuxError);
  });
});

// ─── Windows ───────────────────────────────────────────────────────────

describe("listWindows", () => {
  it("parses session-scoped output", async () => {
    const { executor } = harness(() => ok("@1\tmain\n@2\tBackend\n"));
    setTmuxExecutor(executor);
    expect(await listWindows("foo")).toEqual([
      { id: "@1", name: "main" },
      { id: "@2", name: "Backend" },
    ]);
  });

  it("parses cross-session output", async () => {
    const { executor } = harness(() => ok("alpha\t@1\tmain\nbeta\t@2\tReview\n"));
    setTmuxExecutor(executor);
    expect(await listWindows()).toEqual([
      { id: "@1", name: "main", sessionName: "alpha" },
      { id: "@2", name: "Review", sessionName: "beta" },
    ]);
  });

  it("handles empty windows (window with empty name)", async () => {
    // tmux can have empty window names; we should still parse.
    const { executor } = harness(() => ok("@1\t\n"));
    setTmuxExecutor(executor);
    expect(await listWindows("foo")).toEqual([{ id: "@1", name: "" }]);
  });
});

describe("newWindow", () => {
  it("calls new-window -d -t <session> -n <name> with command", async () => {
    const { executor, calls } = harness(() => ok("%15\n"));
    setTmuxExecutor(executor);
    const paneId = await newWindow({ session: "foo", name: "Backend", command: "bash" });
    expect(paneId).toBe("%15");
    expect(calls[0]?.args).toEqual([
      "new-window",
      "-d",
      "-t",
      "foo",
      "-n",
      "Backend",
      "-P",
      "-F",
      "#{pane_id}",
      "bash",
    ]);
  });

  it("rejects non-pane-id output (defensive)", async () => {
    const { executor } = harness(() => ok("not a pane id\n"));
    setTmuxExecutor(executor);
    await expect(newWindow({ name: "x", command: "bash" })).rejects.toThrow(/invalid tmux pane id/);
  });
});

// ─── Panes ─────────────────────────────────────────────────────────────

describe("listPanesInSession", () => {
  it("calls list-panes -s -t <session> with the session-scoped format", async () => {
    const { executor, calls } = harness(() => ok("@1\t%5\talice\tpi\n@2\t%6\trev\tclaude\n"));
    setTmuxExecutor(executor);
    const { listPanesInSession } = await import("../src/tmux.js");
    const panes = await listPanesInSession("mu-auth");
    expect(calls[0]?.args.slice(0, 4)).toEqual(["list-panes", "-s", "-t", "mu-auth"]);
    expect(panes).toEqual([
      { paneId: "%5", title: "alice", command: "pi", windowId: "@1" },
      { paneId: "%6", title: "rev", command: "claude", windowId: "@2" },
    ]);
  });

  it("returns empty array when session has no panes", async () => {
    const { executor } = harness(() => ok(""));
    setTmuxExecutor(executor);
    const { listPanesInSession } = await import("../src/tmux.js");
    expect(await listPanesInSession("mu-empty")).toEqual([]);
  });

  it("returns [] when the session does not exist (tmux destroys it on last pane close)", async () => {
    const { executor } = harness(() => fail("can't find session: mu-ghost"));
    setTmuxExecutor(executor);
    const { listPanesInSession } = await import("../src/tmux.js");
    expect(await listPanesInSession("mu-ghost")).toEqual([]);
  });

  it("returns [] when tmux reports 'can't find window' for the session target (tmux quirk)", async () => {
    // Some tmux versions report the missing-session case with a 'window' wording.
    const { executor } = harness(() => fail("can't find window: mu-ghost"));
    setTmuxExecutor(executor);
    const { listPanesInSession } = await import("../src/tmux.js");
    expect(await listPanesInSession("mu-ghost")).toEqual([]);
  });

  it("propagates TmuxError on unexpected failures", async () => {
    const { executor } = harness(() => fail("server crashed"));
    setTmuxExecutor(executor);
    const { listPanesInSession } = await import("../src/tmux.js");
    await expect(listPanesInSession("mu-ghost")).rejects.toBeInstanceOf(TmuxError);
  });
});

describe("listPanes", () => {
  it("parses single-target output", async () => {
    const { executor } = harness(() => ok("%5\talice\tclaude\n%6\tbob\tbash\n"));
    setTmuxExecutor(executor);
    expect(await listPanes(":Backend")).toEqual([
      { paneId: "%5", title: "alice", command: "claude" },
      { paneId: "%6", title: "bob", command: "bash" },
    ]);
  });

  it("uses -a for cross-session listing when target is '*'", async () => {
    const { executor, calls } = harness(() =>
      ok("alpha\t@1\t%5\talice\tclaude\nbeta\t@2\t%6\tbob\tbash\n"),
    );
    setTmuxExecutor(executor);
    const panes = await listPanes("*");
    expect(calls[0]?.args).toContain("-a");
    expect(panes).toEqual([
      {
        paneId: "%5",
        title: "alice",
        command: "claude",
        windowId: "@1",
        sessionName: "alpha",
      },
      {
        paneId: "%6",
        title: "bob",
        command: "bash",
        windowId: "@2",
        sessionName: "beta",
      },
    ]);
  });

  it("handles empty title", async () => {
    const { executor } = harness(() => ok("%5\t\tbash\n"));
    setTmuxExecutor(executor);
    expect(await listPanes()).toEqual([{ paneId: "%5", title: "", command: "bash" }]);
  });

  it("calls list-panes with no -t when target omitted (current session)", async () => {
    const { executor, calls } = harness(() => ok(""));
    setTmuxExecutor(executor);
    await listPanes();
    expect(calls[0]?.args).toEqual([
      "list-panes",
      "-F",
      "#{pane_id}\t#{pane_title}\t#{pane_current_command}",
    ]);
  });
});

describe("splitWindow", () => {
  it("calls split-window -h -d -t <target> -P -F", async () => {
    const { executor, calls } = harness(() => ok("%16\n"));
    setTmuxExecutor(executor);
    const id = await splitWindow({ target: ":Backend", command: "bash" });
    expect(id).toBe("%16");
    expect(calls[0]?.args).toEqual([
      "split-window",
      "-h",
      "-d",
      "-t",
      ":Backend",
      "-P",
      "-F",
      "#{pane_id}",
      "bash",
    ]);
  });

  it("vertical split when horizontal: false", async () => {
    const { executor, calls } = harness(() => ok("%17\n"));
    setTmuxExecutor(executor);
    await splitWindow({ target: "%15", command: "bash", horizontal: false });
    expect(calls[0]?.args).not.toContain("-h");
  });
});

// ─── Pane env injection (-e KEY=VALUE) ───────────────────────────
//
// All four pane-creating helpers (newSession, newSessionWithPane,
// newWindow, splitWindow) accept an optional env: Record<string,string>
// that emits one tmux `-e KEY=VALUE` flag per entry. The flag must be
// emitted BEFORE the command argument; tmux 3.0+ supports it on all
// three subcommands.

/** Assert that args contains the pair `-e`, `KEY=VALUE` adjacent. */
function expectEnvFlag(args: string[], key: string, value: string): void {
  const expected = `${key}=${value}`;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-e" && args[i + 1] === expected) return;
  }
  throw new Error(`expected -e ${expected} in args, got: ${args.join(" ")}`);
}

/** Index of the first `-e` flag in args, or -1 if none. */
function firstEnvFlagIndex(args: string[]): number {
  return args.indexOf("-e");
}

/** Find the index of the command arg in args. tmux helpers always pass
 *  the command as the LAST positional after `-P -F #{pane_id}` (or as
 *  the last arg for newSession). */
function commandIndex(args: string[]): number {
  return args.length - 1;
}

describe("newWindow with env", () => {
  it("emits one -e KEY=VALUE per entry, before the command arg", async () => {
    const { executor, calls } = harness(() => ok("%20\n"));
    setTmuxExecutor(executor);
    await newWindow({
      session: "foo",
      name: "Backend",
      command: "bash",
      env: { FOO: "bar", BAZ: "qux" },
    });
    const args = calls[0]?.args ?? [];
    expectEnvFlag(args, "FOO", "bar");
    expectEnvFlag(args, "BAZ", "qux");
    // -e must come before the command (last positional).
    expect(firstEnvFlagIndex(args)).toBeLessThan(commandIndex(args));
  });

  it("emits no -e flags when env is omitted", async () => {
    const { executor, calls } = harness(() => ok("%21\n"));
    setTmuxExecutor(executor);
    await newWindow({ session: "foo", name: "Backend", command: "bash" });
    expect(calls[0]?.args).not.toContain("-e");
  });

  it("throws TypeError on empty key", async () => {
    const { executor } = harness(() => ok("%22\n"));
    setTmuxExecutor(executor);
    await expect(
      newWindow({
        session: "foo",
        name: "Backend",
        command: "bash",
        env: { "": "x" },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("throws TypeError on key containing '='", async () => {
    const { executor } = harness(() => ok("%23\n"));
    setTmuxExecutor(executor);
    await expect(
      newWindow({
        session: "foo",
        name: "Backend",
        command: "bash",
        env: { "BAD=KEY": "x" },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("splitWindow with env", () => {
  it("emits one -e KEY=VALUE per entry, before the command arg", async () => {
    const { executor, calls } = harness(() => ok("%24\n"));
    setTmuxExecutor(executor);
    await splitWindow({
      target: ":Backend",
      command: "bash",
      env: { FOO: "bar", BAZ: "qux" },
    });
    const args = calls[0]?.args ?? [];
    expectEnvFlag(args, "FOO", "bar");
    expectEnvFlag(args, "BAZ", "qux");
    expect(firstEnvFlagIndex(args)).toBeLessThan(commandIndex(args));
  });
});

describe("newSessionWithPane with env", () => {
  it("emits one -e KEY=VALUE per entry, before the command arg", async () => {
    const { executor, calls } = harness(() => ok("%25\n"));
    setTmuxExecutor(executor);
    await newSessionWithPane("mu-foo", {
      windowName: "alice",
      command: "bash",
      env: { FOO: "bar", BAZ: "qux" },
    });
    const args = calls[0]?.args ?? [];
    expectEnvFlag(args, "FOO", "bar");
    expectEnvFlag(args, "BAZ", "qux");
    expect(firstEnvFlagIndex(args)).toBeLessThan(commandIndex(args));
  });
});

describe("newSession with env", () => {
  it("emits -e KEY=VALUE flags (kept symmetric with the other pane-creating helpers)", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await newSession("mu-foo", { env: { FOO: "bar" } });
    expect(calls[0]?.args).toContain("-e");
    expect(calls[0]?.args).toContain("FOO=bar");
  });
});

describe("killPane", () => {
  it("invokes kill-pane -t <pane>", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await killPane("%15");
    expect(calls[0]?.args).toEqual(["kill-pane", "-t", "%15"]);
  });

  it("idempotent on already-gone pane", async () => {
    const { executor } = harness(() => fail("can't find pane: %15"));
    setTmuxExecutor(executor);
    await expect(killPane("%15")).resolves.toBeUndefined();
  });

  it("propagates other errors", async () => {
    const { executor } = harness(() => fail("server gone"));
    setTmuxExecutor(executor);
    await expect(killPane("%15")).rejects.toBeInstanceOf(TmuxError);
  });

  it("rejects invalid pane ids before calling tmux", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await expect(killPane("0")).rejects.toThrow(/invalid tmux pane id/);
    expect(calls).toEqual([]);
  });
});

describe("paneExists", () => {
  it("true when display-message echoes the pane id", async () => {
    const { executor } = harness(() => ok("%15\n"));
    setTmuxExecutor(executor);
    expect(await paneExists("%15")).toBe(true);
  });

  it("false on non-zero exit", async () => {
    const { executor } = harness(() => fail("can't find pane"));
    setTmuxExecutor(executor);
    expect(await paneExists("%15")).toBe(false);
  });

  it("false when display-message exits 0 but echoes empty (tmux quirk for bogus targets)", async () => {
    const { executor } = harness(() => ok("\n"));
    setTmuxExecutor(executor);
    expect(await paneExists("%15")).toBe(false);
  });

  it("false when display-message echoes a different pane id", async () => {
    const { executor } = harness(() => ok("%99\n"));
    setTmuxExecutor(executor);
    expect(await paneExists("%15")).toBe(false);
  });

  it("false (no tmux call) on invalid pane id", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    expect(await paneExists("garbage")).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("setPaneTitle", () => {
  it("invokes select-pane -T", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await setPaneTitle("%15", "alice");
    expect(calls[0]?.args).toEqual(["select-pane", "-t", "%15", "-T", "alice"]);
  });
});

describe("enableMuPaneBorders", () => {
  it("sets pane-border-status=top + format + heavy lines + active/inactive border styles as window options", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await enableMuPaneBorders("@42");
    expect(calls.length).toBe(5);
    // -w is critical: pane-border-status is a WINDOW option in tmux,
    // not a session option. Without -w, set-option on a session
    // target only updates the currently-active window; windows
    // created later inherit from the global default ('off').
    expect(calls[0]?.args).toEqual(["set-option", "-w", "-t", "@42", "pane-border-status", "top"]);
    expect(calls[1]?.args).toEqual([
      "set-option",
      "-w",
      "-t",
      "@42",
      "pane-border-format",
      " [mu] #{pane_title} ",
    ]);
    // Heavy box-drawing on bottom + sides so a mu pane is visually
    // distinct from a non-mu tmux window even when not focused.
    expect(calls[2]?.args).toEqual(["set-option", "-w", "-t", "@42", "pane-border-lines", "heavy"]);
    expect(calls[3]?.args).toEqual([
      "set-option",
      "-w",
      "-t",
      "@42",
      "pane-active-border-style",
      "fg=cyan,bold",
    ]);
    expect(calls[4]?.args).toEqual([
      "set-option",
      "-w",
      "-t",
      "@42",
      "pane-border-style",
      "fg=brightblack",
    ]);
  });
});

describe("selectLayout", () => {
  it("invokes select-layout", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await selectLayout(":Backend", "even-horizontal");
    expect(calls[0]?.args).toEqual(["select-layout", "-t", ":Backend", "even-horizontal"]);
  });
});

// ─── Send protocol (the canonical 5-step sequence) ────────────────────

describe("sendToPane", () => {
  it("emits the 5-step bracketed-paste sequence in order", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await sendToPane("%15", "hello world");

    expect(calls).toHaveLength(4);
    // 1. copy-mode -q
    expect(calls[0]?.args).toEqual(["copy-mode", "-q", "-t", "%15"]);
    // 2. set-buffer with unique name
    const [setBufferCmd, setBufferB, setBufferName, ...setBufferRest] = calls[1]?.args ?? [];
    expect(setBufferCmd).toBe("set-buffer");
    expect(setBufferB).toBe("-b");
    expect(setBufferName).toMatch(/^mu-send-\d+-\d+-\d+$/);
    expect(setBufferRest).toEqual(["hello world"]);
    // 3. paste-buffer with -p (bracketed) -d (delete) -r (preserve LF)
    const pasteArgs = calls[2]?.args ?? [];
    expect(pasteArgs[0]).toBe("paste-buffer");
    expect(pasteArgs).toContain("-p");
    expect(pasteArgs).toContain("-d");
    expect(pasteArgs).toContain("-r");
    expect(pasteArgs).toContain("-b");
    expect(pasteArgs).toContain(setBufferName);
    expect(pasteArgs).toContain("-t");
    expect(pasteArgs).toContain("%15");
    // 4. send-keys Enter
    expect(calls[3]?.args).toEqual(["send-keys", "-t", "%15", "Enter"]);
  });

  it("uses a unique buffer name per call", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await sendToPane("%15", "first");
    await sendToPane("%15", "second");
    const buf1 = calls[1]?.args[2];
    const buf2 = calls[5]?.args[2];
    expect(buf1).not.toBe(buf2);
  });

  it("waits the requested delay between paste and Enter", async () => {
    const { executor } = harness(() => ok());
    setTmuxExecutor(executor);
    let observedMs: number | undefined;
    setSleepForTests(async (ms) => {
      observedMs = ms;
    });
    await sendToPane("%15", "hi", { delayMs: 250 });
    expect(observedMs).toBe(250);
  });

  it("uses defaultSendDelayMs when delayMs not provided", async () => {
    const { executor } = harness(() => ok());
    setTmuxExecutor(executor);
    let observedMs: number | undefined;
    setSleepForTests(async (ms) => {
      observedMs = ms;
    });
    await sendToPane("%15", "hi");
    expect(observedMs).toBe(500);
  });

  it("skips sleep entirely when delayMs is 0", async () => {
    const { executor } = harness(() => ok());
    setTmuxExecutor(executor);
    let sleepCalled = false;
    setSleepForTests(async () => {
      sleepCalled = true;
    });
    await sendToPane("%15", "hi", { delayMs: 0 });
    expect(sleepCalled).toBe(false);
  });

  it("rejects invalid pane ids before any tmux call", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await expect(sendToPane("garbage", "hi")).rejects.toThrow(/invalid tmux pane id/);
    expect(calls).toEqual([]);
  });

  it("attempts buffer cleanup when paste fails", async () => {
    const { executor, calls } = harness((args) => {
      if (args[0] === "paste-buffer") return fail("paste failed");
      return ok();
    });
    setTmuxExecutor(executor);
    await expect(sendToPane("%15", "hi")).rejects.toBeInstanceOf(TmuxError);
    const deleteBufferCall = calls.find((c) => c.args[0] === "delete-buffer");
    expect(deleteBufferCall).toBeDefined();
  });

  it("preserves special characters literally in set-buffer arg", async () => {
    // The whole point: a string containing /, ?, !, $, etc. must be passed
    // verbatim to set-buffer so paste-buffer -p delivers it as literal text.
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    const tricky = "find / -name '*.rs' | xargs grep '?TODO' && echo $HOME!";
    await sendToPane("%15", tricky);
    const setBufferCall = calls.find((c) => c.args[0] === "set-buffer");
    expect(setBufferCall?.args[3]).toBe(tricky);
  });
});

// ─── Capture ───────────────────────────────────────────────────────────

describe("capturePane", () => {
  it("captures full scrollback by default (-S - -E -)", async () => {
    const { executor, calls } = harness(() => ok("scrollback contents"));
    setTmuxExecutor(executor);
    expect(await capturePane("%15")).toBe("scrollback contents");
    expect(calls[0]?.args).toEqual(["capture-pane", "-t", "%15", "-p", "-S", "-", "-E", "-"]);
  });

  it("captures last N lines when lines provided", async () => {
    const { executor, calls } = harness(() => ok("last 50"));
    setTmuxExecutor(executor);
    await capturePane("%15", { lines: 50 });
    expect(calls[0]?.args).toEqual(["capture-pane", "-t", "%15", "-p", "-S", "-50"]);
  });

  it("captures only visible pane when lines is 0", async () => {
    const { executor, calls } = harness(() => ok("visible"));
    setTmuxExecutor(executor);
    await capturePane("%15", { lines: 0 });
    expect(calls[0]?.args).toEqual(["capture-pane", "-t", "%15", "-p"]);
  });

  it("rejects invalid pane id before tmux call", async () => {
    const { executor, calls } = harness(() => ok());
    setTmuxExecutor(executor);
    await expect(capturePane("garbage")).rejects.toThrow(/invalid tmux pane id/);
    expect(calls).toEqual([]);
  });
});

// ─── parseAgentNameFromTitle (back-compat with adopted/legacy panes) ──

describe("parseAgentNameFromTitle", () => {
  it("returns the input unchanged when no ' · ' separator (adopted/legacy panes)", () => {
    expect(parseAgentNameFromTitle("worker-a")).toBe("worker-a");
    expect(parseAgentNameFromTitle("reviewer-1")).toBe("reviewer-1");
  });

  it("returns the first ' · '-separated token (composed titles)", () => {
    // Use the actual STATUS_EMOJI codepoints production emits, so this
    // test breaks loud if STATUS_EMOJI changes shape (any drift between
    // composeAgentTitle and parseAgentNameFromTitle is the bug we're
    // guarding against).
    expect(parseAgentNameFromTitle(`worker-a · ${STATUS_EMOJI.needs_input}`)).toBe("worker-a");
    expect(parseAgentNameFromTitle(`worker-a · ${STATUS_EMOJI.busy} · build_x`)).toBe("worker-a");
    expect(parseAgentNameFromTitle(`worker-a · ${STATUS_EMOJI.busy} · ⊕3 tasks`)).toBe("worker-a");
  });

  it("trims whitespace around the name token", () => {
    expect(parseAgentNameFromTitle("  worker-a  ")).toBe("worker-a");
    expect(parseAgentNameFromTitle(`  worker-a · ${STATUS_EMOJI.needs_input}  `)).toBe("worker-a");
  });
});
