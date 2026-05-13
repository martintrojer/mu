// Shared notes-drill memo for task-list popups (Tasks/ready,
// In-progress, Blocked, Recent, All-tasks). Pre-refactor each popup
// shipped a byte-identical useMemo block that SELECTed task notes
// only when the popup was in drill mode and a row was focused. The
// block existed only because `useDrillKeymap` needs the rendered
// body string to clamp scroll. See task
// review_tui_task_popups_duplicated_template (workstream `tui-impl`).

import { useMemo } from "react";
import type { Db } from "../../db.js";
import type { TaskRow } from "../../tasks.js";
import { renderNotes } from "./popups/task-detail.js";

export interface UseNotesDrillOptions {
  mode: "list" | "drill";
  focused: TaskRow | undefined;
  db: Db;
  workstream: string;
  /** Refresh signal for SQL-backed bodies (the fast TUI tick). */
  fastTickNonce: number;
}

/** Returns "" until mode === "drill" + focused, otherwise renderNotes(...).
 *  fastTickNonce sits in the memo deps so the body refreshes on each
 *  fast tick while the drill stays open during a worker session. */
export function useNotesDrill(opts: UseNotesDrillOptions): string {
  const { mode, focused, db, workstream, fastTickNonce } = opts;
  return useMemo<string>(() => {
    void fastTickNonce;
    if (mode !== "drill" || !focused) return "";
    return renderNotes(db, focused.name, workstream);
  }, [mode, focused, db, workstream, fastTickNonce]);
}
