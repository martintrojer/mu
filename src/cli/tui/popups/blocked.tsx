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
import { useEffect, useMemo, useState } from "react";
import type { Db } from "../../../db.js";
import { type WorkstreamSnapshot, roiBucket } from "../../../state.js";
import { getTaskEdgesWithStatus } from "../../../tasks.js";
import { glyphFor, stillGating } from "../cards/blocked.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { dispatchPopupKey } from "../keys.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { clampScrollTop } from "./drill.js";
import { TaskDetailDrill, renderNotes } from "./task-detail.js";
import { popupViewport } from "./viewport.js";

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
  mode,
  onModeChange,
  onFilterEditingChange,
  db,
  workstream,
}: PopupProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  // Per-render viewport from stdout.rows minus the popup chrome budget;
  // see popups/viewport.ts. Replaces the prior hardcoded VIEWPORT = 20.
  const { stdout } = useStdout();
  const viewport = popupViewport(stdout?.rows ?? 24);
  const [cursor, setCursor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const flt = usePopupFilter();

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

  const tasks =
    mode === "drill"
      ? sourceTasks
      : applyFilter(sourceTasks, flt.query, (t) => {
          const blockers = blockerIndex.get(t.name) ?? [];
          return `${t.name} ${t.title} ${blockers.join(" ")}`;
        });
  const safeCursor = tasks.length === 0 ? 0 : Math.min(cursor, tasks.length - 1);
  const focused = tasks[safeCursor];
  useEffect(() => {
    onFilterEditingChange?.(flt.editing);
  }, [flt.editing, onFilterEditingChange]);

  // Resolve notes for the focused task on demand. Memoised on
  // (taskId, mode); we only hit SQLite when actually drilled in.
  // Identical to the TaskDetailDrill render path — we duplicate
  // the call here only because the keymap needs `totalLines` to
  // clamp scroll. The shared formatter (renderNotes) is the single
  // source of truth.
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
      switch (action.kind) {
        case "close":
          onModeChange("list");
          setScrollTop(0);
          return;
        case "moveDown":
          setScrollTop((s) => clampScrollTop(s + 1, totalLines, viewport));
          return;
        case "moveUp":
          setScrollTop((s) => clampScrollTop(s - 1, totalLines, viewport));
          return;
        case "jumpTop":
          setScrollTop(0);
          return;
        case "jumpBottom":
          setScrollTop(clampScrollTop(totalLines, totalLines, viewport));
          return;
        case "pageDown":
          setScrollTop((s) =>
            clampScrollTop(s + Math.floor(viewport / (action.half ? 2 : 1)), totalLines, viewport),
          );
          return;
        case "pageUp":
          setScrollTop((s) =>
            clampScrollTop(s - Math.floor(viewport / (action.half ? 2 : 1)), totalLines, viewport),
          );
          return;
        case "yank": {
          if (!focused || !snapshot) return;
          // Drill yank matches the TaskDetailDrill leaf the user is
          // reading: `mu task notes` is the canonical recipe.
          void yank(`mu task notes ${focused.name} -w ${snapshot.workstreamName}`);
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
      case "filter":
        flt.startEdit();
        return;
      case "drill":
        if (focused) {
          setScrollTop(0);
          onModeChange("drill");
        }
        return;
      case "moveDown":
        setCursor((c) => Math.min(tasks.length - 1, c + 1));
        return;
      case "moveUp":
        setCursor((c) => Math.max(0, c - 1));
        return;
      case "jumpTop":
        setCursor(0);
        return;
      case "jumpBottom":
        setCursor(Math.max(0, tasks.length - 1));
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
  });

  if (snapshot === null) {
    return <Shell title="Blocked · popup">{<Text dimColor>loading…</Text>}</Shell>;
  }
  if (sourceTasks.length === 0) {
    return (
      <Shell title="Blocked · popup">
        <Text dimColor>(no blocked tasks — every OPEN task is ready)</Text>
      </Shell>
    );
  }
  if (tasks.length === 0) {
    return (
      <Shell title="Blocked · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </Shell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <Shell title={`Blocked · ${focused.name} (notes)`}>
        <Box flexDirection="column" flexGrow={1}>
          <TaskDetailDrill
            task={focused}
            db={db}
            workstream={workstream}
            scrollTop={scrollTop}
            viewport={viewport}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            j/k scroll · Ctrl-D/U half page · y yanks `mu task notes` · Esc/q back to list
          </Text>
        </Box>
      </Shell>
    );
  }

  const rows = tasks.map((t) => {
    const blockers = blockerIndex.get(t.name) ?? [];
    const top = blockers[0] ?? "—";
    const roi = t.effortDays > 0 ? Math.round(t.impact / t.effortDays) : Number.POSITIVE_INFINITY;
    const roiText = Number.isFinite(roi) ? String(roi) : "∞";
    return [glyphFor(t), t.name, t.status, String(blockers.length), top, roiText, t.title];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <Shell title={`Blocked · popup (${safeCursor + 1}/${tasks.length})`}>
      <Box flexDirection="column" flexGrow={1}>
        {tasks.map((t, i) => {
          const selected = i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const [glyph = "", name = "", status = "", nblock = "", top = "", roi = "", title = ""] =
            padded;
          const bucket = roiBucket(t.impact, t.effortDays);
          return (
            <Box key={t.name}>
              <Text inverse={selected}>
                <Text dimColor>{glyph}</Text>
                {"  "}
                <Text bold>{name}</Text>
                {"  "}
                <Text dimColor>{status}</Text>
                {"  "}
                <Text color="yellow">{nblock}</Text>
                {"  "}
                <Text dimColor>{top}</Text>
                {"  "}
                <Text color={colorForBucket(bucket)}>{roi}</Text>
                {"  "}
                <Text>{title}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter notes · y yanks `mu task tree &lt;id&gt;`</Text>
      </Box>
      <FilterPrompt state={flt} />
    </Shell>
  );
}

// ─── pure helpers ─────────────────────────────────────────────────

function colorForBucket(b: ReturnType<typeof roiBucket>): string | undefined {
  switch (b) {
    case "high":
    case "infinite":
      return "green";
    case "mid":
      return "yellow";
    case "low":
      return undefined;
  }
}

function Shell({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  // width={cols} + flexGrow={1} ensure the popup fills the pane edge-to-edge
  // (see bug_tui_popups_fill_pane). Without these, ink's Yoga layout sizes
  // this Box to its content and the popup renders as a narrow strip.
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="column"
      flexGrow={1}
      width={cols}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}
