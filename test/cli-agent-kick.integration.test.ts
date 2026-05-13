// Tests for `mu agent kick` and the underlying `kickAgent` SDK
// function (workers_commonly_attempt_unbounded_find).
//
// Two layers:
//
//   1. Unit (always-on; mocked tmux + mocked process executor):
//      cover the verb's branching — default SIGINT, --signal flag,
//      AgentNotFoundError, NoForegroundProcessError (no-foreground
//      AND shell-only), happy path emits an `agent kick` event,
//      pgid lookup parses ps's output correctly, kill(2) is called
//      with the negative-pgid form so the whole pgrp is signalled.
//
//   2. Integration (real tmux, skipped unless $TMUX): spawn a real
//      sleep loop in a real tmux pane, run `kickAgent` against it,
//      assert the sleep died. This is the closed-loop confirmation
//      that the "look up TTY -> ps -t -> kill -<pgid>" pipeline
//      actually interrupts a real wedged subprocess.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type KickProcessExecutor,
  NoForegroundProcessError,
  type AgentNotFoundError as _AgentNotFoundError,
  foregroundPgid,
  insertAgent,
  isKickSignal,
  kickAgent,
  parsePsTtyOutput,
  resetKickProcessExecutor,
  setKickProcessExecutor,
} from "../src/agents.js";
import { type Db, openDb } from "../src/db.js";
import { listLogs } from "../src/logs.js";
import {
  killSession,
  newSessionWithPane,
  paneExists,
  paneTTY,
  resetTmuxExecutor,
  setTmuxExecutor,
} from "../src/tmux.js";
import { ensureWorkstream } from "../src/workstream.js";
import { pollUntil } from "./_env.js";
import { freshWorkstream } from "./_fixture.js";

// ─── parsePsTtyOutput ─────────────────────────────────────────────────

