// Activity-log popup (Shift+4 → `$`). Per design_popup_log.
//
// v0: list all snapshot.recent (newest at top), with j/k navigation.
// Auto-tail with scroll-pause + filters are deferred to v0.next.
//
// Enter on a focused row drills into a read-only inline view of the
// event's full untruncated payload. Long payloads (workspace-refresh
// events, multi-field task.claim notes, multi-line task notes
// summaries) clip in the list view per
// bug_tui_log_card_columns_misaligned; the drill is the
// single-source affordance for reading the full text. j/k scroll the
// drilled payload; q/Esc back to list. (Earlier versions of this
// popup left Enter UNBOUND on the assumption rows were always
// single-line atoms; user feedback proved that wrong — wrapped
// payloads needed the explicit drill-out.)
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: seq, ts, source, verb
// are PROTECTED (identity / numeric / short tokens); the payload rest
// is CLIPPABLE.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Db } from "../../../db.js";
import { classifyEventVerb, displayEventPayload } from "../../../logs.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { type ColumnSpec, contentWidthFromCols, layoutColumns, renderRow } from "../columns.js";
import { type PopupAction, type PopupActionEnvelope, dispatchPopupKeyFromInk } from "../keys.js";
import { ListRow } from "../list-row.js";
import { PopupShell } from "../popup-shell.js";
import { usePopupActionQueue } from "../use-popup-action-queue.js";
import { FilterPrompt, applyFilter, usePopupFilter } from "../use-popup-filter.js";
import { useTerminalSize } from "../use-terminal-size.js";
import { DrillScrollView, useDrillKeymap } from "./drill.js";
import { applyCursor, centredVisibleSlice, isNavAction } from "./scroll.js";
import { usePopupViewport } from "./viewport.js";

export interface PopupProps {
  yank: (command: string) => Promise<void>;
  onClose: () => void;
  snapshot: WorkstreamSnapshot | null;
  mode: "list" | "drill";
  onModeChange: (mode: "list" | "drill") => void;
  /** Bubbles the filter-prompt edit state up to <App> for StatusBar mode. */
  onFilterEditingChange?: (editing: boolean) => void;
  popupActions?: readonly PopupActionEnvelope[];
  db: Db;
  workstream: string;
}

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect", align: "right" }, // seq (#N)
  { kind: "protect" }, // ts
  { kind: "protect" }, // source
  { kind: "protect" }, // verb (or '·' fallback)
  { kind: "clip", min: 1 }, // rest / payload
];

export function LogPopup({
  yank,
  onClose,
  snapshot,
  mode,
  onModeChange,
  onFilterEditingChange,
  popupActions,
}: PopupProps): JSX.Element {
  const { cols } = useTerminalSize();
  const contentWidth = contentWidthFromCols(cols);
  // Per-render viewport from stdout.rows minus the popup chrome budget;
  // see popups/viewport.ts. Replaces the prior hardcoded VIEWPORT = 20
  // — used for BOTH the slice size AND the cursor-centring half-window.
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });
  const sourceEvents = snapshot?.recent ?? [];
  // Per spec: blob = `${verb} ${rest} ${source}` — we classify the
  // event payload to extract the same verb/rest the row renders, so
  // searching for e.g. "task close" matches what the user sees.
  const events = applyFilter(sourceEvents, flt.query, (e) => {
    const payload = displayEventPayload(e.payload);
    const cls = classifyEventVerb(payload);
    const verb = cls?.verb ?? "";
    const rest = cls?.rest ?? payload;
    return `${verb} ${rest} ${e.source}`;
  });
  const safeCursor = events.length === 0 ? 0 : Math.min(cursor, events.length - 1);
  const focused = events[safeCursor];

  const drillBody = focused ? displayEventPayload(focused.payload) : "";
  const drill = useDrillKeymap({
    body: drillBody,
    viewport,
    onClose: () => onModeChange("list"),
    onYank: () => {
      if (!focused || !snapshot) return;
      const since = Math.max(0, focused.seq - 1);
      return yank(`mu log --since ${since} -n 1 -w ${snapshot.workstreamName}`);
    },
    resetKey: focused?.seq ?? "",
  });

  const dispatchListAction = (action: PopupAction) => {
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (action.kind === "setCursor" || isNavAction(action)) {
      setCursor((c) => applyCursor(c, action, events.length, viewport));
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
        if (focused !== undefined) {
          onModeChange("drill");
        }
        return;
      case "yank": {
        const e = events[safeCursor];
        if (!e || !snapshot) return;
        // Yank the show-related-task / show-related-agent if we
        // can classify; else just yank the raw payload as a
        // reference.
        const payload = displayEventPayload(e.payload);
        const cls = classifyEventVerb(payload);
        if (cls === null) {
          void yank(`# event: ${payload}`);
          return;
        }
        // Pull the first whitespace-separated token from `rest` —
        // usually the entity id.
        const rest = cls.rest.trim();
        const id = rest.split(/[\s(]/)[0];
        if (cls.verb.startsWith("task ")) {
          void yank(`mu task show ${id} -w ${snapshot.workstreamName}`);
        } else if (cls.verb.startsWith("agent ")) {
          void yank(`mu agent show ${id} -w ${snapshot.workstreamName}`);
        } else {
          void yank(`# event: ${payload}`);
        }
        return;
      }
    }
  };

  usePopupActionQueue(popupActions, dispatchListAction);

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    dispatchListAction(dispatchPopupKeyFromInk(input, key));
  });

  if (snapshot === null) {
    return <PopupShell title="Activity log · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (mode === "drill" && focused !== undefined) {
    return (
      <PopupShell title={`Activity log · #${focused.seq} (${focused.createdAt.slice(11, 19)})`}>
        <Box flexDirection="column" flexGrow={1}>
          <DrillScrollView
            title="event payload"
            body={drillBody}
            viewport={viewport}
            scrollTop={drill.scrollTop}
            wrappedBody={drill.wrappedBody}
            emptyText="(empty payload)"
            hint="y yanks `mu log --since N -n 1`"
          />
        </Box>
      </PopupShell>
    );
  }
  if (sourceEvents.length === 0) {
    return (
      <PopupShell title="Activity log · popup">
        <Text dimColor>(no events yet)</Text>
      </PopupShell>
    );
  }
  if (events.length === 0) {
    return (
      <PopupShell title="Activity log · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  // Centre the cursor in the viewport. `viewport` is BOTH the slice
  // size and the half-window for centring — must use the per-render
  // value consistently (see CAVEAT in bug_tui_popup_data_doesnt_fill).
  const { visible } = centredVisibleSlice(events, safeCursor, viewport);

  const rows = visible.map((e) => {
    const payload = displayEventPayload(e.payload);
    const cls = classifyEventVerb(payload);
    const ts = e.createdAt.slice(11, 19);
    const verb = cls?.verb ?? "·";
    const rest = cls?.rest ?? payload;
    return [`#${e.seq}`, ts, e.source, verb, rest];
  });
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Activity log · popup (${safeCursor + 1}/${events.length})`}
      hint="y yanks the related `mu task/agent show` command"
    >
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((e, i) => {
          const sel = events.indexOf(e) === safeCursor;
          const cls = classifyEventVerb(displayEventPayload(e.payload));
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const colors = [
            { dimColor: true }, // seq
            { dimColor: true }, // ts
            { dimColor: true }, // source
            cls ? { color: "cyan" } : { dimColor: true }, // verb
            undefined, // rest
          ];
          return (
            <ListRow
              key={e.seq}
              cells={padded}
              contentWidth={contentWidth}
              colors={colors}
              selected={sel}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
  );
}
