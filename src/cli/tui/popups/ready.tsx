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
import { useEffect, useMemo, useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { dispatchPopupKey } from "../keys.js";
import { TitledBox } from "../titled-box.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { CursorRow } from "./cursor-row.js";
import { clampScrollTop } from "./drill.js";
import { TaskDetailDrill, renderNotes } from "./task-detail.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
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
  const [scrollTop, setScrollTop] = useState(0);
  const flt = usePopupFilter();
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
  useEffect(() => {
    onFilterEditingChange?.(flt.editing);
  }, [flt.editing, onFilterEditingChange]);

  // Resolve notes for the focused task on demand. Memoised on
  // (taskId, mode); we only hit SQLite when actually drilled in.
  // Identical to the TaskDetailDrill render path — we duplicate the
  // call here only because the keymap needs `totalLines` to clamp
  // scroll. The shared formatter (renderNotes) is the single source
  // of truth.
  const notesText = useMemo<string>(() => {
    if (mode !== "drill" || !focused) return "";
    return renderNotes(db, focused.name, workstream);
  }, [mode, focused, db, workstream]);

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
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
          setScrollTop((s) => clampScrollTop(s + 1, totalLines, viewport));
          return;
        case "moveUp":
          setScrollTop((s) => clampScrollTop(s - 1, totalLines, viewport));
          return;
        case "jumpTop":
          setScrollTop(0);
          return;
        case "jumpBottom":
          setScrollTop(clampScrollTop(totalLines, totalLines, viewport));
          return;
        case "pageDown":
          setScrollTop((s) =>
            clampScrollTop(s + Math.floor(viewport / (action.half ? 2 : 1)), totalLines, viewport),
          );
          return;
        case "pageUp":
          setScrollTop((s) =>
            clampScrollTop(s - Math.floor(viewport / (action.half ? 2 : 1)), totalLines, viewport),
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
      case "filter":
        flt.startEdit();
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
            scrollTop={scrollTop}
            viewport={viewport}
          />
        </Box>
      </PopupShell>
    );
  }

  const rows = tasks.map((t) => [t.name, t.status, t.ownerName ?? "—", t.title]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Tasks · popup (${safeCursor + 1}/${tasks.length})`}
      hint={focused && snapshot ? yankCommandForTask(focused, snapshot.workstreamName) : undefined}
    >
      <Box flexDirection="column" flexGrow={1}>
        {tasks.map((t, i) => {
          const selected = i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          if (selected)
            return <CursorRow key={t.name} cells={padded} contentWidth={contentWidth} />;
          const [name = "", status = "", owner = "", title = ""] = padded;
          return (
            <Box key={t.name}>
              <Text wrap="truncate">
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
      </Box>
      <FilterPrompt state={flt} />
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
  hint,
  children,
}: {
  title: string;
  /** Per-popup hint inset into the bottom border (Layer 1 of
   *  nit_tui_drill_inset_title_and_hints). The Tasks popup's hint
   *  is the resolved yank-matrix recipe for the focused row; null
   *  / undefined → no bottom-label render (drill-mode passes
   *  undefined and Layer 2's DrillScrollView carries its own
   *  bottomLabel). */
  hint?: string | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <TitledBox
      title={title}
      borderColor="cyan"
      titleColor="cyan"
      bottomLabel={hint ?? undefined}
      flexGrow={1}
    >
      {children}
    </TitledBox>
  );
}
