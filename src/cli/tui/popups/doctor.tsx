// Doctor popup (Shift+9 → `(`). The drill-down for the Doctor card.
//
// Per feat_popup_9_doctor (workstream `tui-impl`): list of every
// doctor check (NOT just the non-OK subset Card 9 surfaces) with
// j/k navigation, '/' substring filter (via use-popup-filter), `y`
// to yank a remediation HINT (informational only — never a
// mutating verb), and Enter to drill into a small ad-hoc detail
// view of the focused check.
//
// IMPORTANT — DRILL IS NOT TaskDetailDrill. Rows are doctor checks,
// not tasks; the popup-recursion contract from
// feat_track_drill_chains_to_task_drill does NOT apply. The drill
// view renders the focused check's name, status, detail, and a
// multi-line remediation hint via the shared DrillScrollView leaf.
//
// COLUMN SHAPE (matches Card 9's row vocabulary):
//   glyph   check        STATUS   detail
//   PROTECT PROTECT      PROTECT  CLIP
//
// Per feat_column_aligned_lists clipping policy: glyph + name +
// status are PROTECTED (identity-bearing); only `detail` is
// CLIPPABLE.
//
// READ-ONLY (per ROADMAP pledge). The only act-intent is `y`,
// which yanks an INFORMATIONAL command (the row's diagnostic
// recipe). Schema/journal_mode/foreign_keys checks have no
// mutating recovery the operator can yank, so we yank a `# ...`
// comment line — visibly inert, satisfies the muscle-memory of
// "press y, paste, see something". No verb in the yank matrix
// here mutates the DB or pane state.
//
// Per ROADMAP pledge: ink/react import limited to src/cli/tui/*.

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Db } from "../../../db.js";
import {
  type DoctorCheck,
  loadDoctorChecks,
  remediationParagraph,
  yankCommandForCheck,
} from "../../../doctor-summary.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { colorForStatus, glyphFor } from "../cards/doctor.js";
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
  { kind: "protect" }, // glyph
  { kind: "protect" }, // check name
  { kind: "protect" }, // status (ok / warn / fail)
  { kind: "clip", min: 1 }, // detail (free-form; CLIPPABLE)
];

