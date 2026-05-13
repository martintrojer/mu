// =============================================================================
// Ink render helpers — the CaptureStream-based behaviour-test seam
// =============================================================================
//
// PURPOSE
// -------
// This module is the canonical seam for testing ink components from the
// outside, the way the user would experience them: render the component
// into a fake stdout, optionally simulate keystrokes against a fake
// stdin, and assert on the visible text that comes out.
//
// WHEN TO USE THIS SEAM (vs source-greps)
// ---------------------------------------
// Strongly prefer behaviour tests built on this seam over `readFileSync`
// source-greps of `src/cli/tui/**`. Source-greps test the implementation
// (`expect(src).toContain('useInput')`), not the behaviour, and they
// silently rot the moment someone restructures the file.
//
// Use a behaviour test (this seam) when you can answer "what should the
// user see / what should pressing this key do" — that's almost always.
//
// Source-greps are only acceptable for narrow import-graph guards
// ("popup must not import from src/cli.js") where the *intent* really
// is "this file's import graph". Anything user-visible — keymap wiring,
// rendered rows, status filters, drill mode, yank command — should be a
// behaviour test.
//
// THE 4-STEP PATTERN
// ------------------
// 1. `const stdin = createInkInputStream();`
// 2. `const stdout = createInkCaptureStream({ columns, rows });`
// 3. `const instance = render(<Popup ... />, { stdin, stdout, stderr,
//    debug: false, patchConsole: false });`
// 4. Drive input via `await simulateInput(stdin, "j")` /
//    `await simulateInput(stdin, "escape")`, then assert against
//    `latestRenderedFrame(stdout)` (or `renderedLines(stdout)` for the
//    cumulative log of frames). Always `instance.unmount()` at the end
//    (or in `afterEach`) and call `CaptureStream.cleanup()`.
//
// EXEMPLARS
// ---------
// - `test/tui-popup-all-tasks.test.ts` — full CaptureStream behaviour
//   pattern: seeds the DB, renders the AllTasksPopup with a real stdin,
//   walks the cursor with simulated `j` keys, and asserts the centred
//   visible window in the rendered frame.
// - `test/tui-popup-tasks.test.ts` — render + waitForInkOutput without
//   simulated input, used for static frame assertions.
//
// NOTES
// -----
// - `simulateInput` translates symbolic key names ("escape", "enter",
//   "up", …) into the byte sequences ink's `parse-keypress.js` expects,
//   then awaits a small tick so ink can re-render. Use the symbolic
//   form for non-printable keys; pass plain strings for letters/digits.
// - The default per-keystroke wait (5ms) is empirically enough for
//   ink's reconciler under vitest. Bump it via `{ wait: ... }` if a
//   particular test is flaky on slower hosts.
// =============================================================================

import { PassThrough, Writable } from "node:stream";

export class CaptureStream extends Writable {
  static readonly streams: CaptureStream[] = [];

  output = "";
  columns: number;
  rows: number;

  constructor({ columns, rows }: { columns: number; rows: number }) {
    super();
    this.columns = columns;
    this.rows = rows;
    CaptureStream.streams.push(this);
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.output += chunk.toString();
    callback();
  }

  static cleanup(): void {
    for (const stream of CaptureStream.streams.splice(0)) {
      stream.removeAllListeners();
    }
  }
}

export type InkCaptureStream = CaptureStream & NodeJS.WriteStream;
export type InkInputStream = NodeJS.ReadStream & {
  setRawMode(mode: boolean): InkInputStream;
  ref(): InkInputStream;
  unref(): InkInputStream;
};

export function createInkCaptureStream(opts: { columns: number; rows: number }): InkCaptureStream {
  const capture = new CaptureStream(opts);
  return capture as unknown as InkCaptureStream;
}

export function createInkInputStream(): InkInputStream {
  const stdin = new PassThrough() as unknown as InkInputStream & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => InkInputStream;
    ref: () => InkInputStream;
    unref: () => InkInputStream;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

export function renderedLines(stdout: { output: string }): string[] {
  const esc = String.fromCharCode(27);
  return stdout.output
    .replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .split("\n")
    .filter((line) => line.length > 0);
}

export function latestRenderedFrame(stdout: CaptureStream): string[] {
  const esc = String.fromCharCode(27);
  const clearTerminalIndex = stdout.output.lastIndexOf(`${esc}[2J`);
  const eraseLineIndex = stdout.output.lastIndexOf(`${esc}[2K`);
  const frameStart = Math.max(clearTerminalIndex, eraseLineIndex, 0);
  return renderedLines({ output: stdout.output.slice(frameStart) });
}

export async function collectRenderedLines(stdout: CaptureStream): Promise<string[]> {
  await waitForInkOutput(stdout);
  return renderedLines(stdout);
}

export async function waitForInkOutput(stdout: CaptureStream): Promise<void> {
  const deadline = Date.now() + 1000;
  let previous = "";
  let stableSamples = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (stdout.output.length > 0 && stdout.output === previous) {
      stableSamples += 1;
      if (stableSamples >= 2) return;
    } else {
      stableSamples = 0;
      previous = stdout.output;
    }
  }
}

// ---------------------------------------------------------------------------
// simulateInput
// ---------------------------------------------------------------------------
//
// Symbolic names for non-printable keys. Anything not in this table is
// written verbatim (so plain letters / digits / punctuation work as-is).
//
// The byte sequences match what ink's `parse-keypress.js` decodes:
//   '\r'      → return        '\x1b'      → escape
//   '\t'      → tab           '\x7f'      → delete
//   '\b'      → backspace     '\x1b[A..D' → arrows
//   ' '       → space         '\x1b[5~/6~'→ pageup / pagedown
// (See node_modules/ink/build/parse-keypress.js.)

const KEY_SEQUENCES: Readonly<Record<string, string>> = {
  escape: "\x1b",
  esc: "\x1b",
  enter: "\r",
  return: "\r",
  tab: "\t",
  space: " ",
  backspace: "\b",
  delete: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
};

export type InputKey =
  | "escape"
  | "esc"
  | "enter"
  | "return"
  | "tab"
  | "space"
  | "backspace"
  | "delete"
  | "up"
  | "down"
  | "right"
  | "left"
  | "pageup"
  | "pagedown"
  | "home"
  | "end";

/** Sequence to write for a symbolic key name, or `null` if unknown. */
export function inputKeySequence(name: string): string | null {
  const seq = KEY_SEQUENCES[name.toLowerCase()];
  return seq ?? null;
}

/**
 * Simulate a single keystroke against an ink input stream and wait
 * briefly so ink's reconciler can flush.
 *
 * `input` is either:
 *   - a symbolic key name (`"escape"`, `"enter"`, `"up"`, …) — translated
 *     to the byte sequence ink expects, **or**
 *   - any other string (letters / digits / multi-char text) — written
 *     verbatim. A bare `"j"` writes `"j"`, a multi-char string is
 *     pasted as-is.
 *
 * `opts.wait` defaults to 5ms — empirically sufficient for ink to
 * re-render under vitest on the inner dev-loop hosts. Bump it via
 * `{ wait: 20 }` for a flaky case rather than copy-pasting an ad-hoc
 * `setTimeout`.
 */
export async function simulateInput(
  stdin: InkInputStream,
  input: string,
  opts: { wait?: number } = {},
): Promise<void> {
  const wait = opts.wait ?? 5;
  const sequence = inputKeySequence(input) ?? input;
  (stdin as unknown as NodeJS.WritableStream).write(sequence);
  await new Promise((resolve) => setTimeout(resolve, wait));
}
