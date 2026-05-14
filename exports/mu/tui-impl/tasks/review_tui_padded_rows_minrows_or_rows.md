---
id: "review_tui_padded_rows_minrows_or_rows"
workstream: "tui-impl"
status: CLOSED
impact: 20
effort_days: 0.05
roi: 400.00
owner: "worker-1"
created_at: "2026-05-13T12:53:56.262Z"
updated_at: "2026-05-13T15:46:51.633Z"
blocked_by: []
blocks: []
---

# REVIEW low: PaddedRows accepts unused minRows prop (every caller passes only rows)

## Notes (2)

### #1 by "worker-4", 2026-05-13T12:53:56.981Z

```
FILE(S):
  src/cli/tui/padded-rows.tsx (entire file)

FINDING (non-idiomatic / unclear API):
  PaddedRows accepts BOTH `minRows` and `rows`:

      export interface PaddedRowsProps {
        minRows?: number;
        rows?: number;
        children: ReactNode;
      }
      export function PaddedRows({ minRows, rows, children }) {
        const targetRows = Math.max(0, Math.floor(rows ?? minRows ?? 0));
        const blanks = Math.max(0, targetRows - 1);
        ...
      }

  Inspecting all consumers:
    - cards/agents.tsx:    rows={rowBudget ?? cardConfig.minRows}
    - cards/blocked.tsx:   rows={rowBudget ?? cardConfig.minRows}
    - cards/commits.tsx:   rows={rowBudget ?? cardConfig.minRows}
    - cards/doctor.tsx:    rows={rowBudget ?? cardConfig.minRows}
    - cards/inprogress.tsx:rows={rowBudget ?? cardConfig.minRows}
    - cards/log.tsx:       rows={rowBudget ?? cardConfig.minRows}
    - cards/ready.tsx:     rows={rowBudget ?? cardConfig.minRows}
    - cards/recent.tsx:    rows={rowBudget ?? cardConfig.minRows}
    - cards/tracks.tsx:    rows={rowBudget ?? cardConfig.minRows}
    - cards/workspaces.tsx:rows={rowBudget ?? cardConfig.minRows}

  EVERY consumer passes only `rows`. None pass `minRows`. The
  `minRows ?? 0` fallback path is dead.

WHY IT'S A PROBLEM:
  - Two-prop API where only one is used → the second is
    documentation noise. A reader has to figure out the
    relationship between `minRows` and `rows` (the source code
    says "min" wins if `rows` is undefined; that's not "min" at
    all, it's "fallback").
  - The component's own internal logic is `rows ?? minRows ?? 0`
    — which means `minRows` is actually a default, not a minimum
    floor. Misleading prop name.
  - Adding the `minRows` prop suggests an anticipated use case
    (a card that knows its minimum but lets PaddedRows compute
    the actual size). Per AGENTS.md "no anticipatory abstractions":
    if no caller uses it, drop it.

PROPOSED FIX:
  Drop `minRows` entirely. Single signature:

      export interface PaddedRowsProps {
        rows?: number;
        children: ReactNode;
      }
      export function PaddedRows({ rows, children }: PaddedRowsProps): JSX.Element {
        const targetRows = Math.max(0, Math.floor(rows ?? 0));
        const blanks = Math.max(0, targetRows - 1);
        ...
      }

  All 10 callers stay byte-identical (they never passed
  minRows). Removes 1 prop + 1 ?? + the misleading "min"
  prefix.

EFFORT NOTE:
  Trivial; ~0.05d. Pure dead-code removal. No test changes
  needed (no test asserts on the unused prop).
```

### #2 by "worker-1", 2026-05-13T15:46:51.633Z

```
CLOSE: 4dc57ff: dropped unused minRows prop (rows-only signature; targetRows = max(0, floor(rows ?? 0)); no caller change since all 10 callers already passed rows={...}); four greens (typecheck + lint + test:fast 1378 + build) + bundle smoke clean
```
