// Full task-DAG popup (`g`). Keybind-only; no dashboard card slot.
//
// Read-only forest of the current workstream: every root task (no
// incoming blocks edge) is rendered with the same ASCII tree machinery
// as `mu task tree --down`, separated by blank lines. No card owns this
// popup; it is a dashboard-level graph affordance for large workstreams.

import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";
import { loadFullDag, renderForest } from "../../../dag.js";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import type { TaskStatus } from "../../../tasks/status.js";
import { colorStatus } from "../../format.js";
import { contentWidthFromCols, termColsForLayout, truncateCell } from "../columns.js";
import { dispatchPopupKeyFromInk } from "../keys.js";
import { PopupShell } from "../popup-shell.js";
import { StatusFilterStrip, useStatusFilter } from "../use-status-filter.js";
import { DrillScrollView, useDrillKeymap } from "./drill.js";
import { applyScroll, isNavAction } from "./scroll.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  fastTickNonce: number;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  onFilterEditingChange?: (editing: boolean) => void;
  db: Db;
  workstream: string;
}

interface DagBody {
  body: string;
  roots: string[];
}

export function DagPopup({
  yank,
  onClose,
  db,
  workstream,
  fastTickNonce,
}: PopupProps): JSX.Element {
  const viewport = usePopupViewport();
  const statusFilter = useStatusFilter();
  const contentWidth = contentWidthFromCols(termColsForLayout());
  const { body, roots } = useMemo<DagBody>(() => {
    void fastTickNonce;
    return buildDagBody(db, workstream, statusFilter.statuses, contentWidth);
  }, [db, workstream, statusFilter.statuses, contentWidth, fastTickNonce]);
  const [focusedRoot, setFocusedRoot] = useState<string | null>(() => roots[0] ?? null);
  const focusedTask = focusedRoot !== null && roots.includes(focusedRoot) ? focusedRoot : roots[0];
  const drill = useDrillKeymap({
    body,
    viewport,
    onClose: () => {},
    onYank: () => {
      if (focusedTask === undefined) return;
      return yank(dagYankCommand(focusedTask, workstream));
    },
    resetKey: workstream,
  });

  const lineToRoot = useMemo(
    () => rootForBodyLines(drill.wrappedLines, roots),
    [drill.wrappedLines, roots],
  );

  useInput((input, key) => {
    if (statusFilter.onKey(input, key)) return;
    const action = dispatchPopupKeyFromInk(input, key);
    const before = drill.scrollTop;
    drill.dispatch(action);
    switch (action.kind) {
      case "close":
        onClose();
        return;
      default:
        break;
    }

    // Simplified yank focus: track the root whose header is at or
    // before the current top line (or first root). This keeps the
    // command useful without cursor-row plumbing in the text drill.
    if (isNavAction(action)) {
      const nextTop = applyScroll(before, action, drill.totalLines, viewport);
      setFocusedRoot(lineToRoot[nextTop] ?? roots[0] ?? null);
    }
  });

  if (roots.length === 0) {
    return (
      <PopupShell title={`DAG · ${workstream}`}>
        <Box flexDirection="column" flexGrow={1}>
          <StatusFilterStrip statuses={statusFilter.statuses} />
          <Text dimColor>(no tasks)</Text>
        </Box>
      </PopupShell>
    );
  }

  return (
    <PopupShell title={`DAG · ${workstream}`} hint="y yanks `mu task tree <root-id>`">
      <Box flexDirection="column" flexGrow={1}>
        <StatusFilterStrip statuses={statusFilter.statuses} />
        <DrillScrollView
          title="task DAG forest"
          body={body}
          viewport={viewport}
          scrollTop={drill.scrollTop}
          wrappedBody={drill.wrappedBody}
          emptyText="(no tasks)"
          hint="y yanks `mu task tree <root-id>`"
        />
      </Box>
    </PopupShell>
  );
}

export function dagYankCommand(taskId: string, workstream: string): string {
  return `mu task tree ${taskId} -w ${workstream}`;
}

export function buildDagBody(
  db: Db,
  workstream: string,
  statuses: ReadonlySet<TaskStatus>,
  contentWidth: number = contentWidthFromCols(termColsForLayout()),
): DagBody {
  const dag = loadFullDag(db, workstream, { statuses });
  const body = renderForest(dag.roots, dag.edges, (task) => colorStatus(task.status), dag.tasks, {
    includeTitle: false,
  });
  return {
    body: truncateDagBody(body, contentWidth),
    roots: dag.roots.map((t) => t.name),
  };
}

export function truncateDagBody(body: string, contentWidth: number): string {
  const width = Math.max(0, contentWidth - 1);
  return body
    .split("\n")
    .map((line) => truncateCell(line, width))
    .join("\n");
}

function rootForBodyLines(lines: readonly string[], roots: readonly string[]): string[] {
  const rootSet = new Set(roots);
  const out: string[] = [];
  let current = roots[0] ?? "";
  for (const line of lines) {
    const maybeRoot = line.split(/\s+/)[0];
    if (maybeRoot !== undefined && rootSet.has(maybeRoot)) current = maybeRoot;
    out.push(current);
  }
  return out;
}