describe("parsePsTtyOutput", () => {
  it("parses the BSD/Darwin layout (pid pgid stat comm)", () => {
    const out = `
 12345 12345 Ss   bash
 12380 12345 R+   find
 12381 12345 R+   sort
`;
    const rows = parsePsTtyOutput(out);
    expect(rows).toEqual([
      { pid: 12345, pgid: 12345, stat: "Ss", comm: "bash" },
      { pid: 12380, pgid: 12345, stat: "R+", comm: "find" },
      { pid: 12381, pgid: 12345, stat: "R+", comm: "sort" },
    ]);
  });

  it("ignores blank/garbage lines defensively", () => {
    const rows = parsePsTtyOutput("\n\n  \n12345 12345 R+ pi\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.comm).toBe("pi");
  });

  it("handles command names with spaces (joins the tail)", () => {
    const rows = parsePsTtyOutput("12345 12345 R+ python script.py\n");
    expect(rows[0]?.comm).toBe("python script.py");
  });
});

// ─── isKickSignal ─────────────────────────────────────────────────────

describe("isKickSignal", () => {
  it("accepts SIGINT, SIGTERM, SIGKILL", () => {
    expect(isKickSignal("SIGINT")).toBe(true);
    expect(isKickSignal("SIGTERM")).toBe(true);
    expect(isKickSignal("SIGKILL")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(isKickSignal("SIGHUP")).toBe(false);
    expect(isKickSignal("INT")).toBe(false);
    expect(isKickSignal("")).toBe(false);
    expect(isKickSignal("sigint")).toBe(false);
  });
});

// ─── foregroundPgid (mocked process executor) ─────────────────────────

describe("foregroundPgid", () => {
  beforeEach(() => {
    resetKickProcessExecutor();
  });
  afterEach(() => {
    resetKickProcessExecutor();
  });

  function mock(
    impl: (
      cmd: string,
      args: readonly string[],
    ) => {
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
    },
  ): { calls: Array<{ cmd: string; args: string[] }> } {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: KickProcessExecutor = async (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      const r = impl(cmd, [...args]);
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.exitCode ?? 0,
      };
    };
    setKickProcessExecutor(exec);
    return { calls };
  }

  it("strips /dev/ prefix when calling ps (procps wants short tty names)", async () => {
    const { calls } = mock(() => ({ stdout: "12345 12345 R+ find\n" }));
    await foregroundPgid("/dev/ttys012");
    expect(calls[0]?.cmd).toBe("ps");
    expect(calls[0]?.args).toEqual(["-t", "ttys012", "-o", "pid=,pgid=,stat=,comm="]);
  });

  it("returns ok with the foreground row when stat contains '+'", async () => {
    mock(() => ({
      stdout: "12345 12345 Ss bash\n12380 12345 R+ find\n",
    }));
    const r = await foregroundPgid("/dev/ttys1");
    expect(r.kind).toBe("ok");
    expect(r.pgid).toBe(12345);
    expect(r.fgRow?.comm).toBe("find");
  });

  it("returns no-foreground when ps exits 1 with empty stdout", async () => {
    mock(() => ({ exitCode: 1, stdout: "" }));
    const r = await foregroundPgid("/dev/ttys1");
    expect(r.kind).toBe("no-foreground");
  });

  it("returns no-foreground when no row carries '+'", async () => {
    mock(() => ({ stdout: "12345 12345 Ss bash\n" }));
    const r = await foregroundPgid("/dev/ttys1");
    expect(r.kind).toBe("no-foreground");
  });

  it("returns shell-only when the foreground comm matches a wrapping CLI (pi)", async () => {
    mock(() => ({ stdout: "12345 12345 Ss+ pi\n" }));
    const r = await foregroundPgid("/dev/ttys1");
    expect(r.kind).toBe("shell-only");
    expect(r.pgid).toBe(12345);
  });

  it("returns shell-only for pi-meta, claude, codex, bash, zsh", async () => {
    for (const comm of ["pi-meta", "claude", "codex", "bash", "zsh", "sh"]) {
      mock(() => ({ stdout: `12345 12345 Ss+ ${comm}\n` }));
      const r = await foregroundPgid("/dev/ttys1");
      expect(r.kind).toBe("shell-only");
    }
  });

  it("returns ok when foreground is `find` (the canonical kick target)", async () => {
    mock(() => ({ stdout: "12345 12345 R+ find\n" }));
    const r = await foregroundPgid("/dev/ttys1");
    expect(r.kind).toBe("ok");
  });
});

// ─── kickAgent (DB + mocked tmux + mocked process executor) ───────────

describe("kickAgent (unit)", () => {
  let tempDir: string;
  let db: Db;
  const ws = "kick-ws";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mu-kick-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    ensureWorkstream(db, ws);
    insertAgent(db, { name: "worker-1", workstream: ws, paneId: "%15", status: "busy" });
  });

  afterEach(() => {
    resetTmuxExecutor();
    resetKickProcessExecutor();
    try {
      db.close();
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  function mockTmuxReturnsTty(tty: string): void {
    setTmuxExecutor(async (args) => {
      // Only one tmux call expected: display-message -t %15 -p '#{pane_tty}'
      if (args[0] === "display-message") {
        return { stdout: `${tty}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    });
  }

  function mockProcExec(
    impl: (
      cmd: string,
      args: readonly string[],
    ) => {
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
    },
  ): Array<{ cmd: string; args: string[] }> {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    setKickProcessExecutor(async (cmd, args) => {
      calls.push({ cmd, args: [...args] });
      const r = impl(cmd, [...args]);
      return {
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.exitCode ?? 0,
      };
    });
    return calls;
  }

  it("happy path: SIGINT default, signals foreground pgid, emits event", async () => {
    mockTmuxReturnsTty("/dev/ttys012");
    const calls = mockProcExec((cmd) => {
      if (cmd === "ps") return { stdout: "12345 12345 R+ find\n" };
      if (cmd === "kill") return {};
      return { exitCode: 1 };
    });
    const result = await kickAgent(db, "worker-1", { workstream: ws });
    expect(result).toMatchObject({
      agentName: "worker-1",
      paneId: "%15",
      tty: "/dev/ttys012",
      signaledPgid: 12345,
      signal: "SIGINT",
      foregroundComm: "find",
    });
    // kill -SIGINT -12345 (negative pgid form for the whole pgrp).
    const killCall = calls.find((c) => c.cmd === "kill");
    expect(killCall?.args).toEqual(["-SIGINT", "-12345"]);
    // Activity-log event recorded.
    const events = listLogs(db, { workstream: ws, kind: "event" });
    expect(events.some((e) => e.payload.startsWith("agent kick worker-1"))).toBe(true);
    expect(events.some((e) => e.payload.includes("signal=SIGINT"))).toBe(true);
    expect(events.some((e) => e.payload.includes("pgid=12345"))).toBe(true);
  });

  it("--signal SIGTERM is honoured", async () => {
    mockTmuxReturnsTty("/dev/ttys012");
    const calls = mockProcExec((cmd) => {
      if (cmd === "ps") return { stdout: "777 777 R+ cargo\n" };
      return {};
    });
    const r = await kickAgent(db, "worker-1", { workstream: ws, signal: "SIGTERM" });
    expect(r.signal).toBe("SIGTERM");
    expect(calls.find((c) => c.cmd === "kill")?.args).toEqual(["-SIGTERM", "-777"]);
  });

  it("AgentNotFoundError when the agent doesn't exist in the workstream", async () => {
    await expect(kickAgent(db, "ghost", { workstream: ws })).rejects.toMatchObject({
      name: "AgentNotFoundError",
    });
  });

  it("NoForegroundProcessError (no-foreground) when ps returns no rows", async () => {
    mockTmuxReturnsTty("/dev/ttys012");
    mockProcExec(() => ({ exitCode: 1, stdout: "" }));
    await expect(kickAgent(db, "worker-1", { workstream: ws })).rejects.toBeInstanceOf(
      NoForegroundProcessError,
    );
  });

  it("NoForegroundProcessError (shell-only) when foreground is the wrapping CLI itself", async () => {
    mockTmuxReturnsTty("/dev/ttys012");
    mockProcExec((cmd) => {
      if (cmd === "ps") return { stdout: "55 55 Ss+ pi\n" };
      return {};
    });
    await expect(kickAgent(db, "worker-1", { workstream: ws })).rejects.toBeInstanceOf(
      NoForegroundProcessError,
    );
    // No event emitted on refusal.
    const events = listLogs(db, { workstream: ws, kind: "event" });
    expect(events.some((e) => e.payload.startsWith("agent kick"))).toBe(false);
  });

  it("benign 'No such process' from kill is swallowed (race: pgid completed between ps and kill)", async () => {
    mockTmuxReturnsTty("/dev/ttys012");
    mockProcExec((cmd) => {
      if (cmd === "ps") return { stdout: "12345 12345 R+ find\n" };
      if (cmd === "kill") return { exitCode: 1, stderr: "kill: No such process" };
      return {};
    });
    // Should NOT throw.
    const r = await kickAgent(db, "worker-1", { workstream: ws });
    expect(r.signaledPgid).toBe(12345);
  });
});

// ─── Integration: real tmux pane + real kill(2) ────────────────────────

const TMUX_AVAILABLE = process.env.TMUX !== undefined && process.env.TMUX !== "";
const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

describeIfTmux("kickAgent integration (real tmux + real ps + real kill)", () => {
  let tempDir: string;
  let db: Db;
  let session: string;
  let ws: string;

  beforeEach(() => {
    resetTmuxExecutor();
    resetKickProcessExecutor();
    // No spawn liveness check fires: we're not using spawnAgent here,
    // we're calling newSessionWithPane directly + insertAgent.
    tempDir = mkdtempSync(join(tmpdir(), "mu-kick-int-"));
    db = openDb({ path: join(tempDir, "mu.db") });
    // Per-run unique workstream + matching session keep two `npm test`
    // runs from colliding on the user's shared tmux server.
    ws = freshWorkstream("kick");
    ensureWorkstream(db, ws);
    session = `mu-${ws}`;
  });

  afterEach(async () => {
    resetTmuxExecutor();
    resetKickProcessExecutor();
    try {
      db.close();
    } catch {}
    try {
      await killSession(session);
    } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("SIGINT on a running `sleep` loop kills the sleep (foreground tool, not the shell)", async () => {
    // Spawn a pane whose foreground process (after the bash exec) is
    // the `sleep` itself. `exec sleep ...` replaces bash so the
    // foreground IS sleep, not bash — i.e. NOT the wrapping shell,
    // so our shell-only guard doesn't fire and we can verify the
    // kill actually lands.
    //
    // The sleep duration is per-test-unique so the `ps` sanity sweep
    // doesn't observe a peer test (or a parallel `npm test` run on
    // the same dev box) running its own `sleep 600`. The original
    // hardcoded "600" was the canonical Layer-1 leak: under parallel
    // runs the assertion `not.toMatch(/sleep 600/)` saw the OTHER
    // process's still-running sleep and failed.
    const sleepArg = `${600 + (process.pid % 1000)}.${Math.floor(Math.random() * 1e6)}`;
    const paneId = await newSessionWithPane(session, {
      windowName: "main",
      command: `bash -c 'exec sleep ${sleepArg}'`,
    });
    insertAgent(db, { name: "worker-1", workstream: ws, paneId, status: "busy" });

    // Wait for the pane AND for `sleep` to actually be the foreground
    // process. paneExists alone is not enough — tmux creates the pane
    // before bash has exec'd into sleep, so kickAgent can race ahead
    // and observe bash itself in the foreground (the wrapping CLI),
    // which it correctly refuses to signal.
    await pollUntil(
      async () => {
        if (!(await paneExists(paneId))) return false;
        const tty = await paneTTY(paneId);
        const fg = await foregroundPgid(tty);
        return fg.kind === "ok" && fg.fgRow?.comm.includes("sleep") === true;
      },
      { description: "sleep is foreground before kick" },
    );

    // Kick. SIGINT on a `sleep` exits it (sleep doesn't trap SIGINT).
    const result = await kickAgent(db, "worker-1", { workstream: ws });
    expect(result.signal).toBe("SIGINT");
    expect(result.foregroundComm).toContain("sleep");

    // The pane closes once the foreground process exits (we used
    // `exec sleep`, so sleep IS the only process in the pane).
    await pollUntil(async () => !(await paneExists(paneId)), {
      description: "kicked sleep pane disappears",
    });
    expect(await paneExists(paneId)).toBe(false);

    // Sanity: no stray `sleep <our-arg>` is left running. Per-test
    // unique duration above is what makes this safe under parallel
    // `npm test` runs on the same machine.
    const ps = await execa("ps", ["-axo", "comm,args"], { reject: false });
    const re = new RegExp(`sleep ${sleepArg.replace(/\./g, "\\.")}`);
    expect(ps.stdout).not.toMatch(re);
  });

  it("refuses (NoForegroundProcessError shell-only) when the foreground is bash itself", async () => {
    // Pane runs an idle bash; foreground IS the wrapping shell
    // (one of WRAPPER_COMM_PREFIXES). kickAgent must refuse.
    const paneId = await newSessionWithPane(session, {
      windowName: "main",
      command: "bash --norc --noprofile",
    });
    insertAgent(db, { name: "worker-1", workstream: ws, paneId, status: "busy" });
    await pollUntil(() => paneExists(paneId), {
      description: "idle bash pane exists before kick refusal",
    });

    await expect(kickAgent(db, "worker-1", { workstream: ws })).rejects.toBeInstanceOf(
      NoForegroundProcessError,
    );
  });
});

if (!TMUX_AVAILABLE) {
  describe("kickAgent integration", () => {
    it.skip("skipped — set $TMUX (run inside tmux) to enable", () => {});
  });
}
