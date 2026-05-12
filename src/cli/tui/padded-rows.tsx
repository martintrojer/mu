import { Text } from "ink";
import type { ReactNode } from "react";

export interface PaddedRowsProps {
  minRows?: number;
  rows?: number;
  children: ReactNode;
}

/** Ensure one-line empty/loading card bodies still occupy their row budget. */
export function PaddedRows({ minRows, rows, children }: PaddedRowsProps): JSX.Element {
  const targetRows = Math.max(0, Math.floor(rows ?? minRows ?? 0));
  const blanks = Math.max(0, targetRows - 1);
  return (
    <>
      {children}
      {Array.from({ length: blanks }, (_, i) => `blank-${i}`).map((key) => (
        <Text key={key}> </Text>
      ))}
    </>
  );
}
