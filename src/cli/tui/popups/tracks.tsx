// Tracks popup (Shift+2 → `@`). Per design_popup_tracks +
// feat_track_drill_chains_to_task_drill.
//
// Recursion ladder (per popup-drill recursion contract):
//   list        → list of tracks                 (Enter drills)
//   drill       → list of tasks for focused track (Enter chains)
//   task-detail → notes timeline for focused task (LEAF; no chain)
//
// Esc/q transitions: task-detail → drill → list → close popup.
//
// The top-level `mode` prop (owned by <App>) is still a 2-state
// union ("list" | "drill") because app.tsx is currently being
// edited by another agent (sibling task bug_tui_render_ghosting_v2);
// task-detail is therefore an INTERNAL sub-state of the Tracks
// popup, kept as a local useState. From <App>'s perspective Tracks
// is in "drill" mode the entire time the user is below the list of
// tracks, which is exactly what the status-bar drill hint cluster
// already advertises (j/k scroll · Esc back). When the union is
// widened to include "task-detail" (follow-up integration), this
// local state collapses into the prop without changing semantics.
//
// Read-only: drilling reads from snapshot.tracks[i].taskIds and
// resolves each id to a TaskRow via getTask; the leaf consumes
// TaskDetailDrill which SELECTs notes via listNotes. Never executes.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: track number, ⋈ glyph,
// counts are PROTECTED; the goal-name list is CLIPPABLE.

import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type TaskRow, getTask } from "../../../tasks.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { dispatchPopupKey } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
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
  { kind: "protect" }, // "Track N"
  { kind: "protect" }, // diamond glyph (or empty)
  { kind: "clip", min: 1 }, // goal names
  { kind: "protect" }, // counts
];

const DRILL_COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // task id
  { kind: "protect" }, // status
  { kind: "clip", min: 1 }, // title
];

const TRACK_COLORS = [
  { color: "cyan" }, // Track N
  undefined, // diamond
  undefined, // goals
  { dimColor: true }, // counts
] as const;

const DRILL_COLORS = [
  { bold: true }, // name
  { dimColor: true }, // status
  undefined, // title
] as const;

// Internal sub-state of the drill view. "task-list" = the visible
// list of tasks for the focused track (where the prop `mode` is
// `"drill"`); "task-detail" = the deeper leaf view. See the file
// header for why this isn't a third value on the prop union.
type DrillSubMode = "task-list" | "task-detail";

