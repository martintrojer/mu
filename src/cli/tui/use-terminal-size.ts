// Shared reactive terminal-size hook for all TUI surfaces.
//
// ink's `useStdout()` returns the raw stdout stream, but reading
// `.columns` / `.rows` during render only captures the value at
// that moment — ink does NOT re-render when the terminal resizes.
// This hook subscribes to the `resize` event on stdout and bumps
// local state so every consumer re-renders with the new dimensions.
//
// Usage:
//
//     const { cols, rows } = useTerminalSize();
//
// Replaces the boilerplate pattern:
//
//     const { stdout } = useStdout();
//     const cols = stdout?.columns ?? 80;
//
// Per ROADMAP pledge: ink/react import confined to src/cli/tui/*.

import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
  cols: number;
  rows: number;
}

/**
 * Returns the current terminal dimensions and re-renders whenever
 * the terminal is resized. Falls back to 80×24 when stdout is not
 * a TTY (e.g. test capture streams without columns/rows).
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    cols: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setSize({
        cols: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      });
    };
    stdout.on("resize", onResize);
    // Sync in case the size changed between initial render and
    // effect registration (unlikely but defensive).
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
