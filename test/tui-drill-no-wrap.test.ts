// Regression guards for DrillScrollView's single-row body rendering.
//
// The drill body is pre-wrapped upstream by visual width with
// wrapAnsiLines(). Once a line reaches Ink it must stay on one
// terminal row: Ink's default Text wrap can count ANSI SGR escape
// bytes in coloured git-show / scrollback output and wrap again,
// spilling text into the popup chrome and bending the right border.

import { Box, render } from "ink";
import { createElement } from "react";
import stringWidth from "string-width";
import { afterEach, describe, expect, it } from "vitest";
import { DrillScrollView, wrapDrillBody } from "../src/cli/tui/popups/drill.js";
import { CaptureStream, collectRenderedLines, createInkCaptureStream } from "./_ink-render.js";

const ESC = "\u001B";
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const RESET = `${ESC}[0m`;
const ANSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function bodyRows(lines: readonly string[]): string[] {
  return lines.filter((line) => !line.startsWith("git show ") && line !== "hint");
}

async function withTerminalWidth<T>(cols: number, fn: () => Promise<T>): Promise<T> {
  const original = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process.stdout, "columns", { value: original, configurable: true });
  }
}

async function renderDrill(
  body: string,
  opts: { cols: number; boxWidth: number; wrappedBody?: ReturnType<typeof wrapDrillBody> },
): Promise<string[]> {
  return withTerminalWidth(opts.cols, async () => {
    const stdout = createInkCaptureStream({ columns: opts.cols, rows: 20 });
    const instance = render(
      createElement(
        Box,
        { flexDirection: "column", width: opts.boxWidth },
        createElement(DrillScrollView, {
          title: "git show abc123",
          body,
          viewport: 8,
          scrollTop: 0,
          hint: "hint",
          wrappedBody: opts.wrappedBody ?? wrapDrillBody(body, opts.boxWidth),
        }),
      ),
      { stdout, stdin: process.stdin, stderr: process.stderr, debug: false, patchConsole: false },
    );
    const lines = await collectRenderedLines(stdout);
    instance.unmount();
    return lines;
  });
}

function exactAnsiDiffBody(wrapWidth: number): string {
  const plusLine = `${GREEN}+${"a".repeat(wrapWidth - 1)}${RESET}`;
  const minusLine = `${RED}-${"b".repeat(wrapWidth - 1)}${RESET}`;
  return `${plusLine}\n${minusLine}`;
}

describe("DrillScrollView does not let Ink byte-wrap coloured pre-wrapped lines", () => {
  afterEach(() => {
    CaptureStream.cleanup();
  });

  it("marks title, position, fallback, body, and hint Text as truncate-wrapped", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("./src/cli/tui/popups/drill.tsx", "utf8");
    expect(src).toContain('color="magenta" wrap="truncate"');
    expect(src).toContain('dimColor wrap="truncate"');
    expect(src).toContain('key={`${start + i}`} wrap="truncate"');
    expect(src).toContain("Ink's default Text wrap can re-wrap coloured lines");
  });

  it("keeps ANSI-coloured diff lines that are exactly wrapWidth on one rendered row each", async () => {
    const wrapWidth = 24;
    const lines = await renderDrill(exactAnsiDiffBody(wrapWidth), {
      cols: wrapWidth + 6,
      boxWidth: wrapWidth,
    });
    const rows = bodyRows(lines).map(stripAnsi);

    expect(rows).toEqual([`+${"a".repeat(wrapWidth - 1)}`, `-${"b".repeat(wrapWidth - 1)}`]);
    expect(rows.every((line) => stringWidth(line) <= wrapWidth)).toBe(true);
  });

  it("truncates an over-budget coloured line instead of producing a wrap-overflow row", async () => {
    const wrapWidth = 24;
    const body = `${RED}>${"x".repeat(wrapWidth + 8)}${RESET}`;
    const lines = await renderDrill(body, {
      cols: wrapWidth + 6,
      boxWidth: wrapWidth,
      // Deliberately model a buggy upstream pre-wrap result: one
      // visible line wider than the drill budget. DrillScrollView
      // should clip it in-place, not let Ink wrap an overflow row.
      wrappedBody: { wrapped: body, lines: [body], totalLines: 1 },
    });
    const rows = bodyRows(lines).map(stripAnsi);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("…");
    expect(rows[0]?.startsWith(">")).toBe(true);
    expect(rows.every((line) => stringWidth(line) <= wrapWidth)).toBe(true);
  });
});
