// Agents popup (Shift+1 → `!`). Drill-down for the Agents card.
//
// Per design_popup_agents (workstream `tui`): list of agents with
// per-agent yank intents (free / close / send). Full pane scrollback
// integration is v0.next (needs a non-trivial readPane wiring).

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { STATUS_EMOJI } from "../../../agents.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { dispatchPopupKey } from "../keys.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
}

export function AgentsPopup({ yank, onClose, snapshot }: PopupProps): JSX.Element {
  const [cursor, setCursor] = useState(0);
  const agents = snapshot?.view.agents ?? [];

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
        setCursor((c) => Math.min(agents.length - 1, c + 1));
        return;
      case "moveUp":
        setCursor((c) => Math.max(0, c - 1));
        return;
      case "jumpTop":
        setCursor(0);
        return;
      case "jumpBottom":
        setCursor(Math.max(0, agents.length - 1));
        return;
      case "yank": {
        const a = agents[cursor];
        if (!a || !snapshot) return;
        const ws = snapshot.workstreamName;
        // Default yank: a `mu agent send` template the user can
        // edit. The popup-verb keys f / x cover free / close in
        // v0.next.
        void yank(`mu agent send ${a.name} '...' -w ${ws}`);
        return;
      }
      case "verb": {
        const a = agents[cursor];
        if (!a || !snapshot) return;
        const ws = snapshot.workstreamName;
        if (action.key === "f") {
          void yank(`mu agent free ${a.name} -w ${ws}`);
          return;
        }
        if (action.key === "x") {
          void yank(`mu agent close ${a.name} -w ${ws}`);
          return;
        }
        return;
      }
    }
  });

  if (snapshot === null) {
    return <Shell title="Agents · popup">{<Text dimColor>loading…</Text>}</Shell>;
  }
  if (agents.length === 0) {
    return (
      <Shell title="Agents · popup">
        <Text dimColor>(no agents)</Text>
        <Text dimColor>j/k g/G y/f/x Esc</Text>
      </Shell>
    );
  }

  return (
    <Shell title={`Agents · popup (${cursor + 1}/${agents.length})`}>
      {agents.map((a, i) => {
        const sel = i === cursor;
        return (
          <Box key={a.name}>
            <Text inverse={sel}>
              {STATUS_EMOJI[a.status] ?? "?"} <Text bold>{a.name}</Text>{" "}
              <Text dimColor>{a.status}</Text> <Text dimColor>{a.role}</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>j/k · y send · f free · x close · Esc/q close popup</Text>
      </Box>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}
