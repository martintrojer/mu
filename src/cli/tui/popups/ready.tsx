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
import { useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { inkColorForStatus } from "../../format.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { dispatchPopupKeyFromInk } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
import { useNotesDrill } from "../use-notes-drill.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { useDrillKeymap } from "./drill.js";
import { applyCursor, centredVisibleSlice, isNavAction } from "./scroll.js";
import { TaskDetailDrill } from "./task-detail.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  fastTickNonce: number;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  /** Bubbles the filter-prompt edit state up to <App> for StatusBar mode. */
  onFilterEditingChange?: (editing: boolean) => void;
  db: Db;
  workstream: string;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // task name
  { kind: "protect" }, // status
  { kind: "protect" }, // owner (or "—")
  { kind: "clip", min: 1 }, // title
];

export function ReadyPopup({
  yank,
  onClose,
  snapshot,
  fastTickNonce,
  mode,
  onModeChange,
  onFilterEditingChange,
  db,
  workstream,
}: PopupProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  // Per-render viewport from stdout.rows minus the popup chrome budget;
  // see popups/viewport.ts. Replaces the prior hardcoded VIEWPORT = 20.
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });
  const sourceTasks = snapshot ? [...snapshot.ready, ...snapshot.inProgress] : [];
  const tasks =
    mode === "drill"
      ? sourceTasks
      : applyFilter(
          sourceTasks,
          flt.query,
          (t) => `${t.name} ${t.title} ${t.status} ${t.ownerName ?? ""}`,
        );
  const safeCursor = tasks.length === 0 ? 0 : Math.min(cursor, tasks.length - 1);
  const focused = tasks[safeCursor];

  const notesText = useNotesDrill({ mode, focused, db, workstream, fastTickNonce });

  const drill = useDrillKeymap({
    body: notesText,
    viewport,
    onClose: () => onModeChange("list"),
    onYank: () => {
      if (!focused || !snapshot) return;
      return yank(`mu task notes ${focused.name} -w ${snapshot.workstreamName}`);
    },
  });

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    const action = dispatchPopupKeyFromInk(input, key);
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (isNavAction(action)) {
      setCursor((c) => applyCursor(c, action, tasks.length, viewport));
      return;
    }
    switch (action.kind) {
      case "close":
        onClose();
        return;
      case "filter":
        flt.startEdit();
        return;
      case "drill":
        if (focused) {
          onModeChange("drill");
        }
        return;
      case "yank": {
        const t = tasks[safeCursor];
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
  if (sourceTasks.length === 0) {
    return (
      <PopupShell title="Tasks · popup">
        <Text dimColor>(no open / in-progress tasks)</Text>
      </PopupShell>
    );
  }
  if (tasks.length === 0) {
    return (
      <PopupShell title="Tasks · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <PopupShell title={`Tasks · ${focused.name} (notes)`}>
        <Box flexDirection="column" flexGrow={1}>
          <TaskDetailDrill
            task={focused}
            db={db}
            workstream={workstream}
            scrollTop={drill.scrollTop}
            viewport={viewport}
            tickNonce={fastTickNonce}
          />
        </Box>
      </PopupShell>
    );
  }

  const { start, visible } = centredVisibleSlice(tasks, safeCursor, viewport);
  const rows = visible.map((t) => [t.name, t.status, t.ownerName ?? "—", t.title]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Tasks · popup (${safeCursor + 1}/${tasks.length})`}
      hint={focused && snapshot ? yankCommandForTask(focused, snapshot.workstreamName) : undefined}
    >
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((t, i) => {
          const selected = start + i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const colors = [
            { bold: true }, // name
            { color: inkColorForStatus(t.status) }, // status
            { dimColor: true }, // owner
            undefined, // title
          ];
          return (
            <ListRow
              key={t.name}
              cells={padded}
              contentWidth={contentWidth}
              colors={colors}
              selected={selected}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
  );
}

export function yankCommandForTask(
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
