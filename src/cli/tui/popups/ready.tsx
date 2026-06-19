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
// All coordination logic (filter, drill pinning, yank wiring, the
// early-return states) lives in the shared TaskListPopup scaffold
// (popups/task-list-popup.tsx). This file is the Ready config: source
// list, column specs, row mapper/colors, and the yank matrix.

import { inkColorForStatus } from "../../format.js";
import { agentByName, formatAgentRefDisplayName } from "../agent-display.js";
import type { ColumnSpec } from "../columns.js";
import {
  type PopupProps,
  type RenderedRow,
  TaskListPopup,
  type TaskListPopupConfig,
} from "./task-list-popup.js";

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // task name
  { kind: "protect" }, // status
  { kind: "protect" }, // owner (or "—")
  { kind: "clip", min: 1 }, // title
];

const config: TaskListPopupConfig = {
  label: "Tasks",
  sourceTasks: (snapshot) => [...snapshot.ready, ...snapshot.inProgress],
  columnSpecs: COLUMN_SPECS,
  filterBlob: (t) => `${t.name} ${t.title} ${t.status} ${t.ownerName ?? ""}`,
  emptyText: "(no open / in-progress tasks)",
  yankCommand: (t, ws) => yankCommandForTask(t, ws),
  dynamicHint: (focused, ws) => yankCommandForTask(focused, ws),
  renderRows: (visible, _start, snapshot): RenderedRow[] => {
    const agentLookup = agentByName(snapshot);
    return visible.map((t) => ({
      cells: [t.name, t.status, formatAgentRefDisplayName(t.ownerName, agentLookup), t.title],
      colors: [
        { bold: true }, // name
        { color: inkColorForStatus(t.status) }, // status
        { dimColor: true }, // owner
        undefined, // title
      ],
    }));
  },
};

export function ReadyPopup(props: PopupProps): JSX.Element {
  return <TaskListPopup config={config} {...props} />;
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
