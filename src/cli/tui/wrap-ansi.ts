import stringWidth from "string-width";

const ESC = "\u001B";
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "y");
const SGR_PATTERN = new RegExp(`^${ESC}\\[([0-9;]*)m$`);
const RESET = `${ESC}[0m`;

interface Token {
  text: string;
  width: number;
}

/**
 * Wrap a single line by terminal-visible width while preserving
 * ANSI SGR colour/style across hard wrap boundaries.
 */
export function wrapAnsi(line: string, width: number): string[] {
  if (line === "" || width <= 0 || stringWidth(line) <= width) return [line];

  const out: string[] = [];
  const activeSgr: string[] = [];
  let chunk = "";
  let chunkWidth = 0;
  let i = 0;

  const emit = () => {
    if (chunkWidth === 0) return;
    out.push(activeSgr.length > 0 ? `${chunk}${RESET}` : chunk);
    chunk = activeSgr.join("");
    chunkWidth = 0;
  };

  while (i < line.length) {
    ANSI_PATTERN.lastIndex = i;
    const ansi = ANSI_PATTERN.exec(line);
    if (ansi?.index === i) {
      const seq = ansi[0];
      chunk += seq;
      updateActiveSgr(seq, activeSgr);
      i += seq.length;
      continue;
    }

    const token = nextToken(line, i);
    if (chunkWidth > 0 && chunkWidth + token.width > width) emit();
    chunk += token.text;
    chunkWidth += token.width;
    i += token.text.length;

    if (chunkWidth >= width) emit();
  }

  if (chunkWidth > 0 || (chunk !== "" && out.length === 0)) out.push(chunk);
  return out.length === 0 ? [line] : out;
}

export function wrapAnsiLines(text: string, width: number): string {
  return text
    .split("\n")
    .flatMap((line) => wrapAnsi(line, width))
    .join("\n");
}

function nextToken(text: string, offset: number): Token {
  const first = text[offset];
  if (first === undefined) return { text: "", width: 0 };
  const codePoint = text.codePointAt(offset);
  if (codePoint === undefined) return { text: first, width: stringWidth(first) };
  const char = String.fromCodePoint(codePoint);
  return { text: char, width: stringWidth(char) };
}

function updateActiveSgr(seq: string, active: string[]): void {
  const match = SGR_PATTERN.exec(seq);
  if (match === null) return;
  const rawParams = match[1] ?? "";
  const params = rawParams === "" ? [0] : rawParams.split(";").map((p) => Number(p || "0"));
  if (params.some(isFullReset)) {
    active.length = 0;
    return;
  }
  active.push(seq);
}

function isFullReset(code: number): boolean {
  return code === 0;
}
