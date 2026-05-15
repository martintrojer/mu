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

import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AgentRow, STATUS_EMOJI, readAgent } from "../../../agents.js";
import type { Db } from "../../../db.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type ColumnSpec, contentWidthFromCols, layoutColumns, renderRow } from "../columns.js";
import { type PopupAction, type PopupActionEnvelope, dispatchPopupKeyFromInk } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
import { runTmuxAttachInteractive } from "../tmux-attach.js";
import { usePopupActionQueue } from "../use-popup-action-queue.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { DrillScrollView, useDrillKeymap } from "./drill.js";
import { applyCursor, centredVisibleSlice, isNavAction } from "./scroll.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  slowTickNonce: number;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  /** Bubbles the filter-prompt edit state up to <App> for StatusBar mode. */
  onFilterEditingChange?: (editing: boolean) => void;
  popupActions?: readonly PopupActionEnvelope[];
  /** Surface tmux-attach success/error in the footer status bar.
   *  Optional so existing callers / tests stay valid. */
  onFooter?: (command: string, copied: boolean, tone?: "normal" | "info" | "error") => void;
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
  slowTickNonce,
  mode,
  onModeChange,
  onFilterEditingChange,
  popupActions,
  onFooter,
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
  const [scrollback, setScrollback] = useState<string>("");
  const [scrollbackErr, setScrollbackErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });
  // Per bug_filter_drill_opens_wrong_task: text filter applied
  // UNIFORMLY across list and drill modes (the previous mode-conditional
  // dropped the filter on drill, shifting `agents` under a constant
  // cursor index).
  const sourceAgents = snapshot?.view.agents ?? [];
  const agents = applyFilter(
    sourceAgents,
    flt.query,
    (a) => `${a.name} ${a.status} ${a.cli} ${a.role}`,
  );
  const safeCursor = agents.length === 0 ? 0 : Math.min(cursor, agents.length - 1);
  const focused = agents[safeCursor];
  // Defensive: capture focused agent identity at Enter so the drill
  // stays pinned to the agent the user visually selected even if the
  // list shifts underneath us.
  const [drilledAgent, setDrilledAgent] = useState<AgentRow | null>(null);
  const drillAgent = mode === "drill" ? (drilledAgent ?? focused) : focused;
  const lastFocusedAgentName = useRef<string | null>(null);
  // Load scrollback when entering drill mode (or when the focused
  // row changes while in drill mode). Read-only: capturePane is a
  // tmux read, never a write.
  const loadScrollback = useCallback(
    async (paneAgent: string) => {
      setLoading(true);
      setScrollbackErr(null);
      // Keep the previous scrollback visible during the slow-tick
      // refetch; clearing here causes a blank-flash flicker.
      try {
        const text = await readAgent(db, paneAgent, {
          workstream,
          lines: SCROLLBACK_LINES,
        });
        setScrollback(text);
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
    void slowTickNonce;
    if (mode === "drill" && drillAgent) {
      if (lastFocusedAgentName.current !== drillAgent.name) {
        setScrollback("");
        setScrollbackErr(null);
      }
      lastFocusedAgentName.current = drillAgent.name;
      void loadScrollback(drillAgent.name);
    }
  }, [mode, drillAgent, loadScrollback, slowTickNonce]);

  useEffect(() => {
    if (mode !== "drill") {
      lastFocusedAgentName.current = null;
      setScrollback("");
      setScrollbackErr(null);
      setLoading(false);
    }
  }, [mode]);

  const drillBody = scrollbackErr !== null ? `error: ${scrollbackErr}` : scrollback;
  const drill = useDrillKeymap({
    body: drillBody,
    viewport,
    onClose: () => {
      setDrilledAgent(null);
      onModeChange("list");
    },
    onYank: () => {
      if (!drillAgent || !snapshot) return;
      return yank(
        `mu agent read ${drillAgent.name} -n ${SCROLLBACK_LINES} -w ${snapshot.workstreamName}`,
      );
    },
    resetKey: drillAgent?.name ?? "",
  });

  const dispatchListAction = (action: PopupAction) => {
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (action.kind === "setCursor" || isNavAction(action)) {
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
        if (focused) {
          setDrilledAgent(focused);
          onModeChange("drill");
        }
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
        if (action.key === "a") {
          // Per-popup TUI escape: hand off to tmux to switch the
          // user's client to the agent's pane. Mirrors `t tuicr` /
          // `l lazygit`. Read-only-by-design TUI is preserved — we
          // don't mutate state, we just let the user look at /
          // interact with the pane until they navigate back.
          const session = `mu-${ws}`;
          const window = a.tab ?? a.name;
          const r = runTmuxAttachInteractive({ session, window });
          if (!r.ok) onFooter?.(r.error ?? "tmux attach failed", false, "error");
          else onFooter?.(`tmux switch-client → ${session}:${window}`, true, "info");
          return;
        }
        return;
      }
    }
  };

  usePopupActionQueue(popupActions, dispatchListAction);

  useInput((input, key) => {
    // Filter-mode keystrokes (when the prompt is editing) consume
    // every printable + Esc/Enter/Bksp; the popup's own dispatchPopupKey
    // is bypassed for the duration of the edit.
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    dispatchListAction(dispatchPopupKeyFromInk(input, key));
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

  if (mode === "drill" && drillAgent) {
    return (
      <PopupShell title={`Agents · ${drillAgent.name} (scrollback)`}>
        <Box flexDirection="column" flexGrow={1}>
          <DrillScrollView
            title={`mu agent read ${drillAgent.name} -n ${SCROLLBACK_LINES}`}
            body={drillBody}
            viewport={viewport}
            scrollTop={drill.scrollTop}
            wrappedBody={drill.wrappedBody}
            hint={`y yanks \`mu agent read -n ${SCROLLBACK_LINES}\``}
            emptyText={loading ? "loading…" : "(no scrollback yet)"}
          />
        </Box>
      </PopupShell>
    );
  }

  const { start, visible } = centredVisibleSlice(agents, safeCursor, viewport);
  const rows = visible.map((a) => [STATUS_EMOJI[a.status] ?? "?", a.name, a.status, a.role]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Agents · popup (${safeCursor + 1}/${agents.length})`}
      hint="a attach · f free · x close · y yanks `mu agent send`"
    >
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((a, i) => {
          const sel = start + i === safeCursor;
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
