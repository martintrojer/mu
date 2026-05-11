// Tracks popup (Shift+2 → `@`). Per design_popup_tracks.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: track number, ⋈ glyph,
// counts are PROTECTED; the goal-name list is CLIPPABLE.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type ColumnSpec, layoutColumns, renderRow } from "../columns.js";
import { dispatchPopupKey } from "../keys.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // "Track N"
  { kind: "protect" }, // diamond glyph (or empty)
  { kind: "clip", min: 1 }, // goal names
  { kind: "protect" }, // counts
];

export function TracksPopup({ yank, onClose, snapshot }: PopupProps): JSX.Element {
  const [cursor, setCursor] = useState(0);
  const tracks = snapshot?.tracks ?? [];

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
        setCursor((c) => Math.min(tracks.length - 1, c + 1));
        return;
      case "moveUp":
        setCursor((c) => Math.max(0, c - 1));
        return;
      case "jumpTop":
        setCursor(0);
        return;
      case "jumpBottom":
        setCursor(Math.max(0, tracks.length - 1));
        return;
      case "yank": {
        const t = tracks[cursor];
        if (!t || !snapshot) return;
        const goal = t.roots[0]?.name;
        if (!goal) return;
        const ws = snapshot.workstreamName;
        void yank(`mu task tree ${goal} -w ${ws}`);
        return;
      }
    }
  });

  if (snapshot === null) {
    return <Shell title="Tracks · popup">{<Text dimColor>loading…</Text>}</Shell>;
  }
  if (tracks.length === 0) {
    return (
      <Shell title="Tracks · popup">
        <Text dimColor>(no goals — `mu task add ... --impact ...`)</Text>
        <Text dimColor>j/k g/G y Esc</Text>
      </Shell>
    );
  }

  const rows = tracks.map((t, i) => {
    const goalNames = t.roots.map((r) => r.name).join(", ");
    const diamond = t.roots.length > 1 ? "⋈" : " ";
    const counts = `(${t.taskIds.size} tasks · ${t.readyCount} ready)`;
    return [`Track ${i + 1}`, diamond, goalNames, counts];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS);

  return (
    <Shell title={`Tracks · popup (${cursor + 1}/${tracks.length})`}>
      {tracks.map((t, i) => {
        const sel = i === cursor;
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const [trackLabel = "", diamond = "", goals = "", counts = ""] = padded;
        return (
          <Box key={`tr-${i}-${t.roots[0]?.name ?? "?"}`}>
            <Text inverse={sel}>
              <Text color="cyan">{trackLabel}</Text>
              {"  "}
              <Text>{diamond}</Text>
              {"  "}
              <Text>{goals}</Text>
              {"  "}
              <Text dimColor>{counts}</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>j/k · y yank `mu task tree &lt;goal&gt;` · Esc/q close</Text>
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
