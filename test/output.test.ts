// Unit tests for src/output.ts — the self-documenting output helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type NextStep,
  colorEnabled,
  hasNextSteps,
  isJsonMode,
  muTable,
  printNextSteps,
  printNextStepsTo,
} from "../src/output.js";

// `colorEnabled()` reads every signal it cares about straight from
// `process.env` / `process.stdout` at call time (per task
// review_test_color_enabled_no_color_module_load_caveat — it used to
// AND with picocolors.isColorSupported, which bakes its env inspection
// at picocolors-load time and made the NO_COLOR test branch effectively
// constant). Now we can flip env vars in-process and observe the result
// directly — no vi.resetModules + vi.doMock dance required.
//
// Helper: snapshot, mutate, run, restore. The four env vars colorEnabled
// inspects are wiped unconditionally; only the ones the caller passes
// are reapplied. AGENTS.md mandates the computed-key delete form
// because biome's --unsafe rewrite has historically turned `delete
// process.env.X` into `process.env.X = undefined` (which silently
// produces the literal string "undefined").
function withEnv(
  env: { TMUX?: string; FORCE_COLOR?: string; MU_FORCE_COLOR?: string; NO_COLOR?: string },
  isTTY: boolean,
  body: () => void,
): void {
  const keys = ["TMUX", "FORCE_COLOR", "MU_FORCE_COLOR", "NO_COLOR", "TERM"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    const key = k;
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // TERM defaults to a non-dumb value so the TTY-fallback branch is
  // sensitive to isTTY alone unless a test sets TERM=dumb itself.
  process.env.TERM = "xterm-256color";
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  const savedIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTTY,
    configurable: true,
    writable: true,
  });
  try {
    body();
  } finally {
    Object.defineProperty(process.stdout, "isTTY", {
      value: savedIsTTY,
      configurable: true,
      writable: true,
    });
    for (const k of keys) {
      const key = k;
      delete process.env[key];
      if (saved[key] !== undefined) process.env[key] = saved[key];
    }
  }
}

describe("colorEnabled (env-var matrix + isTTY fallback)", () => {
  it("returns false when no env vars are set and isTTY is false", () => {
    withEnv({}, false, () => expect(colorEnabled()).toBe(false));
  });

  it("returns true when TMUX is set (the load-bearing fix for `watch` inside tmux)", () => {
    withEnv({ TMUX: "/tmp/tmux-1000/default,12345,0" }, false, () =>
      expect(colorEnabled()).toBe(true),
    );
  });

  it("returns true when MU_FORCE_COLOR=1", () => {
    withEnv({ MU_FORCE_COLOR: "1" }, false, () => expect(colorEnabled()).toBe(true));
  });

  it("returns false when MU_FORCE_COLOR=0", () => {
    withEnv({ MU_FORCE_COLOR: "0" }, false, () => expect(colorEnabled()).toBe(false));
  });

  it("returns true when FORCE_COLOR=1", () => {
    withEnv({ FORCE_COLOR: "1" }, false, () => expect(colorEnabled()).toBe(true));
  });

  it("returns false when FORCE_COLOR=0", () => {
    withEnv({ FORCE_COLOR: "0" }, false, () => expect(colorEnabled()).toBe(false));
  });

  it('returns true when FORCE_COLOR=1 even if MU_FORCE_COLOR=""', () => {
    withEnv({ MU_FORCE_COLOR: "", FORCE_COLOR: "1" }, false, () =>
      expect(colorEnabled()).toBe(true),
    );
  });

  it("returns true when no env vars are set but stdout.isTTY is true (TTY fallback)", () => {
    withEnv({}, true, () => expect(colorEnabled()).toBe(true));
  });

  it("returns false when isTTY is true but TERM=dumb (dumb terminal heuristic)", () => {
    withEnv({}, true, () => {
      process.env.TERM = "dumb";
      expect(colorEnabled()).toBe(false);
    });
  });

  it("returns false when NO_COLOR is set even with TMUX + FORCE_COLOR + isTTY=true (NO_COLOR trumps)", () => {
    // The standard cross-tool opt-out (https://no-color.org/) wins over
    // every positive signal. We honor NO_COLOR explicitly so the TMUX
    // / FORCE_COLOR / isTTY clauses cannot override the user's opt-out.
    withEnv(
      { NO_COLOR: "1", TMUX: "/tmp/tmux/0", FORCE_COLOR: "1", MU_FORCE_COLOR: "1" },
      true,
      () => expect(colorEnabled()).toBe(false),
    );
  });

  it('treats NO_COLOR="" as set (matches https://no-color.org and picocolors)', () => {
    // Empty-string NO_COLOR still trips the opt-out. This pins the
    // `!== undefined` semantics so a future tightening to
    // `!== undefined && !== ""` (chalk's older behavior) can't slip
    // in unnoticed.
    withEnv({ NO_COLOR: "", FORCE_COLOR: "1" }, true, () => expect(colorEnabled()).toBe(false));
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

describe("muTable (cli-table3 wrapper with the mu-standard truncation safety belt)", () => {
  // Strip ANSI escape sequences so width assertions are decoupled from
  // colorEnabled() (mirror the helper in the printNextSteps padding
  // test above).
  const ESC = String.fromCharCode(0x1b);
  const ansiRe = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
  const stripAnsi = (s: string): string => s.replace(ansiRe, "");

  it("truncates a cell longer than its colWidth with an ellipsis (no wrap to a 2nd row)", () => {
    // Pin the load-bearing contract: a long cell becomes one truncated
    // visual row, NOT two wrapped rows. wordWrap:false + colWidths is
    // what cli-table3 needs to do this; the rest of the codebase relies
    // on it (e.g. fixed-row state renderers would silently blow out
    // under word-wrap). Surfaced live by `mu workspace list` blowing the
    // terminal width on the path column
    // (tables_truncate_long_cols_audit).
    const t = muTable({
      head: ["a", "b"],
      colWidths: [null, 10],
    });
    t.push(["x", "abcdefghijklmnopqrstuvwxyz"]);
    const out = stripAnsi(t.toString());
    // Exactly one ellipsis; the wrapped-to-2-rows regression would
    // produce zero (and the row count below would jump from 3 to 4).
    expect(out).toContain("…");
    // 5 lines for a 1-row table with a header (top border, header,
    // separator, data row, bottom border). A wrap to a 2-row data
    // cell would push it to 6.
    expect(out.split("\n").length).toBe(5);
  });

  it("omits colWidths entirely when caller passes none (column-width auto, wrap-safety belt still on)", () => {
    // No colWidths means cli-table3 sizes columns to fit; wordWrap:false
    // still applies so the safety belt holds even on auto-sized
    // columns. We just assert the table renders and contains the data
    // (no "colWidths required" runtime guard regressed in).
    const t = muTable({ head: ["a", "b"] });
    t.push(["hello", "world"]);
    expect(stripAnsi(t.toString())).toContain("hello");
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
