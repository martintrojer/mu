// Doctor card — health-check summary surfaced on the dashboard so
// the operator notices a broken state without remembering to run
// `mu doctor`. Aimed at the "btop / k9s health badge" UX: when
// every check is OK, the card is a quiet one-liner; when something
// is warn or fail, the failing rows surface the moment they appear.
//
// Per feat_card_9_doctor (workstream `tui-impl`), promoted from the
// LAST reserved slot in design_global_keymap. After this all 1-9
// slots are filled; slot 0 stays reserved by convention.
//
// CARD LAYOUT
//   glyph  check        STATUS   detail
//   ⚠      agents       warn     2 ghost panes; run `mu agent reconcile`
//   ✗      workspaces   fail     1 orphan dir blocking spawns
//
// Glyph + colour priority: ✗ (red) for fail, ⚠ (yellow) for warn,
// ✓ (green) for ok. The card BODY filters to non-OK rows; when
// nothing is wrong, the card renders a single "all healthy · ✓ K
// checks" line so the operator's eye learns to read the presence
// of rows as "something needs attention."
//
// CLIPPING POLICY (per feat_column_aligned_lists)
//   glyph, check, STATUS  → PROTECT (identifier; yankable check name)
//   detail                → CLIP    (free-form prose; can truncate)
//
// SUBTITLE
//   problemCount === 0  → "all healthy"
//   problemCount > 0    → "<problemCount>"
//
// DATA
//   - snapshot.doctor is populated by loadWorkstreamSnapshot when
//     called with `withDoctor: true`. The TUI's poll-loop hook
//     (src/cli/tui/state.ts) opts in. Static `mu state` and `mu
//     doctor` itself do not — `mu doctor`'s textual card is the
//     authoritative full diagnostic; this card is the dashboard
//     SIGNAL only. See src/doctor-summary.ts for the SDK seam.
//
// POPUP / FUTURE OBLIGATIONS (when slot-9 popup ships)
//   Out of scope NOW. Tracked by feat_more_cards_umbrella. When the
//   popup lands it MAY consume feat_popup_search_filter (`/`
//   filtering check names is useful) but NOT
//   feat_track_drill_chains_to_task_drill (rows aren't tasks). A
//   reasonable Enter-drill leaf is "show the full doctor card for
//   this check" or a one-line remediation hint; that's the popup
//   task's call. Until then, Shift+9 (`(`) stays a reserved noop.

import { Box, Text } from "ink";
import type { DoctorCheck } from "../../../doctor-summary.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { TitledBox } from "../titled-box.js";

export interface DoctorCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const ROW_LIMIT = 8;

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // check name
  { kind: "protect" }, // status (ok / warn / fail)
  { kind: "clip", min: 1 }, // detail (free-form)
];

export function DoctorCard({ snapshot }: DoctorCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  if (snapshot === null || snapshot.doctor === null) {
    return (
      <TitledBox title="Doctor" cardId={9}>
        <Text dimColor>loading…</Text>
      </TitledBox>
    );
  }

  const { checks, problemCount } = snapshot.doctor;
  const subtitle = formatSubtitle(problemCount);

  // Healthy path: render the quiet "✓ <K> checks" line so the
  // operator can confirm the card ran (vs. simply being empty).
  if (problemCount === 0) {
    return (
      <TitledBox title="Doctor" subtitle={subtitle} cardId={9}>
        <Text dimColor>
          <Text color="green">✓</Text> {checks.length} check
          {checks.length === 1 ? "" : "s"}
        </Text>
      </TitledBox>
    );
  }

  const problems = checks.filter((c) => c.status !== "ok");
  const shown = problems.slice(0, ROW_LIMIT);
  const rows = shown.map((c) => [glyphFor(c), c.name, c.status, c.detail]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox title="Doctor" subtitle={subtitle} cardId={9}>
      {shown.map((c, i) => {
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const [glyph = "", name = "", status = "", detail = ""] = padded;
        return (
          <Box key={c.name}>
            <Text>
              <Text color={colorForStatus(c.status)}>{glyph}</Text>
              {"  "}
              <Text bold>{name}</Text>
              {"  "}
              <Text color={colorForStatus(c.status)}>{status}</Text>
              {"  "}
              <Text dimColor>{detail}</Text>
            </Text>
          </Box>
        );
      })}
      {problems.length > ROW_LIMIT && (
        <Text dimColor>… +{problems.length - ROW_LIMIT} more · run `mu doctor`</Text>
      )}
    </TitledBox>
  );
}

// ─── pure helpers (exported for unit tests) ────────────────────────

/** Per-row glyph driven by the check's status. fail → ✗ (heavy
 *  ballot X, U+2717), warn → ⚠ (warning sign, U+26A0), ok → ✓
 *  (heavy check, U+2713). Same family as the Workspaces card's
 *  status glyphs; consistency over novelty. */
export function glyphFor(c: Pick<DoctorCheck, "status">): string {
  switch (c.status) {
    case "fail":
      return "✗";
    case "warn":
      return "⚠";
    case "ok":
      return "✓";
  }
}

/** Picocolors-compatible colour name for the status. fail → red,
 *  warn → yellow, ok → green. Used both for the glyph and the
 *  STATUS column so the row reads as a single visual unit. */
export function colorForStatus(s: DoctorCheck["status"]): string {
  switch (s) {
    case "fail":
      return "red";
    case "warn":
      return "yellow";
    case "ok":
      return "green";
  }
}

/** Subtitle: "all healthy" when problemCount===0, else the number.
 *  Kept terse so the title bar reads at a glance — when something is
 *  wrong, "Doctor · 2" is the load-bearing signal; the row body
 *  carries the names. */
export function formatSubtitle(problemCount: number): string {
  if (problemCount === 0) return "all healthy";
  return String(problemCount);
}
