// Unit tests for the simulateInput helper + inputKeySequence map in
// test/_ink-render.ts. The seam itself is exercised end-to-end via the
// popup behaviour tests (e.g. tui-popup-all-tasks.test.ts); these tests
// pin the bits the popup tests care about — symbolic key translation,
// verbatim passthrough, and the post-write tick — so a future
// refactor of the helper can't silently change them.

import { afterEach, describe, expect, it } from "vitest";
import {
  CaptureStream,
  type InkInputStream,
  createInkInputStream,
  inputKeySequence,
  simulateInput,
} from "./_ink-render.js";

afterEach(() => {
  CaptureStream.cleanup();
});

function captureWrites(stdin: InkInputStream): string[] {
  const seen: string[] = [];
  // PassThrough emits Buffer chunks via 'data'.
  (stdin as unknown as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
    seen.push(chunk.toString("utf8"));
  });
  return seen;
}

describe("inputKeySequence", () => {
  it("maps the common symbolic keys to ink's expected byte sequences", () => {
    expect(inputKeySequence("escape")).toBe("\x1b");
    expect(inputKeySequence("Esc")).toBe("\x1b");
    expect(inputKeySequence("enter")).toBe("\r");
    expect(inputKeySequence("RETURN")).toBe("\r");
    expect(inputKeySequence("tab")).toBe("\t");
    expect(inputKeySequence("space")).toBe(" ");
    expect(inputKeySequence("up")).toBe("\x1b[A");
    expect(inputKeySequence("down")).toBe("\x1b[B");
    expect(inputKeySequence("pageup")).toBe("\x1b[5~");
    expect(inputKeySequence("pagedown")).toBe("\x1b[6~");
  });

  it("returns null for plain letters / digits / unknown names", () => {
    expect(inputKeySequence("j")).toBeNull();
    expect(inputKeySequence("Q")).toBeNull();
    expect(inputKeySequence("7")).toBeNull();
    expect(inputKeySequence("nope")).toBeNull();
  });
});

describe("simulateInput", () => {
  it("translates a symbolic key to the right byte sequence on stdin", async () => {
    const stdin = createInkInputStream();
    const seen = captureWrites(stdin);
    await simulateInput(stdin, "escape", { wait: 0 });
    expect(seen).toEqual(["\x1b"]);
  });

  it("writes plain letters and multi-char strings verbatim", async () => {
    const stdin = createInkInputStream();
    const seen = captureWrites(stdin);
    await simulateInput(stdin, "j", { wait: 0 });
    await simulateInput(stdin, "hello", { wait: 0 });
    expect(seen).toEqual(["j", "hello"]);
  });

  it("awaits the configured wait window before resolving", async () => {
    const stdin = createInkInputStream();
    const start = Date.now();
    await simulateInput(stdin, "k", { wait: 25 });
    const elapsed = Date.now() - start;
    // setTimeout granularity on macOS / Linux is ~1ms; allow some slack
    // below the requested wait but require it to be in the right order.
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });

  it("defaults to a small (~5ms) wait when opts.wait is omitted", async () => {
    const stdin = createInkInputStream();
    const seen = captureWrites(stdin);
    const start = Date.now();
    await simulateInput(stdin, "j");
    const elapsed = Date.now() - start;
    expect(seen).toEqual(["j"]);
    // Must wait at least one event-loop turn; cap is generous so the
    // test isn't flaky under load.
    expect(elapsed).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(200);
  });

  it("can drive a sequence of cursor moves the way a popup test would", async () => {
    const stdin = createInkInputStream();
    const seen = captureWrites(stdin);
    for (let i = 0; i < 3; i++) await simulateInput(stdin, "j", { wait: 0 });
    await simulateInput(stdin, "escape", { wait: 0 });
    expect(seen).toEqual(["j", "j", "j", "\x1b"]);
  });
});
