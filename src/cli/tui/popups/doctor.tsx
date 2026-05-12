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
import { type DoctorCheck, loadDoctorChecks } from "../../../doctor-summary.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import { colorForStatus, glyphFor } from "../cards/doctor.js";
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
  db,
  workstream: _workstream,
}: PopupProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
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
  const checks =
    mode === "drill"
      ? sourceChecks
      : applyFilter(sourceChecks, flt.query, (c) => `${c.name} ${c.status} ${c.detail}`);
  const safeCursor = checks.length === 0 ? 0 : Math.min(cursor, checks.length - 1);
  const focused = checks[safeCursor];

  // Drill body: pre-formatted text rendered via DrillScrollView.
  // Pure derivation from the focused check; no DB call.
  const drillBody = focused ? renderDrillBody(focused) : "";
  const drill = useDrillKeymap({
    body: drillBody,
    viewport,
    onClose: () => onModeChange("list"),
    onYank: () => {
      if (!focused) return;
      return yank(yankCommandForCheck(focused));
    },
  });

  useInput((input, key) => {
    if (mode !== "drill" && flt.onKey(input, key) === "consumed") return;
    const action = dispatchPopupKeyFromInk(input, key);
    if (mode === "drill") {
      drill.dispatch(action);
      return;
    }
    if (isNavAction(action)) {
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
          onModeChange("drill");
        }
        return;
      case "yank":
        if (!focused) return;
        void yank(yankCommandForCheck(focused));
        return;
    }
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

  if (mode === "drill" && focused) {
    return (
      <PopupShell title={`Doctor · ${focused.name} (detail)`}>
        <Box flexDirection="column" flexGrow={1}>
          <DrillScrollView
            title={`${focused.name} · ${focused.status}`}
            body={drillBody}
            viewport={viewport}
            scrollTop={drill.scrollTop}
            emptyText="(no detail)"
            hint={`y yanks \`${yankCommandForCheck(focused)}\``}
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

// ─── pure helpers (exported for unit tests) ────────────────────────

/**
 * Map a check row to the most useful informational command the
 * operator might paste. Read-only by construction: `mu agent list`,
 * `mu workspace orphans`, `mu doctor` are all SELECT-shape verbs;
 * `# ...` lines are visibly inert. Per the spec KEY MAP block this
 * is INFORMATIONAL, never a mutating recipe — so even when the
 * check is `fail`, we yank the diagnostic verb the operator should
 * RUN MANUALLY, not a fix command.
 *
 * Pure; exported for unit tests.
 */
export function yankCommandForCheck(check: Pick<DoctorCheck, "name" | "status">): string {
  switch (check.name) {
    case "agents":
      // Diagnostic: list live + ghost panes. Operator decides
      // whether to `mu agent close` from the list output.
      return "mu agent list";
    case "panes":
      // Orphan tmux panes — the standard adoption recipe.
      return "mu agent adopt";
    case "workspaces":
      // Diagnostic: list orphan workspace dirs. Operator decides
      // whether to `mu workspace free` from the list output.
      return "mu workspace orphans";
    case "schema":
    case "schema_version":
    case "journal_mode":
    case "foreign_keys":
      // No actionable mutation an operator should yank for
      // schema-shape checks (the migration runner is the SDK seam,
      // not a CLI verb). Yank a no-op comment so the muscle memory
      // of `y` still gives feedback. When fail, the textual
      // `mu doctor` carries the full diagnostic.
      return `# ${check.name}: see \`mu doctor\` for full diagnostic`;
    default:
      // Forward-compat: any future check name falls back to the
      // textual `mu doctor` verb. Read-only.
      return "mu doctor";
  }
}

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

/**
 * A short paragraph (one paragraph per check name) explaining the
 * shape of the failure / warning. Lives here rather than in
 * doctor-summary.ts because it's a render concern (longer than
 * the card's one-line summary) and the SDK seam stays focused on
 * the `{name, status, detail}` triple.
 *
 * Pure; exported for unit tests.
 */
export function remediationParagraph(check: DoctorCheck): readonly string[] {
  switch (check.name) {
    case "agents":
      return [
        "A 'ghost pane' is a tmux pane that mu's reconcile pass would",
        "prune on the next mutation. Run `mu agent list` to see the",
        "current state, then `mu agent close <name>` if the agent is",
        "stale. The TUI is read-only — no auto-prune.",
      ];
    case "panes":
      return [
        "An 'orphan pane' is a live tmux pane in the workstream's",
        "session that mu doesn't know about. Adopt it via",
        "`mu agent adopt <pane-id>` to register it as a managed agent,",
        "or kill it manually if it's not yours.",
      ];
    case "workspaces":
      return [
        "An 'orphan workspace dir' is a per-agent VCS workspace under",
        "the workstream that has no matching mu agent row. Run",
        "`mu workspace orphans -w <ws>` to list them, then",
        "`mu workspace free <agent>` to release each one.",
      ];
    case "schema":
      return [
        "Missing tables typically mean an older mu binary opened the",
        "DB without running migrations. Rebuild mu (npm run build)",
        "and re-open; openDb runs the migration block on every",
        "process start.",
      ];
    case "schema_version":
      return [
        "Schema version mismatch means the DB was opened by a",
        "different mu binary than the one running now. If `<` the",
        "expected version, openDb should have migrated — check the",
        "build. If `>` the expected, you may have a downgrade in",
        "progress; restore from a snapshot rather than continuing.",
      ];
    case "journal_mode":
      return [
        "WAL is the default journal mode for SQLite under mu. A",
        "different mode (e.g. `delete`) means an external tool",
        "rewrote the DB pragma. Re-open the DB with mu to restore.",
      ];
    case "foreign_keys":
      return [
        "Foreign keys must be ON for mu's CASCADE deletes to work.",
        "An OFF value usually means an external SQLite client opened",
        "the DB without `PRAGMA foreign_keys = ON`. Re-open with mu.",
      ];
    default:
      return ["See `mu doctor` for the canonical textual diagnostic."];
  }
}
