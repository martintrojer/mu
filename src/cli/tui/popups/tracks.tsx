import { Text } from "ink";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
}

// Placeholder; real implementation in Task 32 (Wave 6).
export function TracksPopup(_props: PopupProps): JSX.Element {
  return <Text>tracks popup placeholder</Text>;
}
