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
// Read-only (per ROADMAP pledge): the only act-intents are yanks.
// Drilling into TaskDetailDrill SELECTs notes via listNotes; never
// executes mutations.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { glyphFor, isStale } from "../cards/inprogress.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { ageMs, formatRoi, formatSinceClaim } from "../format-helpers.js";
import { dispatchPopupKey } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";

// Re-exported for test back-compat (test/tui-popup-inprogress.test.ts
// imports `formatRoi` from this module). Single source of truth lives
// in ../format-helpers.ts.
export { formatRoi };
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { applyCursor, applyScroll, isNavAction } from "./scroll.js";
import { TaskDetailDrill, renderNotes } from "./task-detail.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
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
  { kind: "protect" }, // status (always IN_PROGRESS; constant for now)
  { kind: "protect" }, // owner (or "—")
  { kind: "protect", align: "right" }, // since-claim
  { kind: "protect", align: "right" }, // ROI label
  { kind: "clip", min: 1 }, // title
];

export function InProgressPopup({
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
  // Per-render viewport from stdout.rows minus the popup chrome budget;
  // see popups/viewport.ts. Replaces the prior hardcoded VIEWPORT = 20
  // (bug_tui_inprogress_recent_drill_viewport_clipped).
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const flt = usePopupFilter();
  const sourceTasks = snapshot ? snapshot.inProgress : [];
  // Per spec MATCHING RULES: search blob is `${id} ${title} ${owner ?? ""}`.
  const tasks =
    mode === "drill"
      ? sourceTasks
      : applyFilter(sourceTasks, flt.query, (t) => `${t.name} ${t.title} ${t.ownerName ?? ""}`);
  const safeCursor = tasks.length === 0 ? 0 : Math.min(cursor, tasks.length - 1);
  const focused = tasks[safeCursor];
  useEffect(() => {
    onFilterEditingChange?.(flt.editing);
  }, [flt.editing, onFilterEditingChange]);

  // Resolve notes for the focused task on demand. Memoised on
  // (taskId, mode); we only hit SQLite when actually drilled in.
  // Mirrors popups/ready.tsx — duplicated here only because the
  // keymap needs `totalLines` to clamp scroll. The shared formatter
  // (renderNotes) is the single source of truth.
  const notesText = useMemo<string>(() => {
    if (mode !== "drill" || !focused) return "";
    return renderNotes(db, focused.name, workstream);
  }, [mode, focused, db, workstream]);

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    const action = dispatchPopupKey(input, {
      ctrl: key.ctrl,
      shift: key.shift,
      meta: key.meta,
      escape: key.escape,
      return: key.return,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      tab: key.tab,
      pageUp: key.pageUp,
      pageDown: key.pageDown,
    });
    if (mode === "drill") {
      const totalLines = notesText === "" ? 0 : notesText.split("\n").length;
      if (isNavAction(action)) {
        setScrollTop((s) => applyScroll(s, action, totalLines, viewport));
        return;
      }
      switch (action.kind) {
        case "close":
          onModeChange("list");
          setScrollTop(0);
          return;
        case "yank": {
          if (!focused || !snapshot) return;
          void yank(`mu task notes ${focused.name} -w ${snapshot.workstreamName}`);
          return;
        }
        default:
          return;
      }
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
          setScrollTop(0);
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
    return <PopupShell title="In-progress · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (sourceTasks.length === 0) {
    return (
      <PopupShell title="In-progress · popup">
        <Text dimColor>(none in progress)</Text>
      </PopupShell>
    );
  }
  if (tasks.length === 0) {
    return (
      <PopupShell title="In-progress · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <PopupShell title={`In-progress · ${focused.name} (notes)`}>
        <Box flexDirection="column" flexGrow={1}>
          <TaskDetailDrill
            task={focused}
            db={db}
            workstream={workstream}
            scrollTop={scrollTop}
            viewport={viewport}
          />
        </Box>
      </PopupShell>
    );
  }

  const now = Date.now();
  const ages = tasks.map((t) => ageMs(t, now));
  const rows = tasks.map((t, i) => [
    glyphFor(t),
    t.name,
    t.status,
    t.ownerName ?? "—",
    formatSinceClaim(ages[i] ?? null),
    formatRoi(t.impact, t.effortDays),
    t.title,
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`In-progress · popup (${safeCursor + 1}/${tasks.length})`}
      hint="y yanks `mu task close <id> --evidence ...`"
    >
      <Box flexDirection="column" flexGrow={1}>
        {tasks.map((t, i) => {
          const selected = i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const stale = isStale(ages[i] ?? null);
          const colors = [
            { color: "yellow" }, // glyph
            { bold: true }, // id
            { dimColor: true }, // status
            { dimColor: true }, // owner
            stale ? { color: "yellow" } : { dimColor: true }, // since-claim
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
