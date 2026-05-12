import { Writable } from "node:stream";

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

  _write(
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

export async function collectRenderedLines(stdout: CaptureStream): Promise<string[]> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  const esc = String.fromCharCode(27);
  return stdout.output
    .replace(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .split("\n")
    .filter((line) => line.length > 0);
}
