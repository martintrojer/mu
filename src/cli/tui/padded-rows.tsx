import { Text } from "ink";
import type { ReactElement, ReactNode } from "react";

export interface PaddedRowsProps {
  rows?: number;
  children: ReactNode;
}

/** Ensure one-line empty/loading card bodies still occupy their row budget. */
export function PaddedRows({ rows, children }: PaddedRowsProps): ReactElement {
  const targetRows = Math.max(0, Math.floor(rows ?? 0));
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
