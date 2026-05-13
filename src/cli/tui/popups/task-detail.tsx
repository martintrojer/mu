// Shared "task detail" leaf — read-only inline rendering of a
// task's notes timeline. The leaf of the popup-drill recursion
// (per feat_track_drill_chains_to_task_drill).
//
// Today's consumers:
//   - popups/ready.tsx → Tasks popup drill (Enter on a task row)
//   - popups/tracks.tsx → Tracks popup drill → drill row Enter
//
// Future consumers (when promoted): any popup whose drill is
// itself a list of tasks (Card 6 in-progress, Card 7 blocked,
// Card 8 recent — see feat_more_cards_umbrella). Each gets the
// chain into this leaf "for free" by importing TaskDetailDrill.
//
// Pure presentation — the parent owns the scroll cursor (so each
// recursion level has its own scroll state) and the keyboard.
// This module never executes mutations; listNotes is a SQLite
// SELECT.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { useMemo } from "react";
import type { Db } from "../../../db.js";
import { type TaskRow, listNotes } from "../../../tasks.js";
import { DrillScrollView } from "./drill.js";

const ANSI_BOLD_CYAN = "\x1b[1;36m";
const ANSI_RESET = "\x1b[0m";

export interface TaskDetailDrillProps {
  task: TaskRow;
  db: Db;
  workstream: string;
  /** First visible line index — owned by parent for per-level scroll. */
  scrollTop: number;
  /** Visible lines; caller picks based on terminal height. */
  viewport: number;
}

/**
 * Render a task's notes timeline. Returns a column of:
 *   <DrillScrollView title="mu task notes <id>" body=<rendered>… />
 *
 * Empty notes → DrillScrollView's emptyText fallback fires.
 */
export function TaskDetailDrill({
  task,
  db,
  workstream,
  scrollTop,
  viewport,
}: TaskDetailDrillProps): JSX.Element {
  const body = useMemo<string>(
    () => renderNotes(db, task.name, workstream),
    [db, task, workstream],
  );
  return (
    <DrillScrollView
      title={`mu task notes ${task.name}`}
      body={body}
      viewport={viewport}
      scrollTop={scrollTop}
      emptyText="(no notes)"
      hint={`y yanks \`mu task notes ${task.name}\``}
    />
  );
}

/**
 * Pure helper: SELECTs notes via listNotes and formats them as the
 * same `── <ts>  <author> ──\n<content>` blocks the Tasks popup
 * drill rendered inline before this refactor. Exported so tests can
 * assert the exact format without booting ink.
 */
export function renderNotes(db: Db, taskId: string, workstream: string): string {
  const notes = listNotes(db, taskId, workstream);
  if (notes.length === 0) return "";
  return notes
    .map((n) => {
      const ts = n.createdAt.replace("T", " ").slice(0, 19);
      const author = n.author ?? "?";
      return `${ANSI_BOLD_CYAN}── ${ts}  ${author} ──${ANSI_RESET}\n${n.content}`;
    })
    .join("\n\n");
}
