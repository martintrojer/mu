// All-tasks popup (`t`). Keybind-only; no dashboard card slot.
//
// Read-only list/sort complement to the DAG popup: every task in the
// active workstream, filtered by task status (o/i/c/r/d), sorted by
// `s` through the same sort keys as `mu task list --sort`, Enter drills
// into TaskDetailDrill, and `y` yanks `mu task show <id>`.

import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type TaskRow, listTasks } from "../../../tasks.js";
import {
  TASK_SORT_KEYS,
  type TaskSortKey,
  relTimeBasisForSort,
  sortTasks,
} from "../../../tasks/sort.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { formatRoi } from "../format-helpers.js";
import { dispatchPopupKeyFromInk } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { StatusFilterStrip, useStatusFilter } from "../use-status-filter.js";
import { useDrillKeymap } from "./drill.js";
import { applyCursor, centredVisibleSlice, isNavAction } from "./scroll.js";
import { TaskDetailDrill, renderNotes } from "./task-detail.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  onFilterEditingChange?: (editing: boolean) => void;
  db: Db;
  workstream: string;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // task id
  { kind: "protect" }, // status
  { kind: "protect" }, // owner
  { kind: "protect", align: "right" }, // ROI
  { kind: "clip", min: 1 }, // title
];

const ALL_TASKS_COLORS = [
  { bold: true }, // id
  { dimColor: true }, // status
  { dimColor: true }, // owner
  { dimColor: true }, // ROI
  undefined, // title
] as const;

// The list view renders two extra in-body chrome rows above the data
// window: StatusFilterStrip + SortStrip. Account for those through
// the central viewport hook's chrome override so the popup's top
// border does not get clipped on shorter panes.
const ALL_TASKS_CHROME_ROWS = 5;

