import { Text } from "ink";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
}

// Placeholder; real implementation in Task 31 (Wave 6).
export function AgentsPopup(_props: PopupProps): JSX.Element {
  return <Text>agents popup placeholder</Text>;
}