export function DoctorPopup({
  yank,
  onClose,
  snapshot,
  mode,
  onModeChange,
  onFilterEditingChange,
  popupActions,
  db,
  workstream: _workstream,
}: PopupProps): JSX.Element {
  const { cols } = useTerminalSize();
  const contentWidth = contentWidthFromCols(cols);
  // Per-render viewport from stdout.rows minus the popup chrome
  // budget; see popups/viewport.ts.
  const viewport = usePopupViewport();
  const [cursor, setCursor] = useState(0);
  const flt = usePopupFilter({ onEditingChange: onFilterEditingChange });

  // Source rows: ALL checks (OK + warn + fail), NOT just the non-OK
  // subset Card 9 renders. We refresh on every render — the SDK
  // call is a handful of synchronous DB pragmas + COUNT-shape
  // SELECTs (see src/doctor-summary.ts) so it's cheap even on the
  // popup's typing-intensive '/' filter loop. Snapshot.doctor (the
  // card's slice) only carries the truncated set, so we re-derive
  // the full one here.
  const sourceChecks: readonly DoctorCheck[] = snapshot ? loadDoctorChecks(db, snapshot) : [];

  // Per spec FILTER block: blob = `${name} ${status} ${detail}`.
  // Per bug_filter_drill_opens_wrong_task: text filter applied
  // UNIFORMLY across list and drill modes (the previous mode-conditional
  // dropped the filter on drill, shifting `checks` under a constant
  // cursor index).
  const checks = applyFilter(sourceChecks, flt.query, (c) => `${c.name} ${c.status} ${c.detail}`);
  const safeCursor = checks.length === 0 ? 0 : Math.min(cursor, checks.length - 1);
  const focused = checks[safeCursor];

  // Defensive: capture focused check identity at Enter so the drill
  // stays pinned even if checks shift.
  const [drilledCheck, setDrilledCheck] = useState<DoctorCheck | null>(null);
  const drillCheck = mode === "drill" ? (drilledCheck ?? focused) : focused;

  // Drill body: pre-formatted text rendered via DrillScrollView.
  // Pure derivation from the captured check; no DB call.
  const drillBody = drillCheck ? renderDrillBody(drillCheck) : "";
  const drill = useDrillKeymap({
    body: drillBody,
    viewport,
    onClose: () => {
      setDrilledCheck(null);
      onModeChange("list");
    },
    onYank: () => {
      if (!drillCheck) return;
      return yank(yankCommandForCheck(drillCheck));
    },
    resetKey: drillCheck?.name ?? "",
  });

  const dispatchListAction = (action: PopupAction) => {
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (action.kind === "setCursor" || isNavAction(action)) {
      setCursor((c) => applyCursor(c, action, checks.length, viewport));
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
          setDrilledCheck(focused);
          onModeChange("drill");
        }
        return;
      case "yank":
        if (!focused) return;
        void yank(yankCommandForCheck(focused));
        return;
    }
  };

  usePopupActionQueue(popupActions, dispatchListAction);

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    dispatchListAction(dispatchPopupKeyFromInk(input, key));
  });

  if (snapshot === null) {
    return <PopupShell title="Doctor · popup">{<Text dimColor>loading…</Text>}</PopupShell>;
  }
  if (sourceChecks.length === 0) {
    return (
      <PopupShell title="Doctor · popup">
        <Text dimColor>(no checks ran — `mu doctor` should always return ≥ 1 row)</Text>
      </PopupShell>
    );
  }
  if (checks.length === 0) {
    return (
      <PopupShell title="Doctor · popup">
        <Box flexDirection="column" flexGrow={1}>
          <Text dimColor>(no matches for "{flt.query}")</Text>
        </Box>
        <FilterPrompt state={flt} />
      </PopupShell>
    );
  }

  if (mode === "drill" && drillCheck) {
    return (
      <PopupShell title={`Doctor · ${drillCheck.name} (detail)`}>
        <Box flexDirection="column" flexGrow={1}>
          <DrillScrollView
            title={`${drillCheck.name} · ${drillCheck.status}`}
            body={drillBody}
            viewport={viewport}
            scrollTop={drill.scrollTop}
            wrappedBody={drill.wrappedBody}
            emptyText="(no detail)"
            hint={`y yanks \`${yankCommandForCheck(drillCheck)}\``}
          />
        </Box>
      </PopupShell>
    );
  }

  const { start, visible } = centredVisibleSlice(checks, safeCursor, viewport);
  const rows = visible.map((c) => [glyphFor(c), c.name, c.status, c.detail]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <PopupShell
      title={`Doctor · popup (${safeCursor + 1}/${checks.length})`}
      hint="y yanks remediation hint (informational)"
    >
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((c, i) => {
          const selected = start + i === safeCursor;
          const row = rows[i];
          if (row === undefined) return null;
          const padded = renderRow(row, widths, COLUMN_SPECS);
          const statusColor = colorForStatus(c.status);
          const colors = [
            { color: statusColor }, // glyph
            { bold: true }, // name
            { color: statusColor }, // status
            { dimColor: true }, // detail
          ];
          return (
            <ListRow
              key={c.name}
              cells={padded}
              contentWidth={contentWidth}
              colors={colors}
              selected={selected}
            />
          );
        })}
      </Box>
      <FilterPrompt state={flt} />
    </PopupShell>
  );
}

// ─── pure helpers (drill body render — pure-helpers MOVED) ──────────
//
// `yankCommandForCheck` + `remediationParagraph` previously lived
// here. They moved to src/doctor-summary.ts per
// review_tui_doctor_remediation_lives_in_popup — they have no
// rendering concern, and keeping them next to the `DoctorCheck`
// type means a future check is a single touchpoint instead of two.
// `renderDrillBody` STAYS here because it interleaves
// summary/status/detail/separator lines for the popup drill view.

/**
 * Pre-format the focused check as a multi-line drill body. Pure;
 * exported for unit tests. Lines:
 *
 *   <NAME>
 *   status:    <ok | warn | fail>
 *   detail:    <free-form>
 *   (blank)
 *   <multi-line remediation hint>
 *
 * The remediation hint is a short paragraph that explains what
 * the operator should run / look at next. Same vocabulary as the
 * yank recipe (yankCommandForCheck) so the user sees the same
 * verb in the body and on `y`.
 */
export function renderDrillBody(check: DoctorCheck): string {
  const lines: string[] = [];
  lines.push(check.name);
  lines.push("");
  lines.push(`status:  ${check.status}`);
  lines.push(`detail:  ${check.detail}`);
  lines.push("");
  lines.push("remediation hint (informational):");
  lines.push(`  ${yankCommandForCheck(check)}`);
  lines.push("");
  for (const ln of remediationParagraph(check)) lines.push(ln);
  return lines.join("\n");
}
