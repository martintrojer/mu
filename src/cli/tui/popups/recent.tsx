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
// Read-only (per ROADMAP pledge): the only act-intents are yanks.
// Drilling into TaskDetailDrill SELECTs notes via listNotes; never
// executes mutations.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { inkColorForStatus } from "../../format.js";
import { glyphFor } from "../cards/recent.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { ageMs, formatRoi, formatWhen } from "../format-helpers.js";
import { dispatchPopupKeyFromInk } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";

// Re-exported for test back-compat (test/tui-popup-recent.test.ts
// imports `formatRoi` from this module). Single source of truth lives
// in ../format-helpers.ts.
export { formatRoi };
import { useNotesDrill } from "../use-notes-drill.js";
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
  db: Db;
  workstream: string;
}

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

export function RecentPopup({
  yank,
  onClose,
  snapshot,
  fastTickNonce,
  mode,
  onModeChange,
  onFilterEditingChange,
  db,
  workstream,
}: PopupProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  // Per-render viewport from stdout.rows minus the popup chrome budget;
  // see popups/viewport.ts. Replaces the prior hardcoded VIEWPORT = 20
  // (bug_tui_inprogress_recent_drill_viewport_clipped).
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });
  const sourceTasks = snapshot ? snapshot.recentClosed : [];
  // Per spec MATCHING RULES: search blob is `${id} ${title} ${owner ?? ""}`.
  const tasks =
    mode === "drill"
      ? sourceTasks
      : applyFilter(sourceTasks, flt.query, (t) => `${t.name} ${t.title} ${t.ownerName ?? ""}`);
  const safeCursor = tasks.length === 0 ? 0 : Math.min(cursor, tasks.length - 1);
  const focused = tasks[safeCursor];

  const notesText = useNotesDrill({ mode, focused, db, workstream, fastTickNonce });

  const drill = useDrillKeymap({
    body: notesText,
    viewport,
    onClose: () => onModeChange("list"),
    onYank: () => {
      if (!focused || !snapshot) return;
      return yank(`mu task notes ${focused.name} -w ${snapshot.workstreamName}`);
    },
    resetKey: focused?.name ?? "",
  });

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    const action = dispatchPopupKeyFromInk(input, key);
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (isNavAction(action)) {
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
          onModeChange("drill");
        }
        return;
      case "yank": {
        const t = tasks[safeCursor];
        if (!t || !snapshot) return;
        const ws = snapshot.workstreamName;
        void yank(yankCommandForTask(t.name, ws));
        return;
      }
    }
  });

  if (snapshot === null) {
    return <PopupShell title="Recent · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (sourceTasks.length === 0) {
    return (
      <PopupShell title="Recent · popup">
        <Text dimColor>(none recently closed)</Text>
      </PopupShell>
    );
  }
  if (tasks.length === 0) {
    return (
      <PopupShell title="Recent · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <PopupShell title={`Recent · ${focused.name} (notes)`}>
        <Box flexDirection="column" flexGrow={1}>
          <TaskDetailDrill
            task={focused}
            db={db}
            workstream={workstream}
            scrollTop={drill.scrollTop}
            viewport={viewport}
            tickNonce={fastTickNonce}
          />
        </Box>
      </PopupShell>
    );
  }

  const now = Date.now();
  const ages = tasks.map((t) => ageMs(t, now));
  const { start, visible } = centredVisibleSlice(tasks, safeCursor, viewport);
  const rows = visible.map((t, i) => {
    const absoluteIndex = start + i;
    return [
      glyphFor(),
      t.name,
      t.status,
      formatWhen(ages[absoluteIndex] ?? null),
      String(t.impact),
      String(t.effortDays),
      formatRoi(t.impact, t.effortDays),
      t.title,
    ];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Recent · popup (${safeCursor + 1}/${tasks.length})`}
      hint="Enter notes · y yanks `mu task open` · / filter · Esc/q close"
    >
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((t, i) => {
          const selected = start + i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const colors = [
            { color: "green" }, // glyph
            { bold: true }, // id
            { color: inkColorForStatus(t.status) }, // status
            { dimColor: true }, // when
            { dimColor: true }, // impact
            { dimColor: true }, // effort
            { dimColor: true }, // roi
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
