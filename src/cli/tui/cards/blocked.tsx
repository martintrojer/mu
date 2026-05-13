// Blocked card — every OPEN task with at least one still-gating
// blocker (i.e. a non-CLOSED prerequisite). Fills the diagnostic gap
// described in feat_card_7_blocked (workstream `tui-impl`):
//
//   "What's blocking the umbrella?" is the most common diagnostic
//   question during multi-wave orchestration. Today the operator must
//   walk the dependency tree manually via `mu task tree <id>`. One
//   glanceable card surfaces the blocked-tasks subset directly.
//
// Card 7 promotes a slot reserved by design_global_keymap. Mirrors
// the shape of Card 5 — Workspaces (264585f9) and Card 6 — In-progress
// (760fc6c) so the operator reads it the same way: TitledBox header,
// column-aligned rows, glanceable subtitle.
//
// CARD LAYOUT
//   glyph  id           STATUS   #blocks   ROI    title
//   ⛓      review_x     OPEN     2          75    Review X
//   ⛓      cherry_x     OPEN     1          60    Cherry-pick X
//
// Glyph ⛓ (chain link, U+26D3) reads as "this is blocked / chained
// to something". Coloured dim — the operator's eye is meant to land
// on the #blockers / top-blocker subtitle, not the row glyph.
// STATUS column is a stable "OPEN" string (the BLOCKED view filters
// to OPEN by definition — see src/db.ts BLOCKED_VIEW_SQL); kept in
// the row for visual consistency with the other task lists.
//
// CLIPPING POLICY (per feat_column_aligned_lists)
//   id, STATUS, #blocks, ROI → PROTECT (yankable / numeric / identifier)
//   title                    → CLIP    (free-form prose)
//
// SUBTITLE
//   empty       → omitted (no blocked tasks → empty-state body)
//   populated   → "<N>"                       when no top blocker
//                 "<N> · top blocker: <id>"   otherwise
//
// "Top blocker" = the still-gating blocker (status ≠ CLOSED) that
// appears most often across the visible blocked rows. Ties broken by
// the blocker's local id (alphabetic). This surfaces the single
// task that, if closed, would unblock the most downstream work — the
// most actionable hint at a glance. Computed over the visible (≤
// ROW_LIMIT) rows, not the full blocked list, so the displayed top
// blocker is one the operator can correlate against the rendered
// rows.
//
// DATA
//   - snapshot.blocked is the OPEN-with-unsatisfied-blockers slice
//     from the BLOCKED SQL view. Used directly.
//   - per-row blocker counts come from getTaskEdgesWithStatus(db, id,
//     ws), filtered to non-CLOSED. ROW_LIMIT (8) caps the per-tick
//     SQLite reads at 8 prepared-statement queries — orders of
//     magnitude cheaper than the per-row `git status --porcelain`
//     shellouts the Workspaces card already does. No SDK extension
//     per the task brief.
//
// POPUP / FUTURE OBLIGATIONS (when slot-7 popup ships)
//   Out of scope NOW. When the popup is added under
//   feat_more_cards_umbrella, it MUST consume:
//     (a) feat_popup_search_filter — '/' filter via usePopupFilter
//     (b) feat_track_drill_chains_to_task_drill — Enter chains rows
//         into TaskDetailDrill (rows ARE tasks)
//   Until then, Shift+7 (`&`) stays a reserved noop in keys.ts.

import { Text } from "ink";
import type { Db } from "../../../db.js";
import { type WorkstreamSnapshot, roiBucket } from "../../../state.js";
import { type TaskEdgeWithStatus, getTaskEdgesWithStatus } from "../../../tasks.js";
import { inkColorForStatus } from "../../format.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { colorForBucket, formatRoi } from "../format-helpers.js";
import { CARD_CONFIGS, cardRenderHeight } from "../layout.js";
import { ListRow } from "../list-row.js";
import { PaddedRows } from "../padded-rows.js";
import { TitledBox } from "../titled-box.js";

export interface BlockedCardProps {
  snapshot: WorkstreamSnapshot | null;
  db: Db;
  workstream: string;
  rowBudget?: number;
  cols?: number;
}

export const cardConfig = CARD_CONFIGS[7];

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // task id
  { kind: "protect" }, // status (always OPEN; constant for now)
  { kind: "protect", align: "right" }, // #blockers
  { kind: "protect", align: "right" }, // ROI label (e.g. "75")
  { kind: "clip", min: 1 }, // title
];

