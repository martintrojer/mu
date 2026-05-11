// Workspaces card — per-agent VCS working copy summary, aimed at the
// "between-wave refresh / cherry-pick" loop where commits-behind +
// dirty are the load-bearing signals.
//
// Per feat_card_5_workspaces (workstream `tui-impl`) and the umbrella
// note on feat_more_cards_umbrella: "high signal for cherry-pick /
// refresh-between-waves loops; only place that exposes commits-behind
// + dirty". Cards 1-4 cover agents/tracks/ready/log; this fills slot
// 5 (Unicode superscript ⁵, btop convention via TitledBox).
//
// Aesthetic: rounded border, dim border colour, section header inset
// into the top — same family as the other four cards.
//
// Data shape (per row):
//   - status glyph    ★ dirty | ⓘ ahead | ✓ clean
//   - agent name      e.g. worker-1
//   - backend         git | jj | sl | none
//   - behind          coloured int (green ≤2, yellow 3-9, red ≥10)
//   - parent_ref      first 12 chars (matches mu workspace list)
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: glyph + agent name +
// backend + behind + parent_ref are all PROTECTED (operators yank
// them verbatim into shell commands). Nothing here is free-form prose
// so we have no clippable column — this is a deliberate exception:
// every cell is identity-bearing. If row-width overflows, the
// dashboard's terminal-too-small guard already handles it.
//
// FOLLOW-UP (not in scope):
//   - Matching Shift+5 (`%`) popup with per-row yank intents
//     (refresh / commits / free / path). Tracked by the parent
//     feat_more_cards_umbrella; popup likely lands as a sibling task.

import { Box, Text } from "ink";
import type { WorkstreamSnapshot } from "../../../state.js";
import type { WorkspaceRow } from "../../../workspace.js";
import { type ColumnSpec, layoutColumns, renderRow } from "../columns.js";
import { TitledBox } from "../titled-box.js";

export interface WorkspacesCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const ROW_LIMIT = 8;

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // status glyph
  { kind: "protect" }, // agent name
  { kind: "protect" }, // backend
  { kind: "protect", align: "right" }, // behind count
  { kind: "protect" }, // parent_ref short
];

export function WorkspacesCard({ snapshot }: WorkspacesCardProps): JSX.Element {
  if (snapshot === null) {
    return (
      <TitledBox title="Workspaces" cardId={5}>
        <Text dimColor>loading…</Text>
      </TitledBox>
    );
  }

  const { workspaces, workstreamName } = snapshot;
  const stale = workspaces.filter((w) => isStale(w.commitsBehindMain)).length;
  const dirty = workspaces.filter((w) => w.dirty === true).length;
  const subtitle = formatSubtitle(workspaces.length, stale, dirty);

  if (workspaces.length === 0) {
    return (
      <TitledBox title="Workspaces" cardId={5}>
        <Text dimColor>
          (no workspaces) try `mu agent spawn worker-1 -w {workstreamName} --workspace`
        </Text>
      </TitledBox>
    );
  }

  const shown = workspaces.slice(0, ROW_LIMIT);
  const rows = shown.map((w) => [
    glyphFor(w),
    w.agentName,
    w.backend,
    formatBehind(w.commitsBehindMain),
    w.parentRef ? w.parentRef.slice(0, 12) : "—",
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS);

  return (
    <TitledBox title="Workspaces" subtitle={subtitle} cardId={5}>
      {shown.map((w, i) => {
        const row = rows[i];
        if (row === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const [glyph = "", name = "", backend = "", behind = "", parent = ""] = padded;
        return (
          <Box key={w.agentName}>
            <Text>
              <Text color={colorForGlyph(w)}>{glyph}</Text>
              {"  "}
              <Text bold>{name}</Text>
              {"  "}
              <Text dimColor>{backend}</Text>
              {"  "}
              <Text color={colorForBehind(w.commitsBehindMain)}>{behind}</Text>
              {"  "}
              <Text dimColor>{parent}</Text>
            </Text>
          </Box>
        );
      })}
      {workspaces.length > ROW_LIMIT && (
        <Text dimColor>
          … +{workspaces.length - ROW_LIMIT} more · run `mu workspace list -w {workstreamName}`
        </Text>
      )}
    </TitledBox>
  );
}

// ─── pure helpers (exported for unit tests) ────────────────────────

/** True when the row's commits-behind-main is ≥10 (the red bucket
 *  used by the static `mu workspace list` table). Kept in sync with
 *  formatBehind's thresholds below. */
export function isStale(behind: number | null | undefined): boolean {
  return typeof behind === "number" && behind >= 10;
}

/** Render the behind count as a short token. "—" when unknown
 *  (no main resolvable, none-backend, missing parent_ref, command
 *  failure). Numbers render bare; the call-site colours them. */
export function formatBehind(n: number | null | undefined): string {
  if (n === undefined || n === null) return "—";
  return String(n);
}

/** Picocolors-compatible colour name for a behind count. Mirrors the
 *  static table renderer (src/cli/format.ts formatBehind): green ≤2,
 *  yellow 3-9, red ≥10, undefined / unknown falls through to dim. */
export function colorForBehind(n: number | null | undefined): string | undefined {
  if (n === undefined || n === null) return undefined;
  if (n <= 2) return "green";
  if (n <= 9) return "yellow";
  return "red";
}

/** Per-row status glyph. Priority order:
 *    1. dirty  → ★ (uncommitted edits — most actionable)
 *    2. stale  → ⓘ (commits-behind ≥10 — needs `mu workspace refresh`)
 *    3. clean  → ✓
 *  When dirty is unknown (null / undefined) we fall through to the
 *  staleness check; we never paint a row as clean when its dirty
 *  state is unknown.
 */
export function glyphFor(w: WorkspaceRow): string {
  if (w.dirty === true) return "★";
  if (isStale(w.commitsBehindMain)) return "ⓘ";
  return "✓";
}

/** Glyph colour: red when dirty (most urgent), yellow when stale,
 *  green when clean. Undefined → use ink default (matches the
 *  default-colour fallthroughs elsewhere). */
export function colorForGlyph(w: WorkspaceRow): string | undefined {
  if (w.dirty === true) return "red";
  if (isStale(w.commitsBehindMain)) return "yellow";
  return "green";
}

/** Build the subtitle: total · N stale · M dirty. Suppresses zeros
 *  so a healthy workstream renders a quiet "3" instead of
 *  "3 · 0 stale · 0 dirty". */
export function formatSubtitle(total: number, stale: number, dirty: number): string {
  const parts: string[] = [String(total)];
  if (stale > 0) parts.push(`${stale} stale`);
  if (dirty > 0) parts.push(`${dirty} dirty`);
  return parts.join(" · ");
}
