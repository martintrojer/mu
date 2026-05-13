import { describe, expect, it } from "vitest";
import { wrapAnsi, wrapAnsiLines } from "../src/cli/tui/wrap-ansi.js";

const ESC = "\u001B";
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const ANSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const SGR_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function sgrBalance(s: string): number {
  let balance = 0;
  for (const match of s.matchAll(SGR_RE)) {
    if (match[1] === "0" || match[1] === "") balance = 0;
    else balance += 1;
  }
  return balance;
}

describe("wrapAnsi", () => {
  it("wraps plain ASCII at visible width", () => {
    expect(wrapAnsi("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("wraps ANSI-decorated text by visible width, not byte length", () => {
    const line = `${RED}abcdef${RESET}`;
    const wrapped = wrapAnsi(line, 4);

    expect(wrapped.map(stripAnsi)).toEqual(["abcd", "ef"]);
    expect(wrapped).toEqual([`${RED}abcd${RESET}`, `${RED}ef${RESET}`]);
  });

  it("re-emits active SGR on continuation lines and resets emitted chunks", () => {
    const wrapped = wrapAnsi(`${RED}abcdef`, 3);

    expect(wrapped).toEqual([`${RED}abc${RESET}`, `${RED}def${RESET}`]);
  });

  it("handles multiple active SGR sequences", () => {
    const wrapped = wrapAnsi(`${BOLD}${GREEN}abcdef`, 3);

    expect(wrapped).toEqual([`${BOLD}${GREEN}abc${RESET}`, `${BOLD}${GREEN}def${RESET}`]);
  });

  it("passes through empty and whitespace-only lines that do not exceed width", () => {
    expect(wrapAnsi("", 4)).toEqual([""]);
    expect(wrapAnsi("   ", 4)).toEqual(["   "]);
  });

  it("wrapAnsiLines preserves existing line boundaries", () => {
    expect(wrapAnsiLines(`abcdef\n${GREEN}ghij${RESET}`, 3)).toBe(
      `abc\ndef\n${GREEN}ghi${RESET}\n${GREEN}j${RESET}`,
    );
  });

  it("does not leave emitted wrapped lines with active SGR state", () => {
    const wrapped = wrapAnsi(`${RED}abcdef${RESET}`, 2);

    expect(wrapped.every((line) => sgrBalance(line) === 0)).toBe(true);
  });
});
