// All-tasks popup (`t`). Keybind-only; no dashboard card slot.
//
// Read-only list/sort complement to the DAG popup: every task in the
// active workstream, filtered by task status (o/i/c/r/d), sorted by
// `s` through the same sort keys as `mu task list --sort`, Enter drills
// into TaskDetailDrill, and `y` yanks `mu task show <id>`.

import { Box, Text, useInput, useStdout } from "ink";
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
import { inkColorForStatus } from "../../format.js";
import { agentByName, formatAgentRefDisplayName } from "../agent-display.js";
import { type ColumnSpec, contentWidthFromCols, layoutColumns, renderRow } from "../columns.js";
import { formatRoi } from "../format-helpers.js";
import { type PopupAction, type PopupActionEnvelope, dispatchPopupKeyFromInk } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
import { useNotesDrill } from "../use-notes-drill.js";
import { usePopupActionQueue } from "../use-popup-action-queue.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { StatusFilterStrip, useStatusFilter } from "../use-status-filter.js";
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
  onFilterEditingChange?: (editing: boolean) => void;
  popupActions?: readonly PopupActionEnvelope[];
  db: Db;
  workstream: string;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // task id
  { kind: "protect" }, // status + blocked glyph
  { kind: "protect" }, // owner
  { kind: "protect", align: "right" }, // ROI
  { kind: "clip", min: 1 }, // title
];

// The list view renders two extra in-body chrome rows above the data
// window: StatusFilterStrip + SortStrip. Account for those through
// the central viewport hook's chrome override so the popup's top
// border does not get clipped on shorter panes.
const ALL_TASKS_CHROME_ROWS = 6;

