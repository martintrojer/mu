import { Text } from "ink";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
}

// Placeholder; real implementation in Task 34 (Wave 6).
export function LogPopup(_props: PopupProps): JSX.Element {
  return <Text>log popup placeholder</Text>;
}