export function TracksPopup({
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
  // see popups/viewport.ts. Replaces the prior hardcoded VIEWPORT = 20.
  // Same `viewport` powers list, drill (task-list), AND task-detail
  // sub-views — their chrome budgets are all the default 6 rows.
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const [drillCursor, setDrillCursor] = useState(0);
  const [drillSubMode, setDrillSubMode] = useState<DrillSubMode>("task-list");
  const [taskDetailScrollTop, setTaskDetailScrollTop] = useState(0);
  // Filter is only active at the top-level (list-of-tracks) view
  // per spec MATCHING RULES (Tracks blob = head_id + head_title).
  // Drill sub-views own their own navigation; widening the filter
  // to the task-list drill is a follow-up.
  const flt = usePopupFilter();
  const sourceTracks = snapshot?.tracks ?? [];
  const tracks =
    mode === "list"
      ? applyFilter(sourceTracks, flt.query, (t) => {
          const head = t.roots[0];
          return `${head?.name ?? ""} ${head?.title ?? ""}`;
        })
      : sourceTracks;
  const safeCursor = tracks.length === 0 ? 0 : Math.min(cursor, tracks.length - 1);
  const focusedTrack = tracks[safeCursor];
  useEffect(() => {
    onFilterEditingChange?.(flt.editing);
  }, [flt.editing, onFilterEditingChange]);

  // Reset sub-mode + leaf scroll whenever the popup itself flips
  // out of drill mode (e.g. user pressed Esc in the task-list view
  // and we're transitioning back to the list-of-tracks). The
  // entry-into-task-detail scroll reset lives at the keymap site
  // where setDrillSubMode("task-detail") is dispatched.
  useEffect(() => {
    if (mode !== "drill") {
      setDrillSubMode("task-list");
      setTaskDetailScrollTop(0);
    }
  }, [mode]);

  // Resolve every task id in the focused track to a TaskRow when
  // we're in drill mode. Memoised on (track, db) so flipping
  // mode doesn't re-query SQLite needlessly. Sorted by status
  // (READY/IN_PROGRESS first; CLOSED/REJECTED/DEFERRED last) so
  // the "what's still actionable" view is at the top.
  const drillTasks = useMemo<TaskRow[]>(() => {
    if (mode !== "drill" || !focusedTrack) return [];
    const out: TaskRow[] = [];
    for (const id of focusedTrack.taskIds) {
      const t = getTask(db, id, workstream);
      if (t !== undefined) out.push(t);
    }
    out.sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name));
    return out;
  }, [mode, focusedTrack, db, workstream]);

  useInput((input, key) => {
    if (mode === "list" && flt.onKey(input, key) === "consumed") return;
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
    if (mode === "drill" && drillSubMode === "task-detail") {
      // Leaf: notes timeline. Nav cluster funnels through
      // applyScroll; y yanks `mu task notes`; Esc/q backs out one
      // level (→ task-list). Enter is intentionally inert here —
      // notes aren't entities.
      const focusedTask = drillTasks[drillCursor];
      // Re-derive line count for clamp on every keystroke. Cheap:
      // listNotes is a SQLite SELECT, and notes are small.
      const notesBody = focusedTask ? renderNotes(db, focusedTask.name, workstream) : "";
      const totalLines = notesBody === "" ? 0 : notesBody.split("\n").length;
      if (isNavAction(action)) {
        setTaskDetailScrollTop((s) => applyScroll(s, action, totalLines, viewport));
        return;
      }
      switch (action.kind) {
        case "close":
          setDrillSubMode("task-list");
          setTaskDetailScrollTop(0);
          return;
        case "yank": {
          if (!focusedTask || !snapshot) return;
          void yank(`mu task notes ${focusedTask.name} -w ${snapshot.workstreamName}`);
          return;
        }
        default:
          return;
      }
    }
    if (mode === "drill") {
      if (isNavAction(action)) {
        setDrillCursor((c) => applyCursor(c, action, drillTasks.length, viewport));
        return;
      }
      switch (action.kind) {
        case "close":
          onModeChange("list");
          setDrillCursor(0);
          return;
        case "drill": {
          // Chain into the task-detail leaf. This is the recursion
          // step the task asks for: Enter on a Tracks-drill row
          // opens the same notes view the Tasks popup drill renders.
          const t = drillTasks[drillCursor];
          if (!t) return;
          setTaskDetailScrollTop(0);
          setDrillSubMode("task-detail");
          return;
        }
        case "yank": {
          const t = drillTasks[drillCursor];
          if (!t || !snapshot) return;
          void yank(`mu task show ${t.name} -w ${snapshot.workstreamName}`);
          return;
        }
        default:
          return;
      }
    }
    if (isNavAction(action)) {
      setCursor((c) => applyCursor(c, action, tracks.length, viewport));
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
        if (focusedTrack) {
          setDrillCursor(0);
          onModeChange("drill");
        }
        return;
      case "yank": {
        const t = tracks[safeCursor];
        if (!t || !snapshot) return;
        const goal = t.roots[0]?.name;
        if (!goal) return;
        const ws = snapshot.workstreamName;
        void yank(`mu task tree ${goal} -w ${ws}`);
        return;
      }
    }
  });

  if (snapshot === null) {
    return <PopupShell title="Tracks · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (sourceTracks.length === 0) {
    return (
      <PopupShell title="Tracks · popup">
        <Text dimColor>(no goals — `mu task add ... --impact ...`)</Text>
      </PopupShell>
    );
  }
  if (mode === "list" && tracks.length === 0) {
    return (
      <PopupShell title="Tracks · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && drillSubMode === "task-detail" && focusedTrack) {
    const t = drillTasks[drillCursor];
    if (t === undefined) {
      // Defensive: drillTasks shape changed under us; back to drill.
      // Render a benign placeholder; the next render will show the
      // task-list once setDrillSubMode runs.
      setDrillSubMode("task-list");
      return (
        <PopupShell title={`Track ${cursor + 1} · (resyncing)`}>
          <Text dimColor>(refocusing…)</Text>
        </PopupShell>
      );
    }
    return (
      <PopupShell title={`Track ${cursor + 1} · task: ${t.name} (notes)`}>
        <Box flexDirection="column" flexGrow={1}>
          <TaskDetailDrill
            task={t}
            db={db}
            workstream={workstream}
            scrollTop={taskDetailScrollTop}
            viewport={viewport}
          />
        </Box>
      </PopupShell>
    );
  }

  if (mode === "drill" && focusedTrack) {
    const trackLabel = `Track ${cursor + 1}`;
    const goalSummary = focusedTrack.roots.map((r) => r.name).join(", ");
    if (drillTasks.length === 0) {
      return (
        <PopupShell title={`${trackLabel} · ${goalSummary}`}>
          <Text dimColor>(no tasks resolved)</Text>
        </PopupShell>
      );
    }
    const start = Math.max(
      0,
      Math.min(drillTasks.length - viewport, drillCursor - Math.floor(viewport / 2)),
    );
    const visible = drillTasks.slice(start, start + viewport);
    const rows = visible.map((t) => [t.name, t.status, t.title]);
    const widths = layoutColumns(rows, DRILL_COLUMN_SPECS, contentWidth);
    return (
      <PopupShell
        title={`${trackLabel} · ${goalSummary} (${drillCursor + 1}/${drillTasks.length})`}
      >
        <Box flexDirection="column" flexGrow={1}>
          {visible.map((t, i) => {
            const sel = drillTasks.indexOf(t) === drillCursor;
            const row = rows[i];
            if (row === undefined) return null;
            const padded = renderRow(row, widths, DRILL_COLUMN_SPECS);
            return (
              <ListRow
                key={t.name}
                cells={padded}
                contentWidth={contentWidth}
                colors={DRILL_COLORS}
                selected={sel}
              />
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>y yanks `mu task show`</Text>
        </Box>
      </PopupShell>
    );
  }

  const rows = tracks.map((t, i) => {
    const goalNames = t.roots.map((r) => r.name).join(", ");
    const diamond = t.roots.length > 1 ? "⋈" : " ";
    const counts = `(${t.taskIds.size} tasks · ${t.readyCount} ready)`;
    return [`Track ${i + 1}`, diamond, goalNames, counts];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Tracks · popup (${safeCursor + 1}/${tracks.length})`}
      hint="y yanks `mu task tree <head-id>`"
    >
      <Box flexDirection="column" flexGrow={1}>
        {tracks.map((t, i) => {
          const sel = i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          return (
            <ListRow
              key={`tr-${i}-${t.roots[0]?.name ?? "?"}`}
              cells={padded}
              contentWidth={contentWidth}
              colors={TRACK_COLORS}
              selected={sel}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
  );
}

function statusRank(status: string): number {
  switch (status) {
    case "IN_PROGRESS":
      return 0;
    case "OPEN":
      return 1;
    case "DEFERRED":
      return 2;
    case "REJECTED":
      return 3;
    case "CLOSED":
      return 4;
    default:
      return 5;
  }
}
