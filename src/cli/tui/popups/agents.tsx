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
import { type ColumnSpec, layoutColumns, renderRow } from "../columns.js";
import { dispatchPopupKey } from "../keys.js";
import { DrillScrollView, clampScrollTop } from "./drill.js";

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
  { kind: "protect" }, // glyph
  { kind: "protect" }, // agent name
  { kind: "protect" }, // status token
  { kind: "clip", min: 1 }, // role
];

const SCROLLBACK_LINES = 80;
const VIEWPORT = 20;

export function AgentsPopup({
  yank,
  onClose,
  snapshot,
  mode,
  onModeChange,
  db,
  workstream,
}: PopupProps): JSX.Element {
  const [cursor, setCursor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollback, setScrollback] = useState<string>("");
  const [scrollbackErr, setScrollbackErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const agents = snapshot?.view.agents ?? [];
  const focused = agents[cursor];

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
      // Drill-mode keymap: j/k scroll, Ctrl-D/U half-viewport,
      // Esc/q back to list. Yank / verbs / drill are intentionally
      // suppressed in drill (it's a read-only detail view).
      const totalLines = scrollback === "" ? 0 : scrollback.split("\n").length;
      switch (action.kind) {
        case "close":
          onModeChange("list");
          return;
        case "moveDown":
          setScrollTop((s) => clampScrollTop(s + 1, totalLines, VIEWPORT));
          return;
        case "moveUp":
          setScrollTop((s) => clampScrollTop(s - 1, totalLines, VIEWPORT));
          return;
        case "jumpTop":
          setScrollTop(0);
          return;
        case "jumpBottom":
          setScrollTop(clampScrollTop(totalLines, totalLines, VIEWPORT));
          return;
        case "pageDown":
          setScrollTop((s) =>
            clampScrollTop(s + Math.floor(VIEWPORT / (action.half ? 2 : 1)), totalLines, VIEWPORT),
          );
          return;
        case "pageUp":
          setScrollTop((s) =>
            clampScrollTop(s - Math.floor(VIEWPORT / (action.half ? 2 : 1)), totalLines, VIEWPORT),
          );
          return;
        default:
          return;
      }
    }
    switch (action.kind) {
      case "close":
        onClose();
        return;
      case "drill":
        if (focused) onModeChange("drill");
        return;
      case "moveDown":
        setCursor((c) => Math.min(agents.length - 1, c + 1));
        return;
      case "moveUp":
        setCursor((c) => Math.max(0, c - 1));
        return;
      case "jumpTop":
        setCursor(0);
        return;
      case "jumpBottom":
        setCursor(Math.max(0, agents.length - 1));
        return;
      case "yank": {
        const a = agents[cursor];
        if (!a || !snapshot) return;
        const ws = snapshot.workstreamName;
        // Default yank: a `mu agent send` template the user can
        // edit. The popup-verb keys f / x cover free / close.
        void yank(`mu agent send ${a.name} '...' -w ${ws}`);
        return;
      }
      case "verb": {
        const a = agents[cursor];
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
    return <Shell title="Agents · popup">{<Text dimColor>loading…</Text>}</Shell>;
  }
  if (agents.length === 0) {
    return (
      <Shell title="Agents · popup">
        <Text dimColor>(no agents)</Text>
      </Shell>
    );
  }

  if (mode === "drill" && focused) {
    return (
      <Shell title={`Agents · ${focused.name} (scrollback)`}>
        <DrillScrollView
          title={`mu agent read ${focused.name} -n ${SCROLLBACK_LINES}`}
          body={scrollbackErr !== null ? `error: ${scrollbackErr}` : scrollback}
          viewport={VIEWPORT}
          scrollTop={scrollTop}
          hint={loading ? "loading…" : undefined}
          emptyText="(no scrollback yet)"
        />
        <Box marginTop={1}>
          <Text dimColor>
            j/k scroll · Ctrl-D/U half page · g/G top/bottom · Esc/q back to list
          </Text>
        </Box>
      </Shell>
    );
  }

  const rows = agents.map((a) => [STATUS_EMOJI[a.status] ?? "?", a.name, a.status, a.role]);
  const widths = layoutColumns(rows, COLUMN_SPECS);

  return (
    <Shell title={`Agents · popup (${cursor + 1}/${agents.length})`}>
      {agents.map((a, i) => {
        const sel = i === cursor;
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const [glyph = "", name = "", status = "", role = ""] = padded;
        return (
          <Box key={a.name}>
            <Text inverse={sel}>
              <Text>{glyph}</Text>
              {"  "}
              <Text bold>{name}</Text>
              {"  "}
              <Text dimColor>{status}</Text>
              {"  "}
              <Text dimColor>{role}</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        {/* Popup-specific verbs only; generic j/k/y/Esc/? live in the global status bar. */}
        <Text dimColor>Enter scrollback · f free · x close</Text>
      </Box>
    </Shell>
  );
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