export function BlockedCard({
  snapshot,
  db,
  workstream,
  rowBudget,
  cols,
}: BlockedCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(cols ?? termColsForLayout());
  if (snapshot === null) {
    return (
      <TitledBox
        height={cardRenderHeight(cardConfig, rowBudget)}
        width={cols}
        title="Blocked"
        cardId={7}
      >
        <PaddedRows rows={rowBudget ?? cardConfig.minRows}>
          <Text dimColor>loading…</Text>
        </PaddedRows>
      </TitledBox>
    );
  }

  const { blocked } = snapshot;

  if (blocked.length === 0) {
    return (
      <TitledBox
        height={cardRenderHeight(cardConfig, rowBudget)}
        width={cols}
        title="Blocked"
        cardId={7}
      >
        <PaddedRows rows={rowBudget ?? cardConfig.minRows}>
          <Text dimColor>(none blocked)</Text>
        </PaddedRows>
      </TitledBox>
    );
  }

  const shown = blocked.slice(0, rowBudget ?? cardConfig.maxRows);
  const more = blocked.length - shown.length;
  const bottomLabel = more > 0 ? `+${more} more · Shift+7` : undefined;
  // One getTaskEdgesWithStatus call per visible row. Cap at 8 →
  // synchronous better-sqlite3 reads on a join, vastly cheaper than
  // the per-row shellouts the Workspaces card does.
  const blockerLists = shown.map((t) =>
    stillGating(getTaskEdgesWithStatus(db, t.name, workstream).blockers),
  );
  const topBlocker = pickTopBlocker(blockerLists);
  const subtitle = formatSubtitle(blocked.length, topBlocker);

  const meta = shown.map((t) => {
    const bucket = roiBucket(t.impact, t.effortDays);
    const roiText = formatRoi(t.impact, t.effortDays);
    return { bucket, roiText };
  });
  const rows = shown.map((t, i) => [
    glyphFor(),
    t.name,
    t.status,
    String(blockerLists[i]?.length ?? 0),
    meta[i]?.roiText ?? "",
    t.title,
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox
      height={cardRenderHeight(cardConfig, rowBudget)}
      width={cols}
      title="Blocked"
      subtitle={subtitle}
      cardId={7}
      bottomLabel={bottomLabel}
    >
      {shown.map((t, i) => {
        const row = rows[i];
        const m = meta[i];
        if (row === undefined || m === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const colors = [
          { dimColor: true }, // glyph
          { bold: true }, // id
          { color: inkColorForStatus(t.status) }, // status
          { color: "yellow" }, // blocks
          { color: colorForBucket(m.bucket) }, // roi
          { dimColor: true }, // title
        ];
        return <ListRow key={t.name} cells={padded} contentWidth={contentWidth} colors={colors} />;
      })}
    </TitledBox>
  );
}

// ─── pure helpers (exported for unit tests) ────────────────────────

/** Glyph for a blocked row. Always the chain-link (⛓). The colour
 *  is applied at the call site; the function returns just the glyph
 *  so tests can assert on the codepoint without coupling to ink.
 *  Argumentless because the glyph never depends on the row
 *  (review_dead_code_glyph_for_unused — was previously
 *  `glyphFor(_t: TaskRow)` for plug-in symmetry that no caller
 *  needed; the anticipatory parameter ran afoul of AGENTS.md's
 *  no-anticipatory-abstraction pledge). */
export function glyphFor(): string {
  return "⛓";
}

/** Filter a list of blockers to the still-gating ones. A blocker is
 *  still-gating iff its status is not CLOSED — REJECTED and DEFERRED
 *  still block downstream work (they're terminal/parked from the
 *  perspective of "is this a goal", but only CLOSED satisfies a
 *  blocked-by edge per the BLOCKED view in src/db.ts). Returns a new
 *  array; does not mutate. */
export function stillGating(blockers: ReadonlyArray<TaskEdgeWithStatus>): TaskEdgeWithStatus[] {
  return blockers.filter((b) => b.status !== "CLOSED");
}

/** Pick the still-gating blocker that appears most often across the
 *  given per-row blocker lists. Ties broken by alphabetic blocker
 *  local id. Returns null when no blockers are present (all rows
 *  somehow had every blocker satisfied — defensive: shouldn't happen
 *  given the BLOCKED view, but the empty-input branch keeps the
 *  function total).
 *
 *  Surfacing the most-shared blocker is the most actionable hint —
 *  closing it unblocks the most downstream rows in one move. */
export function pickTopBlocker(
  blockerLists: ReadonlyArray<ReadonlyArray<TaskEdgeWithStatus>>,
): string | null {
  const counts = new Map<string, number>();
  for (const list of blockerLists) {
    for (const b of list) {
      counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  // Iterate in alphabetic order so ties resolve deterministically
  // (Map iteration is insertion order; we explicitly sort the keys).
  for (const name of [...counts.keys()].sort()) {
    const c = counts.get(name) ?? 0;
    if (c > bestCount) {
      best = name;
      bestCount = c;
    }
  }
  return best;
}

/** Build the subtitle: "<total>" or "<total> · top blocker: <id>".
 *  topBlocker null → omit the leg (defensive; shouldn't happen for
 *  the rendered path — populated blocked => at least one blocker
 *  exists by definition of the BLOCKED view — but the formatter is
 *  defensive against an empty blocker-list slice). */
export function formatSubtitle(total: number, topBlocker: string | null): string {
  const parts: string[] = [String(total)];
  if (topBlocker !== null) parts.push(`top blocker: ${topBlocker}`);
  return parts.join(" · ");
}
