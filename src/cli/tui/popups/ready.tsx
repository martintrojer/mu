import { Text } from "ink";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
}

// Placeholder; real implementation in Task 33 (Wave 6) — the Tasks popup.
export function ReadyPopup(_props: PopupProps): JSX.Element {
  return <Text>tasks popup placeholder</Text>;
}
