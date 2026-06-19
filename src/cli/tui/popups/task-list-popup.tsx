// Shared task-list popup scaffold.
//
// Per finding_4_task_list_popups_duplicate: ready.tsx, inprogress.tsx,
// recent.tsx, and blocked.tsx all duplicated ~120 LOC of identical
// coordination logic — usePopupFilter + applyFilter, safeCursor,
// drilledTask pinning (bug_filter_drill_opens_wrong_task), useNotesDrill,
// useDrillKeymap, the dispatchListAction switch, useInput wiring, the
// three early-return states, and the drill branch. Only the source list,
// column specs, row mapper/colors, filter blob, yank command, and titles
// differed. This file centralises the orchestration shell so a behavioural
// fix lands once; each popup collapses to a config object.
//
// Pure dedup — no new surface, identical behaviour.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import type { TaskRow } from "../../../tasks.js";
import { type ColumnSpec, contentWidthFromCols, layoutColumns, renderRow } from "../columns.js";
import { type PopupAction, type PopupActionEnvelope, dispatchPopupKeyFromInk } from "../keys.js";
import { type CellColor, ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
import { useNotesDrill } from "../use-notes-drill.js";
import { usePopupActionQueue } from "../use-popup-action-queue.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { useTerminalSize } from "../use-terminal-size.js";
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
  popupActions?: readonly PopupActionEnvelope[];
  db: Db;
  workstream: string;
}

/** Rendered cells + per-cell colours for a single list row. */
export interface RenderedRow {
  cells: ReadonlyArray<string>;
  colors: ReadonlyArray<CellColor | undefined>;
}

/**
 * Per-popup configuration. The shared scaffold reads these to wire the
 * source list, column layout, row rendering, filter blob, list-mode yank,
 * and the various title/empty strings. `now`/`ages` precompute is left to
 * the caller via the rows closure receiving the visible slice.
 */
export interface TaskListPopupConfig {
  /** Short popup name used in every title (e.g. "Tasks", "In-progress"). */
  label: string;
  /** Source rows selector (e.g. snapshot.ready). Null snapshot → []. */
  sourceTasks: (snapshot: WorkstreamSnapshot) => readonly TaskRow[];
  /** Column layout spec. */
  columnSpecs: ReadonlyArray<ColumnSpec>;
  /** Search blob for the '/' filter. */
  filterBlob: (task: TaskRow) => string;
  /**
   * Map the visible slice (already sliced + cursor-centred) to rendered
   * rows. Given the visible tasks, their absolute start index, and the
   * snapshot so callers can resolve agent display names / per-row reads.
   */
  renderRows: (
    visible: readonly TaskRow[],
    start: number,
    snapshot: WorkstreamSnapshot,
  ) => RenderedRow[];
  /** List-mode yank command for the focused row (null → no yank). */
  yankCommand: (task: TaskRow, workstream: string) => string | null;
  /** Text for the empty-source early return. */
  emptyText: string;
  /** Optional static hint for the list shell. */
  hint?: string;
  /**
   * Optional dynamic hint computed from the focused row + workstream
   * (e.g. ReadyPopup mirrors the yank command into the shell hint).
   */
  dynamicHint?: (focused: TaskRow, workstream: string) => string | null;
}

/**
 * Shared scaffold for the task-list popup family. Owns all the
 * coordination logic; per-popup behaviour comes entirely from `config`.
 */
export function TaskListPopup({
  config,
  yank,
  onClose,
  snapshot,
  fastTickNonce,
  mode,
  onModeChange,
  onFilterEditingChange,
  popupActions,
  db,
  workstream,
}: PopupProps & { config: TaskListPopupConfig }): JSX.Element {
  const { cols } = useTerminalSize();
  const contentWidth = contentWidthFromCols(cols);
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });

  const sourceTasks = snapshot ? config.sourceTasks(snapshot) : [];
  // Per bug_filter_drill_opens_wrong_task: filter applied UNIFORMLY
  // across list and drill modes (a mode-conditional dropped the filter
  // on drill, shifting `tasks` under a constant cursor index).
  const tasks = applyFilter(sourceTasks, flt.query, config.filterBlob);
  const safeCursor = tasks.length === 0 ? 0 : Math.min(cursor, tasks.length - 1);
  const focused = tasks[safeCursor];

  // Defensive: capture the focused task identity at the moment Enter is
  // pressed so the drill stays pinned even if `tasks` shifts.
  const [drilledTask, setDrilledTask] = useState<TaskRow | null>(null);
  const drillTask = mode === "drill" ? (drilledTask ?? focused) : focused;

  const notesText = useNotesDrill({ mode, focused: drillTask, db, workstream, fastTickNonce });

  const drill = useDrillKeymap({
    body: notesText,
    viewport,
    onClose: () => {
      setDrilledTask(null);
      onModeChange("list");
    },
    onYank: () => {
      if (!drillTask || !snapshot) return;
      return yank(`mu task notes ${drillTask.name} -w ${snapshot.workstreamName}`);
    },
    resetKey: drillTask?.name ?? "",
  });

  const dispatchListAction = (action: PopupAction) => {
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (action.kind === "setCursor" || isNavAction(action)) {
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
          setDrilledTask(focused);
          onModeChange("drill");
        }
        return;
      case "yank": {
        const t = tasks[safeCursor];
        if (!t || !snapshot) return;
        const cmd = config.yankCommand(t, snapshot.workstreamName);
        if (cmd) void yank(cmd);
        return;
      }
    }
  };

  usePopupActionQueue(popupActions, dispatchListAction);

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    dispatchListAction(dispatchPopupKeyFromInk(input, key));
  });

  if (snapshot === null) {
    return (
      <PopupShell title={`${config.label} · popup`}>{<Text dimColor>loading…</Text>}</PopupShell>
    );
  }
  if (sourceTasks.length === 0) {
    return (
      <PopupShell title={`${config.label} · popup`}>
        <Text dimColor>{config.emptyText}</Text>
      </PopupShell>
    );
  }
  if (tasks.length === 0) {
    return (
      <PopupShell title={`${config.label} · popup`}>
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && drillTask) {
    return (
      <PopupShell title={`${config.label} · ${drillTask.name} (notes)`}>
        <Box flexDirection="column" flexGrow={1}>
          <TaskDetailDrill
            task={drillTask}
            db={db}
            workstream={workstream}
            scrollTop={drill.scrollTop}
            viewport={viewport}
            tickNonce={fastTickNonce}
            body={notesText}
            wrappedBody={drill.wrappedBody}
          />
        </Box>
      </PopupShell>
    );
  }

  const { start, visible } = centredVisibleSlice(tasks, safeCursor, viewport);
  const rendered = config.renderRows(visible, start, snapshot);
  const rowCells = rendered.map((r) => r.cells);
  const widths = layoutColumns(rowCells, config.columnSpecs, contentWidth);

  const dynamicHint =
    focused && config.dynamicHint
      ? (config.dynamicHint(focused, snapshot.workstreamName) ?? undefined)
      : undefined;

  return (
    <PopupShell
      title={`${config.label} · popup (${safeCursor + 1}/${tasks.length})`}
      hint={dynamicHint ?? config.hint}
    >
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((t, i) => {
          const selected = start + i === safeCursor;
          const r = rendered[i];
          if (r === undefined) return null;
          const padded = renderRow(r.cells, widths, config.columnSpecs);
          return (
            <ListRow
              key={t.name}
              cells={padded}
              contentWidth={contentWidth}
              colors={r.colors}
              selected={selected}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
  );
}
