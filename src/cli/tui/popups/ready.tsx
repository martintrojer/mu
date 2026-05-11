// Tasks popup (Shift+3 → `#`). The drill-down for the Ready card.
//
// Per design_popup_tasks (workstream `tui`): list of OPEN/IN_PROGRESS
// tasks with a yank-matrix per task state. v0 ships the list + a
// subset of the matrix:
//   OPEN ready (no owner)     → mu task claim <id> -w <ws>
//   OPEN owned                → mu task release <id> -w <ws>
//   IN_PROGRESS owned-by-self → mu task close <id> -w <ws> --evidence "..."
//   CLOSED                    → mu task open <id> -w <ws>
// Other states yield no yank (toast says so).

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { WorkstreamSnapshot } from "../../../state.js";
import { dispatchPopupKey } from "../keys.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
}

export function ReadyPopup({ yank, onClose, snapshot }: PopupProps): JSX.Element {
  const [cursor, setCursor] = useState(0);
  const tasks = snapshot ? [...snapshot.ready, ...snapshot.inProgress] : [];

  useInput((input, key) => {
    const action = dispatchPopupKey(input, {
      ctrl: key.ctrl,
      shift: key.shift,
      meta: key.meta,
      escape: key.escape,
      return: key.return,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      tab: key.tab,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
    });
    switch (action.kind) {
      case "close":
        onClose();
        return;
      case "moveDown":
        setCursor((c) => Math.min(tasks.length - 1, c + 1));
        return;
      case "moveUp":
        setCursor((c) => Math.max(0, c - 1));
        return;
      case "jumpTop":
        setCursor(0);
        return;
      case "jumpBottom":
        setCursor(Math.max(0, tasks.length - 1));
        return;
      case "yank": {
        const t = tasks[cursor];
        if (!t || !snapshot) return;
        const ws = snapshot.workstreamName;
        const cmd = yankCommandForTask(t, ws);
        if (cmd) void yank(cmd);
        return;
      }
    }
  });

  if (snapshot === null) {
    return <PopupShell title="Tasks · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (tasks.length === 0) {
    return (
      <PopupShell title="Tasks · popup">
        <Text dimColor>(no open / in-progress tasks)</Text>
        <Text dimColor>j/k g/G y Esc</Text>
      </PopupShell>
    );
  }

  return (
    <PopupShell title={`Tasks · popup (${cursor + 1}/${tasks.length})`}>
      {tasks.map((t, i) => {
        const selected = i === cursor;
        return (
          <Box key={t.name}>
            <Text inverse={selected}>
              <Text bold>{t.name}</Text> <Text dimColor>{t.status}</Text>{" "}
              <Text dimColor>{t.ownerName ?? "—"}</Text> <Text>{truncate(t.title, 60)}</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>j/k navigate · y yank · Esc/q close</Text>
      </Box>
    </PopupShell>
  );
}

function yankCommandForTask(
  t: { name: string; status: string; ownerName: string | null },
  ws: string,
): string | null {
  switch (t.status) {
    case "OPEN":
      return t.ownerName === null
        ? `mu task claim ${t.name} -w ${ws}`
        : `mu task release ${t.name} -w ${ws}`;
    case "IN_PROGRESS":
      return `mu task close ${t.name} -w ${ws} --evidence "..."`;
    case "CLOSED":
    case "REJECTED":
    case "DEFERRED":
      return `mu task open ${t.name} -w ${ws}`;
    default:
      return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function PopupShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}
