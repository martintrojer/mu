// Recent card — the most-recently CLOSED tasks in the workstream,
// newest first. Surfaces "what just shipped" so the operator can
// cherry-pick / verify / cross-reference without bouncing to a
// separate `mu task list --status CLOSED -w <ws>` shell.
//
// Per feat_card_8_recent (workstream `tui-impl`), promoted from the
// slot reserved by design_global_keymap. Mirrors the shape of
// Card 5 — Workspaces (264585f9), Card 6 — In-progress (760fc6c),
// and Card 7 — Blocked (4c50fc0) so the operator reads it the same
// way: TitledBox header, column-aligned rows, glanceable subtitle.
//
// CARD LAYOUT
//   glyph  id           STATUS   when      title
//   ✓      feat_card_5  CLOSED   3m ago    FEAT: Card 5 — Workspaces
//   ✓      feat_card_6  CLOSED   12m ago   FEAT: Card 6 — In-progress
//
// Glyph ✓ (U+2713) coloured green — every row in this card is by
// definition CLOSED (the SDK helper listRecentClosed filters on
// status='CLOSED'); the green check reads as "shipped".
//
// CLIPPING POLICY (per feat_column_aligned_lists)
//   id, STATUS, when → PROTECT (yankable / identifier / numeric)
//   title            → CLIP    (free-form prose)
//
// SUBTITLE
//   empty       → omitted (no recently-closed tasks → empty body)
//   populated   → "<N>"  or  "<N> · last <relTime since most recent>"
//                 — the most-recent close is the most actionable
//                 anchor: the operator's "did the wave just finish?"
//                 question.
//
// DATA
//   - snapshot.recentClosed is the listRecentClosed slice (CLOSED
//     status, ORDER BY updated_at DESC LIMIT 5). Used directly. No
//     SDK extension per the task brief — if a future task wants a
//     larger window, it should bump the SDK helper's default and
//     have the card cap at ROW_LIMIT here.
//
// "WHEN" COLUMN
//   The cheapest-accurate proxy for "closed at" is TaskRow.updatedAt
//   — `closeTask` is the most recent lifecycle flip on a CLOSED row
//   (re-opens flip back to OPEN). A real `closed_at` column would
//   need a schema add + agent_logs scan; OUT OF SCOPE per the brief.
//   If a row is later updated (e.g. a note is appended), updatedAt
//   moves; that's a known limitation — note-append doesn't change
//   updated_at today (notes have their own created_at), so in
//   practice this is "time since close". Verified in src/tasks.ts.
//
// POPUP
//   Shift+8 (`*`) opens the matching Recent popup. Card slot 8 and
//   popup slot 8 now point at the same task-recent view again.

import { Text } from "ink";
import type { WorkstreamSnapshot } from "../../../state.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { ageMs, formatWhen } from "../format-helpers.js";
import { CARD_CONFIGS, cardRenderHeight } from "../layout.js";
import { ListRow } from "../list-row.js";
import { PaddedRows } from "../padded-rows.js";
import { TitledBox } from "../titled-box.js";

// Re-exported for back-compat with consumers that previously imported
// these helpers from this card (popups/recent, tests). The single
// source of truth lives in ../format-helpers.ts.
export { ageMs, formatWhen };

export interface RecentCardProps {
  snapshot: WorkstreamSnapshot | null;
  rowBudget?: number;
  cols?: number;
}

export const cardConfig = CARD_CONFIGS[8];

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // task id
  { kind: "protect" }, // status (always CLOSED; constant for now)
  { kind: "protect", align: "right" }, // when (e.g. "3m ago")
  { kind: "clip", min: 1 }, // title
];

export function RecentCard({ snapshot, rowBudget, cols }: RecentCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(cols ?? termColsForLayout());
  if (snapshot === null) {
    return (
      <TitledBox
        height={cardRenderHeight(cardConfig, rowBudget)}
        width={cols}
        title="Recent"
        cardId={8}
      >
        <PaddedRows rows={rowBudget ?? cardConfig.minRows}>
          <Text dimColor>loading…</Text>
        </PaddedRows>
      </TitledBox>
    );
  }

  const { recentClosed } = snapshot;

  if (recentClosed.length === 0) {
    return (
      <TitledBox
        height={cardRenderHeight(cardConfig, rowBudget)}
        width={cols}
        title="Recent"
        cardId={8}
      >
        <PaddedRows rows={rowBudget ?? cardConfig.minRows}>
          <Text dimColor>(none recently closed)</Text>
        </PaddedRows>
      </TitledBox>
    );
  }

  const now = Date.now();
  const ages = recentClosed.map((t) => ageMs(t, now));
  const subtitle = formatSubtitle(recentClosed.length, ages[0] ?? null);

  const shown = recentClosed.slice(0, rowBudget ?? cardConfig.maxRows);
  const more = recentClosed.length - shown.length;
  const bottomLabel = more > 0 ? `+${more} more · Shift+8` : undefined;
  const rows = shown.map((t, i) => [
    glyphFor(),
    t.name,
    t.status,
    formatWhen(ages[i] ?? null),
    t.title,
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox
      height={cardRenderHeight(cardConfig, rowBudget)}
      width={cols}
      title="Recent"
      subtitle={subtitle}
      cardId={8}
      bottomLabel={bottomLabel}
    >
      {shown.map((t, i) => {
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const colors = [
          { color: "green" }, // glyph
          { bold: true }, // id
          { dimColor: true }, // status
          { dimColor: true }, // when
          { dimColor: true }, // title
        ];
        return <ListRow key={t.name} cells={padded} contentWidth={contentWidth} colors={colors} />;
      })}
    </TitledBox>
  );
}

// ─── pure helpers (exported for unit tests) ────────────────────────

/** Glyph for a recently-closed row. Always the heavy check (✓,
 *  U+2713). The colour is applied at the call site; the function
 *  returns just the glyph so tests can pin the codepoint without
 *  coupling to ink. Argumentless because the glyph never depends on
 *  the row (review_dead_code_glyph_for_unused). */
export function glyphFor(): string {
  return "✓";
}

/** Build the subtitle: total · last <when>. Suppresses the "last"
 *  leg when `mostRecentMs` is null (defensive — populated path
 *  always has at least one row, hence at least one age). */
export function formatSubtitle(total: number, mostRecentMs: number | null): string {
  const parts: string[] = [String(total)];
  if (mostRecentMs !== null) parts.push(`last ${formatWhen(mostRecentMs)}`);
  return parts.join(" · ");
}
