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
// Carbon-copy of popups/ready.tsx (the canonical template for
// task-list popups) with three differences:
//
//   1. Source rows are `snapshot.blocked` (the OPEN-with-unsatisfied-
//      blockers slice) instead of `[...ready, ...inProgress]`.
//   2. The list view exposes the Card 7 layout — glyph + id + STATUS
//      + #blockers + ROI + title — instead of Tasks-popup's
//      id/status/owner/title cluster. Re-uses Card 7's pure helpers
//      (`glyphFor`, `stillGating`, `pickTopBlocker`, `formatSubtitle`)
//      and per-row `getTaskEdgesWithStatus` reads exactly like the
//      card; cap stays implicit at the popup's render budget
//      (fullscreen — no ROW_LIMIT).
//   3. Yank → `mu task tree <id> -w <ws>`. The blocked-task popup's
//      most-actionable diagnostic question is "what's blocking
//      this?" and `mu task tree` walks the prerequisite subgraph in
//      one shot — strictly more useful than `mu task show` here.
//      Drill-mode yank → `mu task notes <id>` (matches the
//      TaskDetailDrill leaf the user is reading).
//
// Read-only (per ROADMAP pledge): the only act-intents are yanks.
// The drill is `TaskDetailDrill` whose `listNotes` call is a SQLite
// SELECT — never a mutation.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { Box, Text, useInput, useStdout } from "ink";
import { useMemo, useState } from "react";
import type { Db } from "../../../db.js";
import { type WorkstreamSnapshot, roiBucket } from "../../../state.js";
import { type TaskRow, getTaskEdgesWithStatus } from "../../../tasks.js";
import { inkColorForStatus } from "../../format.js";
import { glyphFor, stillGating } from "../cards/blocked.js";
import { type ColumnSpec, contentWidthFromCols, layoutColumns, renderRow } from "../columns.js";
import { colorForBucket, formatRoi } from "../format-helpers.js";
import { type PopupAction, type PopupActionEnvelope, dispatchPopupKeyFromInk } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
import { useNotesDrill } from "../use-notes-drill.js";
import { usePopupActionQueue } from "../use-popup-action-queue.js";
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
  popupActions?: readonly PopupActionEnvelope[];
  db: Db;
  workstream: string;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // task id
  { kind: "protect" }, // status (always OPEN; constant for now)
  { kind: "protect", align: "right" }, // #blockers
  { kind: "protect" }, // top-blocker id (or "—")
  { kind: "protect", align: "right" }, // ROI
  { kind: "clip", min: 1 }, // title
];

export function BlockedPopup({
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
  // Per-render viewport from stdout.rows minus the popup chrome budget;
  // see popups/viewport.ts. Replaces the prior hardcoded VIEWPORT = 20.
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });

  const sourceTasks = snapshot?.blocked ?? [];

  // Per-row blocker lookup. Memoised so '/'-filter typing doesn't
  // re-do the SQLite reads on every keystroke. Same shape as the
  // Card 7 read path: one getTaskEdgesWithStatus per visible row,
  // filtered to still-gating. Indexed by task `name` so the filter
  // operates on a parallel array of pre-computed blocker ids.
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

  // Per bug_filter_drill_opens_wrong_task: text filter applied
  // UNIFORMLY across list and drill modes (the previous mode-conditional
  // dropped the filter on drill, shifting `tasks` under a constant
  // cursor index).
  const tasks = applyFilter(sourceTasks, flt.query, (t) => {
    const blockers = blockerIndex.get(t.name) ?? [];
    return `${t.name} ${t.title} ${blockers.join(" ")}`;
  });
  const safeCursor = tasks.length === 0 ? 0 : Math.min(cursor, tasks.length - 1);
  const focused = tasks[safeCursor];

  // Defensive: capture focused task identity at Enter.
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
        const ws = snapshot.workstreamName;
        // Per the task spec KEY MAP block: most useful diagnostic
        // is `mu task tree <id>` — "show me what's blocking this".
        void yank(`mu task tree ${t.name} -w ${ws}`);
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
    return <PopupShell title="Blocked · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (sourceTasks.length === 0) {
    return (
      <PopupShell title="Blocked · popup">
        <Text dimColor>(no blocked tasks — every OPEN task is ready)</Text>
      </PopupShell>
    );
  }
  if (tasks.length === 0) {
    return (
      <PopupShell title="Blocked · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && drillTask) {
    return (
      <PopupShell title={`Blocked · ${drillTask.name} (notes)`}>
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
  const rows = visible.map((t) => {
    const blockers = blockerIndex.get(t.name) ?? [];
    const top = blockers[0] ?? "—";
    const roiText = formatRoi(t.impact, t.effortDays);
    return [glyphFor(), t.name, t.status, String(blockers.length), top, roiText, t.title];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell title={`Blocked · popup (${safeCursor + 1}/${tasks.length})`}>
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((t, i) => {
          const selected = start + i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const bucket = roiBucket(t.impact, t.effortDays);
          const colors = [
            { dimColor: true }, // glyph
            { bold: true }, // name
            { color: inkColorForStatus(t.status) }, // status
            { color: "yellow" }, // nblock
            { dimColor: true }, // top
            { color: colorForBucket(bucket) }, // roi
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
