// Blocked popup (Shift+7 → `&`). The drill-down for the Blocked
// card.
//
// Per feat_popup_7_blocked (workstream `tui-impl`): list of every
// blocked task (OPEN with at least one still-gating blocker) with
// j/k navigation, '/' filter (via use-popup-filter), and Enter to
// drill into the standard TaskDetailDrill leaf — rows ARE tasks so
// the popup-drill recursion contract applies for free
// (feat_track_drill_chains_to_task_drill).
//
// Sibling of the task-list popup family (ready/inprogress/recent),
// all of which share the TaskListPopup scaffold
// (popups/task-list-popup.tsx). The Blocked config differs in three
// ways:
//
//   1. Source rows are `snapshot.blocked` (the OPEN-with-unsatisfied-
//      blockers slice).
//   2. The list view exposes the Card 7 layout — glyph + id + STATUS
//      + #blockers + top-blocker + ROI + title — and reads per-row
//      blockers via getTaskEdgesWithStatus (memoised so '/'-filter
//      typing doesn't re-do the SQLite reads on every keystroke).
//   3. Yank → `mu task tree <id> -w <ws>`. The blocked-task popup's
//      most-actionable diagnostic question is "what's blocking
//      this?" and `mu task tree` walks the prerequisite subgraph in
//      one shot. Drill-mode yank → `mu task notes <id>` (shared).
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { type ReactElement, useMemo } from "react";
import { roiBucket, type WorkstreamSnapshot } from "../../../state.js";
import { getTaskEdgesWithStatus } from "../../../tasks.js";
import { inkColorForStatus } from "../../format.js";
import { glyphFor, stillGating } from "../cards/blocked.js";
import type { ColumnSpec } from "../columns.js";
import { colorForBucket, formatRoi } from "../format-helpers.js";
import {
  type PopupProps,
  type RenderedRow,
  TaskListPopup,
  type TaskListPopupConfig,
} from "./task-list-popup.js";

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // task id
  { kind: "protect" }, // status (always OPEN; constant for now)
  { kind: "protect", align: "right" }, // #blockers
  { kind: "protect" }, // top-blocker id (or "—")
  { kind: "protect", align: "right" }, // ROI
  { kind: "clip", min: 1 }, // title
];

export function BlockedPopup(props: PopupProps): ReactElement {
  const { snapshot, db, workstream } = props;
  const sourceTasks = snapshot?.blocked ?? [];

  // Per-row blocker lookup. Memoised so '/'-filter typing doesn't
  // re-do the SQLite reads on every keystroke. Same shape as the
  // Card 7 read path: one getTaskEdgesWithStatus per source row,
  // filtered to still-gating. Indexed by task `name`.
  const blockerIndex = useMemo<Map<string, string[]>>(() => {
    const m = new Map<string, string[]>();
    for (const t of sourceTasks) {
      const gating = stillGating(getTaskEdgesWithStatus(db, t.name, workstream).blockers);
      m.set(
        t.name,
        gating.map((b) => b.name),
      );
    }
    return m;
  }, [sourceTasks, db, workstream]);

  const config = useMemo<TaskListPopupConfig>(
    () => ({
      label: "Blocked",
      sourceTasks: (snap: WorkstreamSnapshot) => snap.blocked,
      columnSpecs: COLUMN_SPECS,
      filterBlob: (t) => {
        const blockers = blockerIndex.get(t.name) ?? [];
        return `${t.name} ${t.title} ${blockers.join(" ")}`;
      },
      emptyText: "(no blocked tasks — every OPEN task is ready)",
      // Per the task spec KEY MAP block: most useful diagnostic is
      // `mu task tree <id>` — "show me what's blocking this".
      yankCommand: (t, ws) => `mu task tree ${t.name} -w ${ws}`,
      renderRows: (visible): RenderedRow[] =>
        visible.map((t) => {
          const blockers = blockerIndex.get(t.name) ?? [];
          const top = blockers[0] ?? "—";
          const bucket = roiBucket(t.impact, t.effortDays);
          return {
            cells: [
              glyphFor(),
              t.name,
              t.status,
              String(blockers.length),
              top,
              formatRoi(t.impact, t.effortDays),
              t.title,
            ],
            colors: [
              { dimColor: true }, // glyph
              { bold: true }, // name
              { color: inkColorForStatus(t.status) }, // status
              { color: "yellow" }, // nblock
              { dimColor: true }, // top
              { color: colorForBucket(bucket) }, // roi
              undefined, // title
            ],
          };
        }),
    }),
    [blockerIndex],
  );

  return <TaskListPopup config={config} {...props} />;
}
