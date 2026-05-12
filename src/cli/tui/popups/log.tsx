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
import { useEffect, useState } from "react";
import type { Db } from "../../../db.js";
import { classifyEventVerb } from "../../../logs.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { dispatchPopupKeyFromInk } from "../keys.js";
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
}: PopupProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  // Per-render viewport from stdout.rows minus the popup chrome budget;
  // see popups/viewport.ts. Replaces the prior hardcoded VIEWPORT = 20
  // — used for BOTH the slice size AND the cursor-centring half-window.
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const flt = usePopupFilter();
  const sourceEvents = snapshot?.recent ?? [];
  // Per spec: blob = `${verb} ${rest} ${source}` — we classify the
  // event payload to extract the same verb/rest the row renders, so
  // searching for e.g. "task close" matches what the user sees.
  const events = applyFilter(sourceEvents, flt.query, (e) => {
    const cls = classifyEventVerb(e.payload);
    const verb = cls?.verb ?? "";
    const rest = cls?.rest ?? e.payload;
    return `${verb} ${rest} ${e.source}`;
  });
  const safeCursor = events.length === 0 ? 0 : Math.min(cursor, events.length - 1);
  const focused = events[safeCursor];
  // Drill-mode body scroll. Reset to 0 when entering drill (see the
  // `case "drill"` branch below) and on backing out, mirroring the
  // ready.tsx / agents.tsx pattern — callers own the reset; we don't
  // need a useEffect-on-cursor (which lints under
  // useExhaustiveDependencies because safeCursor is derived).
  const [detailScrollTop, setDetailScrollTop] = useState(0);
  useEffect(() => {
    onFilterEditingChange?.(flt.editing);
  }, [flt.editing, onFilterEditingChange]);

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    const action = dispatchPopupKeyFromInk(input, key);
    if (mode === "drill") {
      // Drill-mode payload view. Nav cluster funnels through
      // applyScroll; Esc/q backs to list; y yanks single-event
      // lookup. Filter / verb / drill-again are intentionally
      // suppressed (read-only view).
      const totalLines =
        focused === undefined || focused.payload === "" ? 0 : focused.payload.split("\n").length;
      if (isNavAction(action)) {
        setDetailScrollTop((s) => applyScroll(s, action, totalLines, viewport));
        return;
      }
      switch (action.kind) {
        case "close":
          onModeChange("list");
          setDetailScrollTop(0);
          return;
        case "yank": {
          if (!focused || !snapshot) return;
          // Show exactly that single event by seq: --since <seq-1>
          // -n 1 returns just the entry whose seq is `focused.seq`.
          // The CLI has no native single-seq filter; this is the
          // smallest composable equivalent.
          const since = Math.max(0, focused.seq - 1);
          void yank(`mu log --since ${since} -n 1 -w ${snapshot.workstreamName}`);
          return;
        }
        default:
          return;
      }
    }
    if (isNavAction(action)) {
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
          setDetailScrollTop(0);
          onModeChange("drill");
        }
        return;
      case "yank": {
        const e = events[safeCursor];
        if (!e || !snapshot) return;
        // Yank the show-related-task / show-related-agent if we
        // can classify; else just yank the raw payload as a
        // reference.
        const cls = classifyEventVerb(e.payload);
        if (cls === null) {
          void yank(`# event: ${e.payload}`);
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
          void yank(`# event: ${e.payload}`);
        }
        return;
      }
    }
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
            body={focused.payload}
            viewport={viewport}
            scrollTop={detailScrollTop}
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
  const start = Math.max(
    0,
    Math.min(events.length - viewport, safeCursor - Math.floor(viewport / 2)),
  );
  const visible = events.slice(start, start + viewport);

  const rows = visible.map((e) => {
    const cls = classifyEventVerb(e.payload);
    const ts = e.createdAt.slice(11, 19);
    const verb = cls?.verb ?? "·";
    const rest = cls?.rest ?? e.payload;
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
          const cls = classifyEventVerb(e.payload);
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
