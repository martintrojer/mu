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
