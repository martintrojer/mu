// Recent popup (Shift+8 → `*`). The drill-down for the Recent card.
//
// Per feat_popup_8_recent (workstream `tui-impl`). Sibling of
// popups/inprogress.tsx and popups/ready.tsx — list of recently
// CLOSED tasks with j/k nav, '/' substring filter, y to yank
// `mu task open <id> -w <ws>` (re-open is the typical act-intent
// for a recently-closed task per the popups/ready.tsx CLOSED
// branch of the yank matrix), and Enter to chain into the shared
// TaskDetailDrill leaf (the recursion contract from
// feat_track_drill_chains_to_task_drill — rows ARE tasks).
//
// Column shape mirrors Card 8 (cards/recent.tsx) but adds two
// columns the card was too narrow to fit:
//   glyph   id   STATUS   closed-at   impact   effort   ROI   title
// Per feat_column_aligned_lists clipping policy: every cell except
// `title` is identity-bearing and PROTECTED; only `title` is
// CLIPPABLE. Wider title column than the card (more pixels here).
//
// All coordination logic lives in the shared TaskListPopup scaffold
// (popups/task-list-popup.tsx); this file is the Recent config.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { inkColorForStatus } from "../../format.js";
import { glyphFor } from "../cards/recent.js";
import type { ColumnSpec } from "../columns.js";
import { ageMs, formatRoi, formatWhen } from "../format-helpers.js";
import {
  type PopupProps,
  type RenderedRow,
  TaskListPopup,
  type TaskListPopupConfig,
} from "./task-list-popup.js";

// Re-exported for test back-compat (test/tui-popup-recent.test.ts
// imports `formatRoi` from this module). Single source of truth lives
// in ../format-helpers.ts.
export { formatRoi };

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // task id
  { kind: "protect" }, // status (always CLOSED; constant for now)
  { kind: "protect", align: "right" }, // closed-at (relative-time token)
  { kind: "protect", align: "right" }, // impact
  { kind: "protect", align: "right" }, // effort
  { kind: "protect", align: "right" }, // ROI label
  { kind: "clip", min: 1 }, // title
];

const config: TaskListPopupConfig = {
  label: "Recent",
  sourceTasks: (snapshot) => snapshot.recentClosed,
  columnSpecs: COLUMN_SPECS,
  // Per spec MATCHING RULES: search blob is `${id} ${title} ${owner ?? ""}`.
  filterBlob: (t) => `${t.name} ${t.title} ${t.ownerName ?? ""}`,
  emptyText: "(none recently closed)",
  yankCommand: (t, ws) => yankCommandForTask(t.name, ws),
  hint: "Enter notes · y yanks `mu task open` · / filter · Esc/q close",
  renderRows: (visible): RenderedRow[] => {
    const now = Date.now();
    return visible.map((t) => ({
      cells: [
        glyphFor(),
        t.name,
        t.status,
        formatWhen(ageMs(t, now)),
        String(t.impact),
        String(t.effortDays),
        formatRoi(t.impact, t.effortDays),
        t.title,
      ],
      colors: [
        { color: "green" }, // glyph
        { bold: true }, // id
        { color: inkColorForStatus(t.status) }, // status
        { dimColor: true }, // when
        { dimColor: true }, // impact
        { dimColor: true }, // effort
        { dimColor: true }, // roi
        undefined, // title
      ],
    }));
  },
};

export function RecentPopup(props: PopupProps): JSX.Element {
  return <TaskListPopup config={config} {...props} />;
}

/**
 * Yank command for a recently-CLOSED task row. The most likely
 * act-intent on the Recent popup is re-opening the task (per the
 * popups/ready.tsx CLOSED branch of the yank matrix: `mu task open
 * <id> -w <ws>`). Stays consistent so the operator's muscle memory
 * transfers across popups. Pure; exported for unit tests.
 */
export function yankCommandForTask(taskName: string, workstream: string): string {
  return `mu task open ${taskName} -w ${workstream}`;
}
