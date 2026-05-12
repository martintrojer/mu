// Agents popup (Shift+1 → `!`). Drill-down for the Agents card.
//
// Per design_popup_agents (workstream `tui`): list of agents with
// per-agent yank intents (free / close / send).
//
// Enter on a row drills into a read-only inline scrollback view —
// equivalent to `mu agent read <name> -n 80` rendered as plain text
// with j/k scroll. Esc / q in drill mode returns to the list; a
// second Esc / q closes the popup back to the dashboard.
//
// Read-only: drilling never executes anything; we only call
// readAgent which is a tmux capture-pane wrapper. The yank verbs
// (f / x / y) still emit `mu` command strings the user must paste
// to actually run.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: glyph, agent name,
// status are PROTECTED; the role description is CLIPPABLE.

import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import { STATUS_EMOJI, readAgent } from "../../../agents.js";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
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
import { DrillScrollView } from "./drill.js";
import { applyCursor, applyScroll, isNavAction } from "./scroll.js";
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

const AGENT_COLORS = [
  undefined, // glyph (plain)
  { bold: true }, // name
  { dimColor: true }, // status
  { dimColor: true }, // role
] as const;

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // agent name
  { kind: "protect" }, // status token
  { kind: "clip", min: 1 }, // role
];

const SCROLLBACK_LINES = 80;

export function AgentsPopup({
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
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollback, setScrollback] = useState<string>("");
  const [scrollbackErr, setScrollbackErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const flt = usePopupFilter();
  // Filter is suppressed in drill mode (drill view is not a list).
  const sourceAgents = snapshot?.view.agents ?? [];
  const agents =
    mode === "drill"
      ? sourceAgents
      : applyFilter(sourceAgents, flt.query, (a) => `${a.name} ${a.status} ${a.cli} ${a.role}`);
  const safeCursor = agents.length === 0 ? 0 : Math.min(cursor, agents.length - 1);
  const focused = agents[safeCursor];
  // Push the filter editing state up so StatusBar can flip its hint cluster.
  useEffect(() => {
    onFilterEditingChange?.(flt.editing);
  }, [flt.editing, onFilterEditingChange]);

  // Load scrollback when entering drill mode (or when the focused
  // row changes while in drill mode). Read-only: capturePane is a
  // tmux read, never a write.
  const loadScrollback = useCallback(
    async (paneAgent: string) => {
      setLoading(true);
      setScrollbackErr(null);
      try {
        const text = await readAgent(db, paneAgent, {
          workstream,
          lines: SCROLLBACK_LINES,
        });
        setScrollback(text);
        setScrollTop(0);
      } catch (e) {
        setScrollbackErr(e instanceof Error ? e.message : String(e));
        setScrollback("");
      } finally {
        setLoading(false);
      }
    },
    [db, workstream],
  );

  useEffect(() => {
    if (mode === "drill" && focused) {
      void loadScrollback(focused.name);
    }
  }, [mode, focused, loadScrollback]);

  useInput((input, key) => {
    // Filter-mode keystrokes (when the prompt is editing) consume
    // every printable + Esc/Enter/Bksp; the popup's own dispatchPopupKey
    // is bypassed for the duration of the edit.
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
      // Drill-mode keymap: scroll-based view. Nav cluster funnels
      // through applyScroll; Esc/q backs to list; y yanks the
      // scrollback-read recipe. Verb keys / drill-again are
      // intentionally suppressed in drill (read-only).
      const totalLines = scrollback === "" ? 0 : scrollback.split("\n").length;
      if (isNavAction(action)) {
        setScrollTop((s) => applyScroll(s, action, totalLines, viewport));
        return;
      }
      switch (action.kind) {
        case "close":
          onModeChange("list");
          return;
        case "yank": {
          if (!focused || !snapshot) return;
          void yank(
            `mu agent read ${focused.name} -n ${SCROLLBACK_LINES} -w ${snapshot.workstreamName}`,
          );
          return;
        }
        default:
          return;
      }
    }
    if (isNavAction(action)) {
      setCursor((c) => applyCursor(c, action, agents.length, viewport));
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
        if (focused) onModeChange("drill");
        return;
      case "yank": {
        const a = agents[safeCursor];
        if (!a || !snapshot) return;
        const ws = snapshot.workstreamName;
        // Default yank: a `mu agent send` template the user can
        // edit. The popup-verb keys f / x cover free / close.
        void yank(`mu agent send ${a.name} '...' -w ${ws}`);
        return;
      }
      case "verb": {
        const a = agents[safeCursor];
        if (!a || !snapshot) return;
        const ws = snapshot.workstreamName;
        if (action.key === "f") {
          void yank(`mu agent free ${a.name} -w ${ws}`);
          return;
        }
        if (action.key === "x") {
          void yank(`mu agent close ${a.name} -w ${ws}`);
          return;
        }
        return;
      }
    }
  });

  if (snapshot === null) {
    return <PopupShell title="Agents · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (sourceAgents.length === 0) {
    return (
      <PopupShell title="Agents · popup">
        <Text dimColor>(no agents)</Text>
      </PopupShell>
    );
  }
  if (agents.length === 0) {
    return (
      <PopupShell title="Agents · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <PopupShell title={`Agents · ${focused.name} (scrollback)`}>
        <Box flexDirection="column" flexGrow={1}>
          <DrillScrollView
            title={`mu agent read ${focused.name} -n ${SCROLLBACK_LINES}`}
            body={scrollbackErr !== null ? `error: ${scrollbackErr}` : scrollback}
            viewport={viewport}
            scrollTop={scrollTop}
            hint={`y yanks \`mu agent read -n ${SCROLLBACK_LINES}\``}
            emptyText={loading ? "loading…" : "(no scrollback yet)"}
          />
        </Box>
      </PopupShell>
    );
  }

  const rows = agents.map((a) => [STATUS_EMOJI[a.status] ?? "?", a.name, a.status, a.role]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Agents · popup (${safeCursor + 1}/${agents.length})`}
      hint="f free · x close · y yanks `mu agent send`"
    >
      <Box flexDirection="column" flexGrow={1}>
        {agents.map((a, i) => {
          const sel = i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          return (
            <ListRow
              key={a.name}
              cells={padded}
              contentWidth={contentWidth}
              colors={AGENT_COLORS}
              selected={sel}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
  );
}
