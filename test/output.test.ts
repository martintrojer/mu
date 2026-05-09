// Unit tests for src/output.ts — the self-documenting output helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type NextStep,
  hasNextSteps,
  isJsonMode,
  printNextSteps,
  printNextStepsTo,
} from "../src/output.js";

// `colorEnabled()` reads `isColorSupported` from picocolors (module-level
// constant baked at picocolors-import time) plus three env vars at call
// time. To test the matrix deterministically without depending on the
// vitest runner's TTY/CI state, we re-import `src/output.ts` per case
// after `vi.doMock`-ing picocolors with the desired `isColorSupported`
// and clearing env vars via the computed-key delete form (per AGENTS.md).
async function loadColorEnabledWith(opts: {
  isColorSupported: boolean;
  env: { TMUX?: string; FORCE_COLOR?: string; MU_FORCE_COLOR?: string };
}): Promise<() => boolean> {
  // Wipe the three env vars unconditionally; only reapply the ones the
  // caller asked for. AGENTS.md mandates the computed-key form because
  // biome's --unsafe rewrite has historically turned `delete
  // process.env.X` into `process.env.X = undefined` (which silently
  // produces the literal string "undefined").
  for (const k of ["TMUX", "FORCE_COLOR", "MU_FORCE_COLOR", "NO_COLOR"] as const) {
    const key = k;
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(opts.env)) {
    if (v !== undefined) process.env[k] = v;
  }
  vi.resetModules();
  vi.doMock("picocolors", async () => {
    // picocolors is CJS (`export = picocolors`); src/output.ts uses
    // `import picocolors from "picocolors"` so the *default export*
    // must carry isColorSupported. We rebuild the default to spread
    // the real module's surface plus our overridden flag.
    const actual = await vi.importActual<{ default: typeof import("picocolors") }>("picocolors");
    const real = actual.default;
    return { default: { ...real, isColorSupported: opts.isColorSupported } };
  });
  const mod = await import("../src/output.js");
  return mod.colorEnabled;
}

describe("colorEnabled (env-var matrix + isTTY delegation)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.doUnmock("picocolors");
    vi.resetModules();
    // Restore any env vars the test mutated.
    for (const k of ["TMUX", "FORCE_COLOR", "MU_FORCE_COLOR", "NO_COLOR"] as const) {
      const key = k;
      delete process.env[key];
      if (originalEnv[key] !== undefined) process.env[key] = originalEnv[key];
    }
  });

  it("returns false when no env vars are set and isTTY is false", async () => {
    const colorEnabled = await loadColorEnabledWith({ isColorSupported: false, env: {} });
    expect(colorEnabled()).toBe(false);
  });

  it("returns true when TMUX is set (the load-bearing fix for `watch` inside tmux)", async () => {
    const colorEnabled = await loadColorEnabledWith({
      isColorSupported: false,
      env: { TMUX: "/tmp/tmux-1000/default,12345,0" },
    });
    expect(colorEnabled()).toBe(true);
  });

  it("returns true when MU_FORCE_COLOR=1", async () => {
    const colorEnabled = await loadColorEnabledWith({
      isColorSupported: false,
      env: { MU_FORCE_COLOR: "1" },
    });
    expect(colorEnabled()).toBe(true);
  });

  it("returns true when FORCE_COLOR=1", async () => {
    const colorEnabled = await loadColorEnabledWith({
      isColorSupported: false,
      env: { FORCE_COLOR: "1" },
    });
    expect(colorEnabled()).toBe(true);
  });

  it("returns true when no env vars are set but picocolors' isColorSupported is true (TTY path)", async () => {
    const colorEnabled = await loadColorEnabledWith({ isColorSupported: true, env: {} });
    expect(colorEnabled()).toBe(true);
  });

  it("returns false when NO_COLOR is set even with TMUX + FORCE_COLOR + isTTY=true (NO_COLOR trumps)", async () => {
    // The standard cross-tool opt-out (https://no-color.org/) wins over
    // every positive signal. Without this guard the TMUX clause would
    // override picocolors' own NO_COLOR check and surprise users.
    const colorEnabled = await loadColorEnabledWith({
      isColorSupported: true,
      env: { NO_COLOR: "1", TMUX: "/tmp/tmux/0", FORCE_COLOR: "1", MU_FORCE_COLOR: "1" },
    });
    expect(colorEnabled()).toBe(false);
  });
});

