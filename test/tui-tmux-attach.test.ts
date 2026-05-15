import { describe, expect, it } from "vitest";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "../src/cli/tui/escapes.js";
import { runTmuxAttachInteractive } from "../src/cli/tui/tmux-attach.js";

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

    const r = runTmuxAttachInteractive(
      { session: "mu-alpha", window: "worker-1" },
      {
        env,
        write: (text) => writes.push(text),
        spawn: (command, args, options) => {
          call = { command, args, options };
          return { status: 0 };
        },
      },
    );

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

    const r = runTmuxAttachInteractive(
      { session: "mu-alpha", window: "worker-1" },
      {
        env,
        write: (text) => writes.push(text),
        spawn: (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0 };
        },
      },
    );

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
    const r = runTmuxAttachInteractive(
      { session: "mu-a", window: "worker-1" },
      {
        env,
        write: (text) => writes.push(text),
        spawn: () => ({ status: null, error: enoent() }),
      },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toContain("tmux not found");
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  it("inside tmux: reports non-zero switch-client exit codes", () => {
    const writes: string[] = [];
    const env = { TMUX: "/tmp/x" } as NodeJS.ProcessEnv;
    const r = runTmuxAttachInteractive(
      { session: "mu-a", window: "worker-1" },
      {
        env,
        write: (text) => writes.push(text),
        spawn: () => ({ status: 1 }),
      },
    );

    expect(r).toEqual({ ok: false, error: "tmux switch-client exited 1" });
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  it("restores the alt screen when spawn throws", () => {
    const writes: string[] = [];
    const env = { TMUX: "/tmp/x" } as NodeJS.ProcessEnv;
    const r = runTmuxAttachInteractive(
      { session: "mu-a", window: "worker-1" },
      {
        env,
        write: (text) => writes.push(text),
        spawn: () => {
          throw new Error("boom");
        },
      },
    );

    expect(r).toEqual({ ok: false, error: "boom" });
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });
});
