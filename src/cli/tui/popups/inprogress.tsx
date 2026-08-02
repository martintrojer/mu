// In-progress popup (Shift+6 → `^`). The drill-down for the
// In-progress card.
//
// Per feat_popup_6_inprogress (workstream `tui-impl`). Sibling of
// popups/ready.tsx — list of IN_PROGRESS tasks with j/k nav, '/'
// substring filter, y to yank `mu task close <id> --evidence "..."`,
// and Enter to chain into the shared TaskDetailDrill leaf (the
// recursion contract from feat_track_drill_chains_to_task_drill —
// rows ARE tasks).
//
// Column shape mirrors Card 6 (cards/inprogress.tsx) but adds two
// columns the card was too narrow to fit:
//   glyph   id   STATUS   owner   since-claim   ROI   title
// Per feat_column_aligned_lists clipping policy: every cell except
// `title` is identity-bearing and PROTECTED; only `title` is
// CLIPPABLE. Wider title column than the card (more pixels here).
//
// All coordination logic lives in the shared TaskListPopup scaffold
// (popups/task-list-popup.tsx); this file is the In-progress config.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import type { ReactElement } from "react";
import { inkColorForStatus } from "../../format.js";
import { agentByName, formatAgentRefDisplayName } from "../agent-display.js";
import { glyphFor, isStale } from "../cards/inprogress.js";
import type { ColumnSpec } from "../columns.js";
import { ageMs, formatRoi, formatSinceClaim } from "../format-helpers.js";
import {
  type PopupProps,
  type RenderedRow,
  TaskListPopup,
  type TaskListPopupConfig,
} from "./task-list-popup.js";

// Re-exported for test back-compat (test/tui-popup-inprogress.test.ts
// imports `formatRoi` from this module). Single source of truth lives
// in ../format-helpers.ts.
export { formatRoi };

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // task id
  { kind: "protect" }, // status (always IN_PROGRESS; constant for now)
  { kind: "protect" }, // owner (or "—")
  { kind: "protect", align: "right" }, // since-claim
  { kind: "protect", align: "right" }, // ROI label
  { kind: "clip", min: 1 }, // title
];

const config: TaskListPopupConfig = {
  label: "In-progress",
  sourceTasks: (snapshot) => snapshot.inProgress,
  columnSpecs: COLUMN_SPECS,
  // Per spec MATCHING RULES: search blob is `${id} ${title} ${owner ?? ""}`.
  filterBlob: (t) => `${t.name} ${t.title} ${t.ownerName ?? ""}`,
  emptyText: "(none in progress)",
  yankCommand: (t, ws) => yankCommandForTask(t.name, ws),
  hint: "y yanks `mu task close <id> --evidence ...`",
  renderRows: (visible, _start, snapshot): RenderedRow[] => {
    const now = Date.now();
    const agentLookup = agentByName(snapshot);
    return visible.map((t) => {
      const age = ageMs(t, now);
      const stale = isStale(age);
      return {
        cells: [
          glyphFor(),
          t.name,
          t.status,
          formatAgentRefDisplayName(t.ownerName, agentLookup),
          formatSinceClaim(age),
          formatRoi(t.impact, t.effortDays),
          t.title,
        ],
        colors: [
          { color: "yellow" }, // glyph
          { bold: true }, // id
          { color: inkColorForStatus(t.status) }, // status
          { dimColor: true }, // owner
          stale ? { color: "yellow" } : { dimColor: true }, // since-claim
          { dimColor: true }, // roi
          undefined, // title
        ],
      };
    });
  },
};

export function InProgressPopup(props: PopupProps): ReactElement {
  return <TaskListPopup config={config} {...props} />;
}

/**
 * Yank command for an IN_PROGRESS task row. The most likely
 * act-intent on the In-progress popup is closing the task with
 * grounding evidence (per the Tasks-popup yank matrix, `mu task
 * close <id> -w <ws> --evidence "..."` is the canonical
 * IN_PROGRESS verb). Stays consistent with popups/ready.tsx so the
 * operator's muscle memory transfers across popups. Pure; exported
 * for unit tests.
 */
export function yankCommandForTask(taskName: string, workstream: string): string {
  return `mu task close ${taskName} -w ${workstream} --evidence "..."`;
}