describe("printNextSteps", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((msg: string) => {
      logs.push(msg);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits nothing for an empty array (no 'Next:' header without steps)", () => {
    printNextSteps([]);
    expect(logs).toEqual([]);
  });

  it("emits a 'Next:' header followed by one line per step", () => {
    printNextSteps([
      { intent: "Show", command: "mu task show foo" },
      { intent: "Close", command: "mu task close foo" },
    ]);
    // Lines are dimmed via picocolors; assert the substrings are present
    // rather than the exact ANSI sequence (which depends on isTTY).
    expect(logs.length).toBe(3); // header + 2 steps
    expect(logs[0]).toContain("Next:");
    expect(logs[1]).toContain("Show");
    expect(logs[1]).toContain("mu task show foo");
    expect(logs[2]).toContain("Close");
    expect(logs[2]).toContain("mu task close foo");
  });

  it("printNextStepsTo('stderr') routes to console.error, NOT console.log", () => {
    // Pin the sink discrimination in src/output.ts:
    //   const out = sink === "stderr" ? console.error : console.log;
    // A regression that flipped the conditional (e.g. a refactor that
    // dropped the sink param) would silently send error nextSteps to
    // stdout, breaking `mu ... 2>err >ignored` redirection contracts
    // — every typed-error nextSteps emission would regress with the
    // suite still green. See task
    // review_test_print_next_steps_stderr_branch_uncovered.
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      errs.push(msg);
    });
    try {
      printNextStepsTo([{ intent: "X", command: "y" }], "stderr");
      // stderr branch fires: header + 1 step. logs[] (stdout spy from
      // beforeEach) stays empty — pinning that the conditional did NOT
      // fall through to the stdout sink.
      expect(errs.length).toBe(2);
      expect(errs[0]).toContain("Next:");
      expect(errs[1]).toContain("X");
      expect(errs[1]).toContain("y");
      expect(logs).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("pads short labels with spaces to the longest label's width before the colon", () => {
    const steps: NextStep[] = [
      { intent: "Short", command: "a" },
      { intent: "Much longer label", command: "b" },
    ];
    printNextSteps(steps);
    const ESC = String.fromCharCode(0x1b);
    const ansiRe = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const stripAnsi = (s: string): string => s.replace(ansiRe, "");
    // Assert the literal padding pattern — stronger than the previous
    // 'colon positions match' check (which would still pass on broken
    // padding semantics like double-padding or tab-padding). Long label
    // is 17 chars, short is 5; padding is 12 spaces. Caught by
    // review_test_output_padding_implementation_test.
    expect(stripAnsi(logs[1] ?? "")).toBe("  Short             : a");
    expect(stripAnsi(logs[2] ?? "")).toBe("  Much longer label : b");
  });
});

describe("hasNextSteps (duck-type guard for typed errors)", () => {
  it("returns true for objects with errorNextSteps()", () => {
    const fakeErr = {
      errorNextSteps(): NextStep[] {
        return [{ intent: "x", command: "y" }];
      },
    };
    expect(hasNextSteps(fakeErr)).toBe(true);
  });

  it("returns false for plain Errors / null / non-objects", () => {
    expect(hasNextSteps(new Error("boom"))).toBe(false);
    expect(hasNextSteps(null)).toBe(false);
    expect(hasNextSteps("string")).toBe(false);
    expect(hasNextSteps(42)).toBe(false);
    expect(hasNextSteps({})).toBe(false);
  });

  it("returns false when errorNextSteps exists but isn't a function", () => {
    expect(hasNextSteps({ errorNextSteps: "not a function" })).toBe(false);
  });
});

describe("isJsonMode (detects --json on the invocation)", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("returns true when --json is in argv", () => {
    process.argv = ["node", "mu", "task", "list", "--json"];
    expect(isJsonMode()).toBe(true);
  });

  it("returns true for --json=value form (commander tolerates both)", () => {
    process.argv = ["node", "mu", "task", "list", "--json=true"];
    expect(isJsonMode()).toBe(true);
  });

  it("returns false when --json is absent", () => {
    process.argv = ["node", "mu", "task", "list"];
    expect(isJsonMode()).toBe(false);
  });

  it("returns false when only a substring matches (--json-in-name)", () => {
    process.argv = ["node", "mu", "task", "add", "--title", "this--json-thing"];
    expect(isJsonMode()).toBe(false);
  });
});
