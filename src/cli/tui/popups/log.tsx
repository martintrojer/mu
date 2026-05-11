// Activity-log popup (Shift+4 → `$`). Per design_popup_log.
//
// v0: list all snapshot.recent (newest at top), with j/k navigation.
// Auto-tail with scroll-pause + filters are deferred to v0.next.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { classifyEventVerb } from "../../../logs.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { dispatchPopupKey } from "../keys.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
}

const VIEWPORT = 20; // rows visible at once

export function LogPopup({ yank, onClose, snapshot }: PopupProps): JSX.Element {
  const [cursor, setCursor] = useState(0);
  const events = snapshot?.recent ?? [];

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
        setCursor((c) => Math.min(events.length - 1, c + 1));
        return;
      case "moveUp":
        setCursor((c) => Math.max(0, c - 1));
        return;
      case "jumpTop":
        setCursor(0);
        return;
      case "jumpBottom":
        setCursor(Math.max(0, events.length - 1));
        return;
      case "yank": {
        const e = events[cursor];
        if (!e || !snapshot) return;
        // Yank the show-related-task / show-related-agent if we
        // can classify; else just yank the raw payload as a
        // reference.
        const cls = classifyEventVerb(e.payload);
        if (cls === null) {
          void yank(`# event: ${e.payload}`);
          return;
        }
        // Pull the first whitespace-separated token from `rest` —
        // usually the entity id.
        const rest = cls.rest.trim();
        const id = rest.split(/[\s(]/)[0];
        if (cls.verb.startsWith("task ")) {
          void yank(`mu task show ${id} -w ${snapshot.workstreamName}`);
        } else if (cls.verb.startsWith("agent ")) {
          void yank(`mu agent show ${id} -w ${snapshot.workstreamName}`);
        } else {
          void yank(`# event: ${e.payload}`);
        }
        return;
      }
    }
  });

  if (snapshot === null) {
    return <Shell title="Activity log · popup">{<Text dimColor>loading…</Text>}</Shell>;
  }
  if (events.length === 0) {
    return (
      <Shell title="Activity log · popup">
        <Text dimColor>(no events yet)</Text>
      </Shell>
    );
  }

  // Centre the cursor in the viewport.
  const start = Math.max(0, Math.min(events.length - VIEWPORT, cursor - Math.floor(VIEWPORT / 2)));
  const visible = events.slice(start, start + VIEWPORT);

  return (
    <Shell title={`Activity log · popup (${cursor + 1}/${events.length})`}>
      {visible.map((e) => {
        const sel = events.indexOf(e) === cursor;
        const cls = classifyEventVerb(e.payload);
        const ts = e.createdAt.slice(11, 19);
        return (
          <Box key={e.seq}>
            <Text inverse={sel}>
              <Text dimColor>#{e.seq}</Text> <Text dimColor>{ts}</Text>{" "}
              <Text dimColor>{e.source}</Text>{" "}
              {cls ? (
                <>
                  <Text color="cyan">{cls.verb}</Text>
                  <Text>{cls.rest}</Text>
                </>
              ) : (
                <Text>{e.payload}</Text>
              )}
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>j/k · y yank related show command · Esc/q close</Text>
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
