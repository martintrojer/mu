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
import { type ColumnSpec, layoutColumns, renderRow } from "../columns.js";
import { dispatchPopupKey } from "../keys.js";
import { clampScrollTop } from "./drill.js";
import { TaskDetailDrill, renderNotes } from "./task-detail.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
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

const VIEWPORT = 20;

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
  db,
  workstream,
}: PopupProps): JSX.Element {
  const [cursor, setCursor] = useState(0);
  const [drillCursor, setDrillCursor] = useState(0);
  const [drillSubMode, setDrillSubMode] = useState<DrillSubMode>("task-list");
  const [taskDetailScrollTop, setTaskDetailScrollTop] = useState(0);
  const tracks = snapshot?.tracks ?? [];
  const focusedTrack = tracks[cursor];

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
      // Leaf: notes timeline. j/k/Ctrl-D/U scroll; y yanks `mu task
      // notes`; Esc/q backs out one level (→ task-list). Enter is
      // intentionally inert here — notes aren't entities.
      const focusedTask = drillTasks[drillCursor];
      // Re-derive line count for clamp on every keystroke. Cheap:
      // listNotes is a SQLite SELECT, and notes are small.
      const notesBody = focusedTask ? renderNotes(db, focusedTask.name, workstream) : "";
      const totalLines = notesBody === "" ? 0 : notesBody.split("\n").length;
      switch (action.kind) {
        case "close":
          setDrillSubMode("task-list");
          setTaskDetailScrollTop(0);
          return;
        case "moveDown":
          setTaskDetailScrollTop((s) => clampScrollTop(s + 1, totalLines, VIEWPORT));
          return;
        case "moveUp":
          setTaskDetailScrollTop((s) => clampScrollTop(s - 1, totalLines, VIEWPORT));
          return;
        case "jumpTop":
          setTaskDetailScrollTop(0);
          return;
        case "jumpBottom":
          setTaskDetailScrollTop(clampScrollTop(totalLines, totalLines, VIEWPORT));
          return;
        case "pageDown":
          setTaskDetailScrollTop((s) =>
            clampScrollTop(s + Math.floor(VIEWPORT / (action.half ? 2 : 1)), totalLines, VIEWPORT),
          );
          return;
        case "pageUp":
          setTaskDetailScrollTop((s) =>
            clampScrollTop(s - Math.floor(VIEWPORT / (action.half ? 2 : 1)), totalLines, VIEWPORT),
          );
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
      const last = Math.max(0, drillTasks.length - 1);
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
        case "moveDown":
          setDrillCursor((c) => Math.min(last, c + 1));
          return;
        case "moveUp":
          setDrillCursor((c) => Math.max(0, c - 1));
          return;
        case "jumpTop":
          setDrillCursor(0);
          return;
        case "jumpBottom":
          setDrillCursor(last);
          return;
        case "pageDown":
          setDrillCursor((c) =>
            clampScrollTop(c + Math.floor(VIEWPORT / (action.half ? 2 : 1)), last + 1, 1),
          );
          return;
        case "pageUp":
          setDrillCursor((c) =>
            clampScrollTop(c - Math.floor(VIEWPORT / (action.half ? 2 : 1)), last + 1, 1),
          );
          return;
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
    switch (action.kind) {
      case "close":
        onClose();
        return;
      case "drill":
        if (focusedTrack) {
          setDrillCursor(0);
          onModeChange("drill");
        }
        return;
      case "moveDown":
        setCursor((c) => Math.min(tracks.length - 1, c + 1));
        return;
      case "moveUp":
        setCursor((c) => Math.max(0, c - 1));
        return;
      case "jumpTop":
        setCursor(0);
        return;
      case "jumpBottom":
        setCursor(Math.max(0, tracks.length - 1));
        return;
      case "yank": {
        const t = tracks[cursor];
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
    return <Shell title="Tracks · popup">{<Text dimColor>loading…</Text>}</Shell>;
  }
  if (tracks.length === 0) {
    return (
      <Shell title="Tracks · popup">
        <Text dimColor>(no goals — `mu task add ... --impact ...`)</Text>
      </Shell>
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
        <Shell title={`Track ${cursor + 1} · (resyncing)`}>
          <Text dimColor>(refocusing…)</Text>
        </Shell>
      );
    }
    return (
      <Shell title={`Track ${cursor + 1} · task: ${t.name} (notes)`}>
        <TaskDetailDrill
          task={t}
          db={db}
          workstream={workstream}
          scrollTop={taskDetailScrollTop}
          viewport={VIEWPORT}
        />
        <Box marginTop={1}>
          <Text dimColor>
            j/k scroll · Ctrl-D/U half page · y yanks `mu task notes` · Esc/q back to drill
          </Text>
        </Box>
      </Shell>
    );
  }

  if (mode === "drill" && focusedTrack) {
    const trackLabel = `Track ${cursor + 1}`;
    const goalSummary = focusedTrack.roots.map((r) => r.name).join(", ");
    if (drillTasks.length === 0) {
      return (
        <Shell title={`${trackLabel} · ${goalSummary}`}>
          <Text dimColor>(no tasks resolved)</Text>
          <Box marginTop={1}>
            <Text dimColor>Esc/q back to list</Text>
          </Box>
        </Shell>
      );
    }
    const start = Math.max(
      0,
      Math.min(drillTasks.length - VIEWPORT, drillCursor - Math.floor(VIEWPORT / 2)),
    );
    const visible = drillTasks.slice(start, start + VIEWPORT);
    const rows = visible.map((t) => [t.name, t.status, t.title]);
    const widths = layoutColumns(rows, DRILL_COLUMN_SPECS);
    return (
      <Shell title={`${trackLabel} · ${goalSummary} (${drillCursor + 1}/${drillTasks.length})`}>
        {visible.map((t, i) => {
          const sel = drillTasks.indexOf(t) === drillCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, DRILL_COLUMN_SPECS);
          const [name = "", status = "", title = ""] = padded;
          return (
            <Box key={t.name}>
              <Text inverse={sel}>
                <Text bold>{name}</Text>
                {"  "}
                <Text dimColor>{status}</Text>
                {"  "}
                <Text>{title}</Text>
              </Text>
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text dimColor>
            j/k nav · Enter task notes · y yanks `mu task show` · Esc/q back to list
          </Text>
        </Box>
      </Shell>
    );
  }

  const rows = tracks.map((t, i) => {
    const goalNames = t.roots.map((r) => r.name).join(", ");
    const diamond = t.roots.length > 1 ? "⋈" : " ";
    const counts = `(${t.taskIds.size} tasks · ${t.readyCount} ready)`;
    return [`Track ${i + 1}`, diamond, goalNames, counts];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS);

  return (
    <Shell title={`Tracks · popup (${cursor + 1}/${tracks.length})`}>
      {tracks.map((t, i) => {
        const sel = i === cursor;
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const [trackLabel = "", diamond = "", goals = "", counts = ""] = padded;
        return (
          <Box key={`tr-${i}-${t.roots[0]?.name ?? "?"}`}>
            <Text inverse={sel}>
              <Text color="cyan">{trackLabel}</Text>
              {"  "}
              <Text>{diamond}</Text>
              {"  "}
              <Text>{goals}</Text>
              {"  "}
              <Text dimColor>{counts}</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>Enter task list · y yanks `mu task tree &lt;goal&gt;`</Text>
      </Box>
    </Shell>
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

function Shell({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}
