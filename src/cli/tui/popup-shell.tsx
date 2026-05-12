import type { ReactNode } from "react";
import { TitledBox } from "./titled-box.js";

export interface PopupShellProps {
  title: string;
  /** Per-popup hint inset into the bottom border. Null / undefined suppresses it. */
  hint?: string | null;
  children: ReactNode;
}

export function PopupShell({ title, hint, children }: PopupShellProps): JSX.Element {
  return (
    <TitledBox
      title={title}
      borderColor="cyan"
      titleColor="cyan"
      bottomLabel={hint ?? undefined}
      flexGrow={1}
    >
      {children}
    </TitledBox>
  );
}
