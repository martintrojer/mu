// Activity-log popup (Shift+4 → `$`). Per design_popup_log.
//
// v0: list all snapshot.recent (newest at top), with j/k navigation.
// Auto-tail with scroll-pause + filters are deferred to v0.next.
//
// Enter is intentionally UNBOUND on this popup. Log entries are
// already a single line each — there's no "detail view" to drill
// into. The dispatchPopupKey returns {kind:"drill"}; we silently
// drop it so the user gets a no-op (no mode flip, no toast). All
// other popups treat Enter as drill; document the divergence here
// rather than carrying it as a special case in the dispatcher.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: seq, ts, source, verb
// are PROTECTED (identity / numeric / short tokens); the payload rest
// is CLIPPABLE.

import { Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";
import type { Db } from "../../../db.js";
import { classifyEventVerb } from "../../../logs.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type ColumnSpec, layoutColumns, renderRow } from "../columns.js";
import { dispatchPopupKey } from "../keys.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  // Log popup never enters drill mode (see header). The fields are
  // accepted to satisfy the uniform popup-props contract <App>
  // hands every popup; we don't read them.
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  db: Db;
  workstream: string;
}

const VIEWPORT = 20; // rows visible at once

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect", align: "right" }, // seq (#N)
  { kind: "protect" }, // ts
  { kind: "protect" }, // source
  { kind: "protect" }, // verb (or '·' fallback)
  { kind: "clip", min: 1 }, // rest / payload
];

export function LogPopup({ yank, onClose, snapshot }: PopupProps): JSX.Element {
  const [cursor, setCursor] = useState(0);
  const events = snapshot?.recent ?? [];
  // mode/onModeChange/db/workstream are part of the uniform popup
  // contract; LogPopup never drills. See header comment.

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
      case "drill":
        // Intentional no-op (see header). Log rows are atomic.
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

  const rows = visible.map((e) => {
    const cls = classifyEventVerb(e.payload);
    const ts = e.createdAt.slice(11, 19);
    const verb = cls?.verb ?? "·";
    const rest = cls?.rest ?? e.payload;
    return [`#${e.seq}`, ts, e.source, verb, rest];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS);

  return (
    <Shell title={`Activity log · popup (${cursor + 1}/${events.length})`}>
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((e, i) => {
          const sel = events.indexOf(e) === cursor;
          const cls = classifyEventVerb(e.payload);
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const [seq = "", ts = "", source = "", verb = "", rest = ""] = padded;
          return (
            <Box key={e.seq}>
              <Text inverse={sel}>
                <Text dimColor>{seq}</Text>
                {"  "}
                <Text dimColor>{ts}</Text>
                {"  "}
                <Text dimColor>{source}</Text>
                {"  "}
                {cls ? <Text color="cyan">{verb}</Text> : <Text dimColor>{verb}</Text>}
                {"  "}
                <Text>{rest}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        {/* Popup-specific yank target only; navigation hints live in the global status bar. */}
        <Text dimColor>y yanks the related `mu task/agent show` command</Text>
      </Box>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  // width={cols} + flexGrow={1} ensure the popup fills the pane edge-to-edge
  // (see bug_tui_popups_fill_pane). The body region above also flexGrows so
  // the bottom hint sticks to the popup's bottom (lazygit/btop convention).
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="column"
      flexGrow={1}
      width={cols}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}
