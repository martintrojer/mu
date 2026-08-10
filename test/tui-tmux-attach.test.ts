import { describe, expect, it } from "vitest";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "../src/cli/tui/escapes.js";
import { resolveAttachCommands, runTmuxAttachInteractive } from "../src/cli/tui/tmux-attach.js";
import { setMuxForTests, tmuxBackend } from "../src/mux.js";

// The attach STEPS are the backend's; this module only runs them. Tests
// therefore resolve real tmux-backend steps (pure — no subprocess) and
// inject them, so a regression in either half fails here.
const inside = (session: string, window: string) =>
  tmuxBackend.attachCommands({ session, window, inside: true });
const outside = (session: string, window: string) =>
  tmuxBackend.attachCommands({ session, window });

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv };
}

function enoent(): Error {
  const e = new Error("spawnSync tmux ENOENT") as NodeJS.ErrnoException;
  e.code = "ENOENT";
  return e;
}

describe("runTmuxAttachInteractive", () => {
  it("inside tmux: uses `tmux switch-client -t session:window` and restores the alt screen", () => {
    const writes: string[] = [];
    let call: SpawnCall | null = null;
    const env = { TMUX: "/tmp/tmux-1000/default,1234,0", PATH: "/test/bin" } as NodeJS.ProcessEnv;

    const r = runTmuxAttachInteractive({
      env,
      commands: inside("mu-alpha", "worker-1"),
      write: (text) => writes.push(text),
      spawn: (command, args, options) => {
        call = { command, args, options };
        return { status: 0 };
      },
    });

    expect(r).toEqual({ ok: true });
    expect(call).toEqual({
      command: "tmux",
      args: ["switch-client", "-t", "mu-alpha:worker-1"],
      options: { stdio: "inherit", env },
    });
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  it("outside tmux: attach-session then select-window", () => {
    const writes: string[] = [];
    const calls: SpawnCall[] = [];
    const env = { PATH: "/test/bin" } as NodeJS.ProcessEnv;

    const r = runTmuxAttachInteractive({
      env,
      commands: outside("mu-alpha", "worker-1"),
      write: (text) => writes.push(text),
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    });

    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      command: "tmux",
      args: ["attach-session", "-t", "mu-alpha"],
      options: { stdio: "inherit", env },
    });
    expect(calls[1]).toEqual({
      command: "tmux",
      args: ["select-window", "-t", "mu-alpha:worker-1"],
      options: { stdio: "inherit", env },
    });
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  it("converts ENOENT into an install hint and still restores the alt screen", () => {
    const writes: string[] = [];
    const env = { TMUX: "/tmp/x" } as NodeJS.ProcessEnv;
    const r = runTmuxAttachInteractive({
      env,
      commands: inside("mu-a", "worker-1"),
      write: (text) => writes.push(text),
      spawn: () => ({ status: null, error: enoent() }),
    });

    expect(r.ok).toBe(false);
    expect(r.error).toContain("multiplexer binary not found");
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  it("inside tmux: reports non-zero switch-client exit codes", () => {
    const writes: string[] = [];
    const env = { TMUX: "/tmp/x" } as NodeJS.ProcessEnv;
    const r = runTmuxAttachInteractive({
      env,
      commands: inside("mu-a", "worker-1"),
      write: (text) => writes.push(text),
      spawn: () => ({ status: 1 }),
    });

    expect(r).toEqual({ ok: false, error: "tmux switch-client exited 1" });
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  // The whole point of the migration: this module must not name tmux.
  it("with no resolvable mux, reports an error instead of shelling out", () => {
    const writes: string[] = [];
    let spawned = false;
    const r = runTmuxAttachInteractive({
      env: {} as NodeJS.ProcessEnv,
      commands: [],
      write: (text) => writes.push(text),
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
    });

    expect(r.ok).toBe(false);
    expect(spawned).toBe(false);
    expect(writes).toEqual([]);
  });

  it("restores the alt screen when spawn throws", () => {
    const writes: string[] = [];
    const env = { TMUX: "/tmp/x" } as NodeJS.ProcessEnv;
    const r = runTmuxAttachInteractive({
      env,
      commands: inside("mu-a", "worker-1"),
      write: (text) => writes.push(text),
      spawn: () => {
        throw new Error("boom");
      },
    });

    expect(r).toEqual({ ok: false, error: "boom" });
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  it("resolveAttachCommands picks switch-client from $TMUX and attach otherwise", async () => {
    const previous = setMuxForTests(tmuxBackend);
    try {
      const insideCmds = await resolveAttachCommands({ session: "mu-a", window: "w1" }, {
        TMUX: "/tmp/x",
      } as NodeJS.ProcessEnv);
      expect(insideCmds?.[0]?.args[0]).toBe("switch-client");
      const outsideCmds = await resolveAttachCommands(
        { session: "mu-a", window: "w1" },
        {} as NodeJS.ProcessEnv,
      );
      expect(outsideCmds?.[0]?.args[0]).toBe("attach-session");
    } finally {
      setMuxForTests(previous);
    }
  });
});
