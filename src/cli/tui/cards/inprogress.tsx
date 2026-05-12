// In-progress card — every IN_PROGRESS task in the workstream, with
// owner + time-since-claim. Aimed at the cross-ref pain that today
// forces the operator to read the Agents card AND the Ready card to
// figure out "what's actually running right now":
//
//   Agents card → who's busy, but not which task they're on
//   Ready card  → unblocked OPEN tasks; nothing about IN_PROGRESS
//   Tracks card → DAG shape, not the live run state
//
// Card 6 collapses that into one glance. Per feat_card_6_inprogress
// (workstream `tui-impl`), promoted from the slot reserved by
// design_global_keymap. Mirrors the shape of Card 5 — Workspaces.
//
// CARD LAYOUT
//   glyph  id          owner       since-claim   title
//   ⚙      design_x    worker-1    3m            Design X
//   ⚙      review_x    reviewer-1  12m           Review X
//
// Glyph ⚙ matches STATUS_EMOJI.busy (the cog) used in the Agents
// card — the operator already reads it as "this thing is running".
// Consistency over novelty.
//
// CLIPPING POLICY (per feat_column_aligned_lists)
//   id, owner, since-claim → PROTECT (yankable; numbers / identifiers)
//   title                  → CLIP    (free-form prose)
//
// SUBTITLE (mirrors Card 5)
//   empty     → omitted (no IN_PROGRESS tasks → empty-state body)
//   populated → "<N>"  or  "<N> · <K> stale"
//   stale     := time-since-claim ≥ 5min (matches mu's idle threshold
//                default; see skills/mu/SKILL.md)
//
// TIME-SINCE-CLAIM
//   The cheapest accurate-enough proxy is TaskRow.updatedAt — task
//   lifecycle flips (claim, status changes) update it. A true
//   `claim_at` column would require a schema add + agent_logs scan
//   per row; OUT OF SCOPE here per the task brief. If a future task
//   needs that, it should add it as a typed SDK field, not extend
//   this card to do per-row event-log reads.
//
// POPUP (Shift+6 / `^`) IS OUT OF SCOPE here.
//   The umbrella feat_more_cards_umbrella tracks it. When the popup
//   does land, it MUST follow:
//     (a) feat_popup_search_filter — '/' search via usePopupFilter
//     (b) feat_track_drill_chains_to_task_drill — Enter chains rows
//         into TaskDetailDrill (rows ARE tasks, so the drill leaf
//         is exactly that primitive).
//   Until then, Shift+6 stays a reserved noop in keys.ts.

import { Text } from "ink";
import { STATUS_EMOJI } from "../../../agents.js";
import type { WorkstreamSnapshot } from "../../../state.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { ageMs, formatSinceClaim } from "../format-helpers.js";
import { ListRow } from "../list-row.js";
import { TitledBox } from "../titled-box.js";

// Re-exported for back-compat with consumers that previously imported
// these helpers from this card (popups/inprogress, tests). The single
// source of truth lives in ../format-helpers.ts.
export { ageMs, formatSinceClaim };

export interface InProgressCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const ROW_LIMIT = 8;

/** ≥5min since the last lifecycle flip → "stale claim". Matches the
 *  default value of MU_IDLE_THRESHOLD_MS (300_000ms / 5min) used by
 *  the agent-side idle detector — we deliberately re-use the same
 *  threshold so a stale claim and an idle agent surface together. */
export const STALE_CLAIM_THRESHOLD_MS = 300_000;

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // task id
  { kind: "protect" }, // owner (or "—")
  { kind: "protect", align: "right" }, // since-claim
  { kind: "clip", min: 1 }, // title
];

export function InProgressCard({ snapshot }: InProgressCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  if (snapshot === null) {
    return (
      <TitledBox title="In-progress" cardId={6}>
        <Text dimColor>loading…</Text>
      </TitledBox>
    );
  }

  const { inProgress } = snapshot;

  if (inProgress.length === 0) {
    return (
      <TitledBox title="In-progress" cardId={6}>
        <Text dimColor>(none in progress)</Text>
      </TitledBox>
    );
  }

  const now = Date.now();
  const ages = inProgress.map((t) => ageMs(t, now));
  const stale = ages.filter((ms) => isStale(ms)).length;
  const subtitle = formatSubtitle(inProgress.length, stale);

  const shown = inProgress.slice(0, ROW_LIMIT);
  const more = inProgress.length - ROW_LIMIT;
  const bottomLabel = more > 0 ? `+${more} more · Shift+6` : undefined;
  const rows = shown.map((t, i) => [
    glyphFor(),
    t.name,
    t.ownerName ?? "—",
    formatSinceClaim(ages[i] ?? null),
    t.title,
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox title="In-progress" subtitle={subtitle} cardId={6} bottomLabel={bottomLabel}>
      {shown.map((t, i) => {
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const rowAge = ages[i];
        const stale = isStale(rowAge ?? null);
        const colors = [
          { color: "yellow" }, // glyph
          { bold: true }, // id
          { dimColor: true }, // owner
          stale ? { color: "yellow" } : { dimColor: true }, // since
          { dimColor: true }, // title
        ];
        return <ListRow key={t.name} cells={padded} contentWidth={contentWidth} colors={colors} />;
      })}
    </TitledBox>
  );
}

// ─── pure helpers (exported for unit tests) ────────────────────────

/** Status glyph for an IN_PROGRESS task. Always the cog (mirrors
 *  STATUS_EMOJI.busy used in the Agents card so the operator reads
 *  it as "this thing is running" without learning a second
 *  vocabulary). Falls back to a literal cog if STATUS_EMOJI.busy is
 *  ever unset (defensive — the table is exhaustive today).
 *  Argumentless because the glyph never depends on the row
 *  (review_dead_code_glyph_for_unused). */
export function glyphFor(): string {
  return STATUS_EMOJI.busy ?? "⚙";
}

/** True when `ms` is at or above the stale-claim threshold (5min).
 *  null / undefined → false (we never paint "stale" without data). */
export function isStale(ms: number | null | undefined): boolean {
  return typeof ms === "number" && ms >= STALE_CLAIM_THRESHOLD_MS;
}

/** Build the subtitle: total · N stale. Suppresses the stale leg
 *  when zero so a healthy workstream renders a quiet "3" instead
 *  of "3 · 0 stale". */
export function formatSubtitle(total: number, stale: number): string {
  const parts: string[] = [String(total)];
  if (stale > 0) parts.push(`${stale} stale`);
  return parts.join(" · ");
}
