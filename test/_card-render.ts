// Shared JSX-tree text extraction for TUI card tests.
//
// Matches the walk() recursion pattern used in tui-status-bar.test.ts
// and tui-tab-strip.test.ts, with one card-specific addition: card
// FCs return unexecuted component elements (<TitledBox>, <ListRow>)
// because we do not boot ink. So we recurse through props.children
// AND the textual props those components would render (title,
// subtitle, bottomLabel, cells).

import { expect } from "vitest";

export function renderCardToText(node: unknown): string {
  function walk(n: unknown): string {
    if (n === null || n === undefined) return "";
    if (typeof n === "string") return n;
    if (typeof n === "number") return String(n);
    if (Array.isArray(n)) return n.map(walk).join("");
    if (typeof n === "object" && n !== null && "props" in n) {
      const props = (n as { props: RenderableProps }).props;
      return [
        walk(props.title),
        walk(props.subtitle),
        walk(props.bottomLabel),
        walk(props.cells),
        props.minRows === undefined ? "" : ` minRows=${walk(props.minRows)} `,
        props.rows === undefined ? "" : ` rows=${walk(props.rows)} `,
        props.height === undefined ? "" : ` height=${walk(props.height)} `,
        walk(props.children),
      ].join("");
    }
    return "";
  }
  return walk(node);
}

interface RenderableProps {
  title?: unknown;
  subtitle?: unknown;
  bottomLabel?: unknown;
  cells?: unknown;
  minRows?: unknown;
  rows?: unknown;
  height?: unknown;
  children?: unknown;
}

export function expectTextOnce(text: string, needle: string): void {
  expect(countOccurrences(text, needle)).toBe(1);
}

export function expectTextAbsent(text: string, needle: string): void {
  expect(countOccurrences(text, needle)).toBe(0);
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  return text.split(needle).length - 1;
}
