import { describe, expect, it } from "vitest";
import { ALT_SCREEN_ENTER, ALT_SCREEN_EXIT } from "../src/cli/tui/escapes.js";
import { runLazygitInteractive } from "../src/cli/tui/lazygit.js";

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv };
}

function enoent(): Error {
  const e = new Error("spawnSync lazygit ENOENT") as NodeJS.ErrnoException;
  e.code = "ENOENT";
  return e;
}

describe("runLazygitInteractive", () => {
  it("runs `lazygit` in the requested cwd and restores the alt screen on success", () => {
    const writes: string[] = [];
    let call: SpawnCall | null = null;
    const env = { PATH: "/test/bin" } as NodeJS.ProcessEnv;

    const r = runLazygitInteractive(
      { cwd: "/tmp/repo" },
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
      command: "lazygit",
      args: [],
      options: { cwd: "/tmp/repo", stdio: "inherit", env },
    });
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  it("converts ENOENT into an install hint and still restores the alt screen", () => {
    const writes: string[] = [];
    const r = runLazygitInteractive(
      { cwd: "/tmp/repo" },
      {
        write: (text) => writes.push(text),
        spawn: () => ({ status: null, error: enoent() }),
      },
    );

    expect(r.ok).toBe(false);
    expect(r.error).toContain("lazygit not found");
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  it("reports non-zero exit statuses", () => {
    const writes: string[] = [];
    const r = runLazygitInteractive(
      { cwd: "/tmp/repo" },
      {
        write: (text) => writes.push(text),
        spawn: () => ({ status: 17 }),
      },
    );

    expect(r).toEqual({ ok: false, error: "lazygit exited 17" });
    expect(writes).toEqual([ALT_SCREEN_EXIT, ALT_SCREEN_ENTER]);
  });

  it("restores the alt screen when spawn throws", () => {
    const writes: string[] = [];
    const r = runLazygitInteractive(
      { cwd: "/tmp/repo" },
      {
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