export function AllTasksPopup({
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
}: PopupProps): JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const contentWidth = contentWidthFromCols(cols);
  const viewport = usePopupViewport(ALL_TASKS_CHROME_ROWS);
  const [cursor, setCursor] = useState(0);
  const [sortKey, setSortKey] = useState<TaskSortKey>("roi");
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });
  const statusFilter = useStatusFilter();

  const sourceTasks = useMemo(
    () => allTasksFromSnapshotOrDb(snapshot, db, workstream),
    [snapshot, db, workstream],
  );
  const blockedNames = useMemo(
    () => new Set((snapshot?.blocked ?? []).map((t) => t.name)),
    [snapshot?.blocked],
  );
  const [blockedFilter, setBlockedFilter] = useState<BlockedFilterMode>("all");
  // Per bug_filter_drill_opens_wrong_task: text filter applied
  // UNIFORMLY across list and drill modes. The previous
  // mode-conditional dropped the filter on drill, which shifted
  // visibleTasks under a constant cursor index and resolved the
  // wrong task. mode dep removed.
  const visibleTasks = useMemo(() => {
    const filteredByStatus = sourceTasks.filter((t) => statusFilter.statuses.has(t.status));
    const filteredByBlocked = applyBlockedFilter(filteredByStatus, blockedNames, blockedFilter);
    const filteredByText = applyFilter(
      filteredByBlocked,
      flt.query,
      (t) => `${t.name} ${t.title} ${t.status} ${t.ownerName ?? ""}`,
    );
    return sortTasks(filteredByText, sortKey);
  }, [sourceTasks, statusFilter.statuses, blockedFilter, blockedNames, flt.query, sortKey]);
  const safeCursor = visibleTasks.length === 0 ? 0 : Math.min(cursor, visibleTasks.length - 1);
  const focused = visibleTasks[safeCursor];

  // Defensive: capture the focused task identity at the moment the
  // user pressed Enter, so even if visibleTasks shifts underneath us
  // (a future refactor re-introduces a mode-dep, snapshot tick lands
  // a new row, etc.) the drill stays pinned to the row the user
  // visually selected. Cleared on close.
  const [drilledTask, setDrilledTask] = useState<TaskRow | null>(null);
  const drillTask = mode === "drill" ? (drilledTask ?? focused) : focused;

  const notesText = useNotesDrill({
    mode,
    focused: drillTask,
    db,
    workstream,
    fastTickNonce,
  });

  const drill = useDrillKeymap({
    body: notesText,
    viewport,
    onClose: () => {
      setDrilledTask(null);
      onModeChange("list");
    },
    onYank: () => {
      if (!drillTask) return;
      return yank(allTasksYankCommand(drillTask.name, workstream));
    },
    resetKey: drillTask?.name ?? "",
  });

  const dispatchListAction = (action: PopupAction) => {
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (action.kind === "setCursor" || isNavAction(action)) {
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
        if (focused) {
          setDrilledTask(focused);
          onModeChange("drill");
        }
        return;
      case "yank":
        if (focused) void yank(allTasksYankCommand(focused.name, workstream));
        return;
      case "verb":
        if (action.key === "s") setSortKey(nextTaskSortKey);
        return;
    }
  };

  usePopupActionQueue(popupActions, dispatchListAction);

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    if (mode !== "drill" && statusFilter.onKey(input, key)) return;
    // b toggles blocked filter — intercept before generic popup dispatch
    if (mode !== "drill" && !key.ctrl && !key.meta && input === "b") {
      setBlockedFilter(nextBlockedFilter);
      return;
    }
    dispatchListAction(dispatchPopupKeyFromInk(input, key));
  });

  if (snapshot === null) {
    return <PopupShell title="All tasks · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }

  if (sourceTasks.length === 0) {
    return (
      <PopupShell title="All tasks · popup">
        <Box flexDirection="column" flexGrow={1}>
          <StatusFilterStrip statuses={statusFilter.statuses} />
          <BlockedFilterStrip mode={blockedFilter} />
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
          <BlockedFilterStrip mode={blockedFilter} />
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

  if (mode === "drill" && drillTask) {
    return (
      <PopupShell title={`All tasks · ${drillTask.name} (notes)`}>
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

  const { start, visible: windowed } = centredVisibleSlice(visibleTasks, safeCursor, viewport);
  const agentLookup = agentByName(snapshot);
  const rows = windowed.map((t) => [
    t.name,
    blockedNames.has(t.name) ? `${t.status} ⛓` : t.status,
    formatAgentRefDisplayName(t.ownerName, agentLookup),
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
        <BlockedFilterStrip mode={blockedFilter} />
        <SortStrip sortKey={sortKey} visible={visibleTasks.length} total={sourceTasks.length} />
        {windowed.map((t, i) => {
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const isBlocked = blockedNames.has(t.name);
          const colors = [
            { bold: true }, // id
            { color: isBlocked ? "yellow" : inkColorForStatus(t.status) }, // status + blocked glyph
            { dimColor: true }, // owner
            { dimColor: true }, // ROI
            undefined, // title
          ];
          return (
            <ListRow
              key={t.name}
              cells={padded}
              contentWidth={contentWidth}
              colors={colors}
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

// ─── Blocked filter ───────────────────────────────────────────────

export type BlockedFilterMode = "all" | "only" | "hide";

export function nextBlockedFilter(current: BlockedFilterMode): BlockedFilterMode {
  switch (current) {
    case "all":
      return "only";
    case "only":
      return "hide";
    case "hide":
      return "all";
  }
}

export function applyBlockedFilter<T extends { name: string }>(
  tasks: T[],
  blockedNames: ReadonlySet<string>,
  mode: BlockedFilterMode,
): T[] {
  switch (mode) {
    case "all":
      return tasks;
    case "only":
      return tasks.filter((t) => blockedNames.has(t.name));
    case "hide":
      return tasks.filter((t) => !blockedNames.has(t.name));
  }
}

const BLOCKED_FILTER_LABELS: Readonly<Record<BlockedFilterMode, string>> = {
  all: "all",
  only: "only blocked",
  hide: "hide blocked",
};

function BlockedFilterStrip({ mode }: { mode: BlockedFilterMode }): JSX.Element {
  return (
    <Box>
      <Text dimColor>
        [<Text bold>b</Text>]locked: {BLOCKED_FILTER_LABELS[mode]}
        {mode === "all" ? "" : " ●"}
      </Text>
    </Box>
  );
}
