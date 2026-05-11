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
//
// Enter on a task drills into a read-only inline view of every note
// on the task (the equivalent of `mu task notes <id>`). j/k scroll;
// Esc / q backs out to the list; second Esc / q closes the popup.
//
// Read-only: drilling never executes anything. listNotes is a SQLite
// SELECT.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: task name, status, owner
// are PROTECTED (yank-bearing tokens); the title is CLIPPABLE.

import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { listNotes } from "../../../tasks.js";
import { type ColumnSpec, layoutColumns, renderRow } from "../columns.js";
import { dispatchPopupKey } from "../keys.js";
import { DrillScrollView, clampScrollTop } from "./drill.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  db: Db;
  workstream: string;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // task name
  { kind: "protect" }, // status
  { kind: "protect" }, // owner (or "—")
  { kind: "clip", min: 1 }, // title
];

const VIEWPORT = 20;

export function ReadyPopup({
  yank,
  onClose,
  snapshot,
  mode,
  onModeChange,
  db,
  workstream,
}: PopupProps): JSX.Element {
  const [cursor, setCursor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const tasks = snapshot ? [...snapshot.ready, ...snapshot.inProgress] : [];
  const focused = tasks[cursor];

  // Resolve notes for the focused task on demand. Memoised on
  // (taskId, mode); we only hit SQLite when actually drilled in.
  const notesText = useMemo<string>(() => {
    if (mode !== "drill" || !focused) return "";
    const notes = listNotes(db, focused.name, workstream);
    if (notes.length === 0) return "";
    return notes
      .map((n) => {
        const ts = n.createdAt.replace("T", " ").slice(0, 19);
        const author = n.author ?? "?";
        return `── ${ts}  ${author} ──\n${n.content}`;
      })
      .join("\n\n");
  }, [mode, focused, db, workstream]);

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
    if (mode === "drill") {
      const totalLines = notesText === "" ? 0 : notesText.split("\n").length;
      switch (action.kind) {
        case "close":
          onModeChange("list");
          setScrollTop(0);
          return;
        case "moveDown":
          setScrollTop((s) => clampScrollTop(s + 1, totalLines, VIEWPORT));
          return;
        case "moveUp":
          setScrollTop((s) => clampScrollTop(s - 1, totalLines, VIEWPORT));
          return;
        case "jumpTop":
          setScrollTop(0);
          return;
        case "jumpBottom":
          setScrollTop(clampScrollTop(totalLines, totalLines, VIEWPORT));
          return;
        case "pageDown":
          setScrollTop((s) =>
            clampScrollTop(s + Math.floor(VIEWPORT / (action.half ? 2 : 1)), totalLines, VIEWPORT),
          );
          return;
        case "pageUp":
          setScrollTop((s) =>
            clampScrollTop(s - Math.floor(VIEWPORT / (action.half ? 2 : 1)), totalLines, VIEWPORT),
          );
          return;
        case "yank": {
          if (!focused || !snapshot) return;
          void yank(`mu task notes ${focused.name} -w ${snapshot.workstreamName}`);
          return;
        }
        default:
          return;
      }
    }
    switch (action.kind) {
      case "close":
        onClose();
        return;
      case "drill":
        if (focused) {
          setScrollTop(0);
          onModeChange("drill");
        }
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
      </PopupShell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <PopupShell title={`Tasks · ${focused.name} (notes)`}>
        <DrillScrollView
          title={`mu task notes ${focused.name}`}
          body={notesText}
          viewport={VIEWPORT}
          scrollTop={scrollTop}
          emptyText="(no notes)"
        />
        <Box marginTop={1}>
          <Text dimColor>
            j/k scroll · Ctrl-D/U half page · y yanks `mu task notes` · Esc/q back to list
          </Text>
        </Box>
      </PopupShell>
    );
  }

  const rows = tasks.map((t) => [t.name, t.status, t.ownerName ?? "—", t.title]);
  const widths = layoutColumns(rows, COLUMN_SPECS);

  return (
    <PopupShell title={`Tasks · popup (${cursor + 1}/${tasks.length})`}>
      {tasks.map((t, i) => {
        const selected = i === cursor;
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const [name = "", status = "", owner = "", title = ""] = padded;
        return (
          <Box key={t.name}>
            <Text inverse={selected}>
              <Text bold>{name}</Text>
              {"  "}
              <Text dimColor>{status}</Text>
              {"  "}
              <Text dimColor>{owner}</Text>
              {"  "}
              <Text>{title}</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>Enter notes · y yanks the per-status `mu task …`</Text>
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
