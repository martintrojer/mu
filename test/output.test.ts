// Unit tests for src/output.ts — the self-documenting output helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type NextStep, hasNextSteps, isJsonMode, printNextSteps } from "../src/output.js";

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

  it("pads intent labels so colons align across steps", () => {
    const steps: NextStep[] = [
      { intent: "Short", command: "a" },
      { intent: "Much longer label", command: "b" },
    ];
    printNextSteps(steps);
    // The short label's line should contain the full long-label width
    // worth of leading whitespace before the colon.
    const shortLine = logs[1] ?? "";
    const longLine = logs[2] ?? "";
    // Both lines should contain the colon at roughly the same position
    // (modulo ANSI). Strip ANSI and verify.
    // ESC = String.fromCharCode(0x1b); the regex strips ANSI SGR sequences.
    const ESC = String.fromCharCode(0x1b);
    const ansiRe = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const stripAnsi = (s: string): string => s.replace(ansiRe, "");
    expect(stripAnsi(shortLine).indexOf(":")).toBe(stripAnsi(longLine).indexOf(":"));
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
