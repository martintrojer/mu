import { Box, Text, render } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, describe, expect, it } from "vitest";
import {
  padAnsiLine,
  wrapAndPadAnsiLines,
  wrapAnsi,
  wrapAnsiLines,
} from "../src/cli/tui/wrap-ansi.js";
import { CaptureStream, collectRenderedLines, createInkCaptureStream } from "./_ink-render.js";

const ESC = "\u001B";
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const CYAN = `${ESC}[36m`;
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
  afterEach(() => {
    CaptureStream.cleanup();
  });

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

  it("padAnsiLine pads a short ANSI line to visible width with plain spaces", () => {
    const padded = padAnsiLine(`${GREEN}ok${RESET}`, 5);

    expect(padded).toBe(`${GREEN}ok${RESET}   `);
    expect(stringWidth(padded)).toBe(5);
    expect(sgrBalance(padded)).toBe(0);
  });

  it("padAnsiLine leaves exact-width and over-width lines unchanged", () => {
    expect(padAnsiLine("hello", 5)).toBe("hello");
    expect(padAnsiLine("hello", 3)).toBe("hello");
    expect(padAnsiLine(`${GREEN}hello${RESET}`, 5)).toBe(`${GREEN}hello${RESET}`);
  });

  it("wrapAndPadAnsiLines returns every wrapped line at the requested visible width", () => {
    const wrapped = wrapAndPadAnsiLines(`${CYAN}abcdefghi${RESET}\nxy`, 4);
    const lines = wrapped.split("\n");

    expect(lines.map(stripAnsi)).toEqual(["abcd", "efgh", "i   ", "xy  "]);
    expect(lines.every((line) => stringWidth(line) === 4)).toBe(true);
    expect(lines.every((line) => sgrBalance(line) === 0)).toBe(true);
  });

  it("does not leave emitted wrapped lines with active SGR state", () => {
    const wrapped = wrapAnsi(`${RED}abcdef${RESET}`, 2);

    expect(wrapped.every((line) => sgrBalance(line) === 0)).toBe(true);
  });

  // bug_drill_ansi_state_leaks_into_border: short colored input that
  // bypasses wrapping (early-return path) still has to close any open
  // SGR; otherwise ink renders the next chrome cell in the leaked colour.
  it("early-return path appends RESET when SGR is left open", () => {
    expect(wrapAnsi(`${RED}+ added`, 80)).toEqual([`${RED}+ added${RESET}`]);
  });

  it("early-return path does not add a spurious RESET when no SGR is open", () => {
    expect(wrapAnsi("plain text", 80)).toEqual(["plain text"]);
    expect(wrapAnsi(`${RED}closed${RESET}`, 80)).toEqual([`${RED}closed${RESET}`]);
  });

  it("end-of-loop emit closes SGR on the trailing wrapped chunk", () => {
    // Wrap a line whose final fragment opens (and never closes) SGR.
    // The trailing chunk goes through the end-of-loop push, which must
    // also append RESET so it does not bleed into the next row.
    const wrapped = wrapAnsi(`abcdef${RED}ghij`, 4);
    expect(wrapped.every((line) => sgrBalance(line) === 0)).toBe(true);
    expect(wrapped[wrapped.length - 1]?.endsWith(RESET)).toBe(true);
  });

  it("keeps a padded ANSI hunk header inside an Ink box without eating the right border", async () => {
    const boxWidth = 90;
    const contentWidth = boxWidth - 4; // borders + paddingX=1 on both sides
    const hunk = `${CYAN}@@ -35,6 +81,109 @@${RESET} ${"x".repeat(80)}`;
    const body = wrapAndPadAnsiLines(hunk, contentWidth);
    const stdout = createInkCaptureStream({ columns: boxWidth, rows: 10 });
    const instance = render(
      createElement(
        Box,
        { width: boxWidth, paddingX: 1, borderStyle: "round" },
        createElement(Text, { wrap: "truncate" }, body),
      ),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: false, patchConsole: false },
    );

    const rows = await collectRenderedLines(stdout);
    instance.unmount();

    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((row) => stringWidth(row) === boxWidth)).toBe(true);
    for (const row of rows.slice(1, -1)) {
      expect(row.endsWith("│")).toBe(true);
    }
  });
});
