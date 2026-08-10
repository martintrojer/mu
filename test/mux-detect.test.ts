// Detection ladder for the mux backend: MU_MUX → ambient signal →
// availability → throw.
//
// These tests drive `detectMux()` rather than `activeMux()` because the
// latter memoizes per process; `activeMux` gets its own test below with
// an explicit reset.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activeMux,
  detectMux,
  type MuxBackend,
  muxByName,
  NoMultiplexerError,
  resetMux,
  setMuxForTests,
  tmuxBackend,
} from "../src/mux.js";
import { resetTmuxExecutor, setTmuxExecutor } from "../src/tmux.js";

const MU_MUX = "MU_MUX";
const TMUX = "TMUX";

/** Make `tmux -V` (and everything else) fail, so tmuxBackend.available()
 *  reports false without touching a real tmux server. */
function makeTmuxUnavailable(): void {
  setTmuxExecutor(async () => ({ stdout: "", stderr: "no server", exitCode: 1 }));
}

/** Make `tmux -V` succeed. */
function makeTmuxAvailable(): void {
  setTmuxExecutor(async () => ({ stdout: "tmux 3.4", stderr: "", exitCode: 0 }));
}

describe("detectMux", () => {
  beforeEach(() => {
    delete process.env[MU_MUX];
    delete process.env[TMUX];
    resetMux();
  });

  afterEach(() => {
    delete process.env[MU_MUX];
    delete process.env[TMUX];
    resetTmuxExecutor();
    resetMux();
  });

  it("MU_MUX overrides everything, including a hostile environment", async () => {
    // No $TMUX, and tmux -V fails: without the override this would throw.
    makeTmuxUnavailable();
    process.env[MU_MUX] = "tmux";
    expect((await detectMux()).name).toBe("tmux");
  });

  it("an unknown MU_MUX value throws instead of falling through", async () => {
    // A typo'd backend name must fail loud. Silently running on tmux
    // would make `MU_MUX=herdrr mu ...` look like it worked.
    process.env[MU_MUX] = "nope";
    await expect(detectMux()).rejects.toThrow(/unknown mux backend: nope/);
  });

  it("an empty MU_MUX is ignored, not treated as a backend name", async () => {
    // `MU_MUX= mu ...` in a shell script should behave like unset.
    process.env[MU_MUX] = "";
    process.env[TMUX] = "/tmp/tmux-1000/default,1,0";
    expect((await detectMux()).name).toBe("tmux");
  });

  it("$TMUX selects tmux without shelling out to check availability", async () => {
    // Caller is already inside a tmux pane; the ambient signal is
    // conclusive, so no `tmux -V` probe should be needed. Prove it by
    // making every tmux call fail.
    makeTmuxUnavailable();
    process.env[TMUX] = "/tmp/tmux-1000/default,1,0";
    expect((await detectMux()).name).toBe("tmux");
  });

  it("falls back to availability when no ambient signal is present", async () => {
    // A plain shell outside any pane: mu can still create a detached
    // session, so a working tmux binary is enough.
    makeTmuxAvailable();
    expect((await detectMux()).name).toBe("tmux");
  });

  it("throws NoMultiplexerError when nothing is available", async () => {
    makeTmuxUnavailable();
    await expect(detectMux()).rejects.toBeInstanceOf(NoMultiplexerError);
  });

  it("NoMultiplexerError names what it tried, so the message is actionable", async () => {
    makeTmuxUnavailable();
    await expect(detectMux()).rejects.toThrow(/tried: tmux/);
  });
});

describe("muxByName", () => {
  it("resolves a known backend", () => {
    expect(muxByName("tmux")).toBe(tmuxBackend);
  });

  it("throws on an unknown backend", () => {
    // Cast: the point is to guard the RUNTIME path, which is reachable
    // from the MU_MUX env var and therefore not protected by the type.
    expect(() => muxByName("zellij" as "tmux")).toThrow(/unknown mux backend/);
  });
});

describe("activeMux memoization", () => {
  afterEach(() => {
    delete process.env[TMUX];
    resetTmuxExecutor();
    resetMux();
  });

  it("detects once and reuses the result", async () => {
    let probes = 0;
    setTmuxExecutor(async () => {
      probes += 1;
      return { stdout: "tmux 3.4", stderr: "", exitCode: 0 };
    });
    delete process.env[TMUX];
    resetMux();

    const first = await activeMux();
    const second = await activeMux();

    expect(second).toBe(first);
    // One `tmux -V` for the first call, none for the second.
    expect(probes).toBe(1);
  });

  it("resetMux forces re-detection", async () => {
    makeTmuxAvailable();
    delete process.env[TMUX];
    resetMux();

    await activeMux();
    resetMux();
    // If the cache had survived, a now-unavailable tmux would still
    // resolve; it must throw instead.
    makeTmuxUnavailable();
    await expect(activeMux()).rejects.toBeInstanceOf(NoMultiplexerError);
  });

  it("setMuxForTests installs a backend and returns the previous one", async () => {
    resetMux();
    const fake = { ...tmuxBackend, name: "tmux" } as MuxBackend;
    const previous = setMuxForTests(fake);
    expect(await activeMux()).toBe(fake);
    setMuxForTests(previous);
  });
});

describe("tmuxBackend conforms to the MuxBackend contract", () => {
  afterEach(() => {
    resetTmuxExecutor();
  });

  it("owns pane-id validation, so no global regex is needed", () => {
    // The whole point of Q2: shape is the BACKEND's business. tmux ids
    // are %N; a herdr-style id must not validate here.
    expect(tmuxBackend.isValidPaneId("%15")).toBe(true);
    expect(tmuxBackend.isValidPaneId("w1:p1")).toBe(false);
    expect(tmuxBackend.isValidPaneId("0")).toBe(false);
  });

  it("available() reports false when the binary cannot run", async () => {
    makeTmuxUnavailable();
    expect(await tmuxBackend.available()).toBe(false);
  });

  it("available() reports true when tmux -V succeeds", async () => {
    makeTmuxAvailable();
    expect(await tmuxBackend.available()).toBe(true);
  });
});
