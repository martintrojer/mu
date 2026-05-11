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
// POPUP / FUTURE OBLIGATIONS (when slot-8 popup ships)
//   Out of scope NOW. When the popup is added under
//   feat_more_cards_umbrella, it MUST consume:
//     (a) feat_popup_search_filter — '/' filter via usePopupFilter
//     (b) feat_track_drill_chains_to_task_drill — Enter chains rows
//         into TaskDetailDrill (rows ARE tasks)
//   Until then, Shift+8 (`*`) stays a reserved noop in keys.ts.

import { Box, Text } from "ink";
import type { WorkstreamSnapshot } from "../../../state.js";
import type { TaskRow } from "../../../tasks.js";
import {
  type ColumnSpec,
  contentWidthFromCols,
  layoutColumns,
  renderRow,
  termColsForLayout,
} from "../columns.js";
import { TitledBox } from "../titled-box.js";

export interface RecentCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const ROW_LIMIT = 8;

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // glyph
  { kind: "protect" }, // task id
  { kind: "protect" }, // status (always CLOSED; constant for now)
  { kind: "protect", align: "right" }, // when (e.g. "3m ago")
  { kind: "clip", min: 1 }, // title
];

export function RecentCard({ snapshot }: RecentCardProps): JSX.Element {
  const contentWidth = contentWidthFromCols(termColsForLayout());
  if (snapshot === null) {
    return (
      <TitledBox title="Recent" cardId={8}>
        <Text dimColor>loading…</Text>
      </TitledBox>
    );
  }

  const { recentClosed, workstreamName } = snapshot;

  if (recentClosed.length === 0) {
    return (
      <TitledBox title="Recent" cardId={8}>
        <Text dimColor>(none recently closed)</Text>
      </TitledBox>
    );
  }

  const now = Date.now();
  const ages = recentClosed.map((t) => ageMs(t, now));
  const subtitle = formatSubtitle(recentClosed.length, ages[0] ?? null);

  const shown = recentClosed.slice(0, ROW_LIMIT);
  const rows = shown.map((t, i) => [
    glyphFor(t),
    t.name,
    t.status,
    formatWhen(ages[i] ?? null),
    t.title,
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS, contentWidth);

  return (
    <TitledBox title="Recent" subtitle={subtitle} cardId={8}>
      {shown.map((t, i) => {
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const [glyph = "", id = "", status = "", when = "", title = ""] = padded;
        return (
          <Box key={t.name}>
            <Text>
              <Text color="green">{glyph}</Text>
              {"  "}
              <Text bold>{id}</Text>
              {"  "}
              <Text dimColor>{status}</Text>
              {"  "}
              <Text dimColor>{when}</Text>
              {"  "}
              <Text dimColor>{title}</Text>
            </Text>
          </Box>
        );
      })}
      {recentClosed.length > ROW_LIMIT && (
        <Text dimColor>
          … +{recentClosed.length - ROW_LIMIT} more · run `mu task list -w {workstreamName} --status
          CLOSED`
        </Text>
      )}
    </TitledBox>
  );
}

// ─── pure helpers (exported for unit tests) ────────────────────────

/** Glyph for a recently-closed row. Always the heavy check (✓,
 *  U+2713). The colour is applied at the call site; the function
 *  returns just the glyph so tests can pin the codepoint without
 *  coupling to ink. */
export function glyphFor(_t: TaskRow): string {
  return "✓";
}

/** Milliseconds since the task was last updated (proxy for "closed
 *  at" — see header comment). Returns null when updatedAt is
 *  unparseable (defensive — every row from SQLite will be a valid
 *  ISO-8601 string). The basis is `now` so tests can pin time
 *  without leaning on the wall clock. Mirrors ageMs in the
 *  In-progress card (intentionally duplicated; single call site
 *  per card, not worth a shared helper). */
export function ageMs(t: TaskRow, now: number): number | null {
  const ts = Date.parse(t.updatedAt);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, now - ts);
}

/** Render an age in milliseconds as a short relative-time token
 *  with the trailing " ago" suffix:
 *    < 60s   → "Ns ago"
 *    < 60m   → "Nm ago"
 *    < 24h   → "Nh ago"
 *    < 7d    → "Nd ago"
 *    else    → "Nw ago"
 *  null / undefined → "—". The " ago" suffix is the differentiator
 *  vs the In-progress card's formatSinceClaim (which renders
 *  in-flight age with no suffix); here every row is past tense. */
export function formatWhen(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return `${Math.floor(day / 7)}w ago`;
}

/** Build the subtitle: total · last <when>. Suppresses the "last"
 *  leg when `mostRecentMs` is null (defensive — populated path
 *  always has at least one row, hence at least one age). */
export function formatSubtitle(total: number, mostRecentMs: number | null): string {
  const parts: string[] = [String(total)];
  if (mostRecentMs !== null) parts.push(`last ${formatWhen(mostRecentMs)}`);
  return parts.join(" · ");
}
