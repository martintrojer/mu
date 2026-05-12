import { Text } from "ink";
import type { ReactNode } from "react";

export interface PaddedRowsProps {
  minRows: number;
  children: ReactNode;
}

/** Ensure one-line empty/loading card bodies still occupy their row budget. */
export function PaddedRows({ minRows, children }: PaddedRowsProps): JSX.Element {
  const blanks = Math.max(0, minRows - 1);
  return (
    <>
      {children}
      {Array.from({ length: blanks }, (_, i) => `blank-${i}`).map((key) => (
        <Text key={key}> </Text>
      ))}
    </>
  );
}
