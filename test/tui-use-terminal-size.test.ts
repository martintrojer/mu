// Behaviour tests for the useTerminalSize hook.
//
// Regression guard for bug_use_terminal_size_double_render: the hook's
// mount-time "defensive sync" used to call setSize() unconditionally,
// forcing a second render on every mount even when the dimensions were
// unchanged. That doubled work in production and doubled captured
// frames in ink render tests (it's what broke
// tui-row-budget-overflow.integration.test.ts after the resize-
// reactivity fix landed). The hook now bails (same state reference)
// when nothing changed.
//
// These tests pin BOTH halves of the contract:
//   1. mount does NOT cause an extra re-render (render count stays 1),
//   2. a real resize (new dims) DOES re-render with the new size,
//   3. a resize event with UNCHANGED dims does NOT re-render.

import type { EventEmitter } from "node:events";
import { Text, render } from "ink";
import { createElement, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useTerminalSize } from "../src/cli/tui/use-terminal-size.js";
import { CaptureStream, createInkCaptureStream, waitForInkOutput } from "./_ink-render.js";

afterEach(() => {
  CaptureStream.cleanup();
});

/** A fake stdout that is also an EventEmitter so we can fire `resize`
 *  events at the hook, with mutable columns/rows. */
function makeResizableStdout(
  columns: number,
  rows: number,
): {
  stdout: CaptureStream & NodeJS.WriteStream;
  setSize: (c: number, r: number) => void;
  resize: (c: number, r: number) => void;
} {
  const capture = createInkCaptureStream({ columns, rows });
  // CaptureStream already extends Writable (an EventEmitter), so `on` /
  // `emit` work. ink reads `.columns` / `.rows` off the stream.
  const setSize = (c: number, r: number): void => {
    capture.columns = c;
    capture.rows = r;
  };
  const resize = (c: number, r: number): void => {
    setSize(c, r);
    (capture as unknown as EventEmitter).emit("resize");
  };
  return { stdout: capture, setSize, resize };
}

/** Component that records how many times it rendered and prints the
 *  current size + render count so we can assert from the frame log. */
function Probe(): JSX.Element {
  const { cols, rows } = useTerminalSize();
  const count = useRef(0);
  count.current += 1;
  return createElement(Text, null, `r=${count.current} ${cols}x${rows}`);
}

describe("useTerminalSize", () => {
  it("does not force an extra re-render on mount (no double render)", async () => {
    const { stdout } = makeResizableStdout(140, 40);
    const instance = render(createElement(Probe), {
      stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      debug: true,
      patchConsole: false,
    });
    await waitForInkOutput(stdout);
    // debug:true overwrites the same frame each render, so the captured
    // output is the LAST frame only. The render counter embedded in it
    // must be 1 — a mount-time setSize would bump it to 2.
    expect(stdout.output).toContain("r=1 140x40");
    instance.unmount();
  });

  it("re-renders with new dimensions on a real resize", async () => {
    const { stdout, resize } = makeResizableStdout(140, 40);
    const instance = render(createElement(Probe), {
      stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      debug: true,
      patchConsole: false,
    });
    await waitForInkOutput(stdout);
    resize(80, 24);
    await new Promise((r) => setTimeout(r, 30));
    expect(stdout.output).toContain("80x24");
    // It re-rendered exactly once more (mount=1, resize=2).
    expect(stdout.output).toContain("r=2 80x24");
    instance.unmount();
  });

  it("does NOT re-render on a resize event with unchanged dimensions", async () => {
    const { stdout, resize } = makeResizableStdout(140, 40);
    const instance = render(createElement(Probe), {
      stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      debug: true,
      patchConsole: false,
    });
    await waitForInkOutput(stdout);
    // Fire a resize event but keep the same dimensions.
    resize(140, 40);
    await new Promise((r) => setTimeout(r, 30));
    // Render count stays at 1 — the same-reference bail skipped it.
    expect(stdout.output).toContain("r=1 140x40");
    expect(stdout.output).not.toContain("r=2");
    instance.unmount();
  });
});
