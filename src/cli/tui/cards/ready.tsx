// Ready card — top-N OPEN tasks with no unsatisfied blockers, sorted
// by ROI desc.
//
// Per design_card_ready (workstream `tui`).
//
// Aesthetic: rounded border, dim border, section header inset; ROI
// bucket colours via roiBucket() — high=green, mid=yellow, low=dim.
//
// Rows are column-aligned via src/cli/tui/columns.ts. Per
// feat_column_aligned_lists clipping policy: task name, ROI number,
// owner are PROTECTED (yank affordance / numeric); the title is
// CLIPPABLE.

import { Box, Text } from "ink";
import { type RoiBucket, type WorkstreamSnapshot, roiBucket } from "../../../state.js";
import { type ColumnSpec, layoutColumns, renderRow } from "../columns.js";
import { TitledBox } from "../titled-box.js";

export interface ReadyCardProps {
  snapshot: WorkstreamSnapshot | null;
}

const ROW_LIMIT = 10;

const COLUMN_SPECS: ReadonlyArray<ColumnSpec> = [
  { kind: "protect" }, // task name
  { kind: "protect", align: "right" }, // ROI label (e.g. "ROI 50")
  { kind: "clip", min: 1 }, // title
  { kind: "protect" }, // owner (or "—")
];

export function ReadyCard({ snapshot }: ReadyCardProps): JSX.Element {
  if (snapshot === null) {
    return (
      <TitledBox title="Ready">
        <Text dimColor>loading…</Text>
      </TitledBox>
    );
  }

  const { ready } = snapshot;

  if (ready.length === 0) {
    return (
      <TitledBox title="Ready">
        <Text dimColor>
          (no ready tasks) every blocker is OPEN/IN_PROGRESS or every task is closed
        </Text>
      </TitledBox>
    );
  }

  const shown = ready.slice(0, ROW_LIMIT);
  const meta = shown.map((t) => {
    const bucket = roiBucket(t.impact, t.effortDays);
    const roi = t.effortDays > 0 ? Math.round(t.impact / t.effortDays) : Number.POSITIVE_INFINITY;
    const roiText = Number.isFinite(roi) ? String(roi) : "∞";
    return { bucket, roiText };
  });
  const rows = shown.map((t, i) => [
    t.name,
    `ROI ${meta[i]?.roiText ?? ""}`,
    t.title,
    t.ownerName ?? "—",
  ]);
  const widths = layoutColumns(rows, COLUMN_SPECS);

  return (
    <TitledBox title="Ready" subtitle={String(ready.length)}>
      {shown.map((t, i) => {
        const row = rows[i];
        const m = meta[i];
        if (row === undefined || m === undefined) return null;
        const padded = renderRow(row, widths, COLUMN_SPECS);
        const [name = "", roi = "", title = "", owner = ""] = padded;
        return (
          <Box key={t.name}>
            <Text>
              <Text bold>{name}</Text>
              {"  "}
              <Text color={colorForBucket(m.bucket)}>{roi}</Text>
              {"  "}
              <Text dimColor>{title}</Text>
              {"  "}
              <Text dimColor>{owner}</Text>
            </Text>
          </Box>
        );
      })}
      {ready.length > ROW_LIMIT && (
        <Text dimColor>… +{ready.length - ROW_LIMIT} more · open Tasks popup (Shift+3)</Text>
      )}
    </TitledBox>
  );
}

function colorForBucket(b: RoiBucket): string | undefined {
  switch (b) {
    case "high":
    case "infinite":
      return "green";
    case "mid":
      return "yellow";
    case "low":
      return undefined;
  }
}