export function AllTasksPopup({
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
  const viewport = usePopupViewport(ALL_TASKS_CHROME_ROWS);
  const [cursor, setCursor] = useState(0);
  const [sortKey, setSortKey] = useState<TaskSortKey>("roi");
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });
  const statusFilter = useStatusFilter();

  const sourceTasks = useMemo(
    () => allTasksFromSnapshotOrDb(snapshot, db, workstream),
    [snapshot, db, workstream],
  );
  const visibleTasks = useMemo(() => {
    const filteredByStatus = sourceTasks.filter((t) => statusFilter.statuses.has(t.status));
    const filteredByText =
      mode === "drill"
        ? filteredByStatus
        : applyFilter(
            filteredByStatus,
            flt.query,
            (t) => `${t.name} ${t.title} ${t.status} ${t.ownerName ?? ""}`,
          );
    return sortTasks(filteredByText, sortKey);
  }, [sourceTasks, statusFilter.statuses, mode, flt.query, sortKey]);
  const safeCursor = visibleTasks.length === 0 ? 0 : Math.min(cursor, visibleTasks.length - 1);
  const focused = visibleTasks[safeCursor];

  const notesText = useMemo<string>(() => {
    if (mode !== "drill" || !focused) return "";
    return renderNotes(db, focused.name, workstream);
  }, [mode, focused, db, workstream]);

  const drill = useDrillKeymap({
    body: notesText,
    viewport,
    onClose: () => onModeChange("list"),
    onYank: () => {
      if (!focused) return;
      return yank(allTasksYankCommand(focused.name, workstream));
    },
  });

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    if (mode !== "drill" && statusFilter.onKey(input, key)) return;
    const action = dispatchPopupKeyFromInk(input, key);
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (isNavAction(action)) {
      setCursor((c) => applyCursor(c, action, visibleTasks.length, viewport));
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
        if (focused) onModeChange("drill");
        return;
      case "yank":
        if (focused) void yank(allTasksYankCommand(focused.name, workstream));
        return;
      case "verb":
        if (action.key === "s") setSortKey(nextTaskSortKey);
        return;
    }
  });

  if (snapshot === null) {
    return <PopupShell title="All tasks · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }

  if (sourceTasks.length === 0) {
    return (
      <PopupShell title="All tasks · popup">
        <Box flexDirection="column" flexGrow={1}>
          <StatusFilterStrip statuses={statusFilter.statuses} />
          <SortStrip sortKey={sortKey} visible={0} total={0} />
          <Text dimColor>(no tasks)</Text>
        </Box>
      </PopupShell>
    );
  }

  if (visibleTasks.length === 0) {
    return (
      <PopupShell title="All tasks · popup">
        <Box flexDirection="column" flexGrow={1}>
          <StatusFilterStrip statuses={statusFilter.statuses} />
          <SortStrip sortKey={sortKey} visible={0} total={sourceTasks.length} />
          <Text dimColor>
            {flt.query === ""
              ? "(no tasks match status filter)"
              : `(no matches for "${flt.query}")`}
          </Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <PopupShell title={`All tasks · ${focused.name} (notes)`}>
        <Box flexDirection="column" flexGrow={1}>
          <TaskDetailDrill
            task={focused}
            db={db}
            workstream={workstream}
            scrollTop={drill.scrollTop}
            viewport={viewport}
          />
        </Box>
      </PopupShell>
    );
  }

  const { start, visible: windowed } = centredVisibleSlice(visibleTasks, safeCursor, viewport);
  const rows = windowed.map((t) => [
    t.name,
    t.status,
    t.ownerName ?? "—",
    formatRoi(t.impact, t.effortDays),
    t.title,
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={allTasksListTitle(safeCursor, visibleTasks.length, viewport)}
      hint={focused ? allTasksYankCommand(focused.name, workstream) : undefined}
    >
      <Box flexDirection="column" flexGrow={1}>
        <StatusFilterStrip statuses={statusFilter.statuses} />
        <SortStrip sortKey={sortKey} visible={visibleTasks.length} total={sourceTasks.length} />
        {windowed.map((t, i) => {
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          return (
            <ListRow
              key={t.name}
              cells={padded}
              contentWidth={contentWidth}
              colors={ALL_TASKS_COLORS}
              selected={start + i === safeCursor}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
  );
}

export function allTasksFromSnapshotOrDb(
  snapshot: WorkstreamSnapshot | null,
  db: Db,
  workstream: string,
): TaskRow[] {
  if (snapshot?.allTasks && snapshot.allTasks.length > 0) return snapshot.allTasks;
  return listTasks(db, workstream);
}

export function allTasksYankCommand(taskId: string, workstream: string): string {
  return `mu task show ${taskId} -w ${workstream}`;
}

export function nextTaskSortKey(current: TaskSortKey): TaskSortKey {
  const i = TASK_SORT_KEYS.indexOf(current);
  return TASK_SORT_KEYS[(i + 1) % TASK_SORT_KEYS.length] ?? "roi";
}

export function sortIndicator(sortKey: TaskSortKey): string {
  const basis = relTimeBasisForSort(sortKey);
  const detail = basis === null ? "" : basis === "updatedAt" ? " updated" : " created";
  return `sort: [s]ort=${sortKey} ↓${detail}`;
}

export function allTasksScrollPercent(
  cursor: number,
  total: number,
  viewport: number,
): number | null {
  if (total <= viewport) return null;
  return Math.round((cursor / Math.max(1, total - 1)) * 100);
}

export function allTasksListTitle(cursor: number, total: number, viewport: number): string {
  const percent = allTasksScrollPercent(cursor, total, viewport);
  const indicator = percent === null ? "" : ` · ${percent}%`;
  return `All tasks · popup (${cursor + 1}/${total})${indicator}`;
}

function SortStrip({
  sortKey,
  visible,
  total,
}: { sortKey: TaskSortKey; visible: number; total: number }): JSX.Element {
  return (
    <Box>
      <Text dimColor>
        {sortIndicator(sortKey)} (filter: {visible} of {total})
      </Text>
    </Box>
  );
}
