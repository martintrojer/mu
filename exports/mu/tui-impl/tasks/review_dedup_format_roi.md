---
id: "review_dedup_format_roi"
workstream: "tui-impl"
status: CLOSED
impact: 35
effort_days: 0.05
roi: 700.00
owner: null
created_at: "2026-05-12T08:31:26.691Z"
updated_at: "2026-05-12T09:02:05.923Z"
blocked_by: []
blocks: []
---

# REVIEW low: Hoist formatRoi helper (3 byte-identical copies + 2 inline duplicates)

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:31:38.308Z

```
FILES + LINES:
  - src/cli/tui/popups/inprogress.tsx:275-279 — exported formatRoi(impact, effortDays)
  - src/cli/tui/popups/recent.tsx:280-284     — exported formatRoi (verbatim copy)
  - src/cli/tui/cards/blocked.tsx:127-130     — inline `t.effortDays > 0 ? Math.round(t.impact / t.effortDays) : Number.POSITIVE_INFINITY` + finite-check + "∞"
  - src/cli/tui/cards/ready.tsx:65-68         — same inline formula
  - src/cli/tui/popups/blocked.tsx:252-253    — same inline formula
CATEGORY: duplication
SEVERITY: low
FINDING: The "render ROI as int or ∞" formula is hand-rolled in 5 places. Two are identical exported helpers (formatRoi); the three card/popup callsites inline the same expression. The inline form even uses a slightly different code path (Math.round → Number.isFinite check on the result) versus the helper (effortDays<=0 short-circuit) — no observable difference today, but a bug class waiting to happen.
SUGGESTED FIX: hoist `formatRoi(impact, effortDays): string` into src/state.ts (lives next to `roiBucket`, the existing single source of truth for ROI bucketing) OR into src/cli/tui/columns.ts as a tiny formatter. Update the 5 callsites + their two test files (tui-popup-recent.test.ts and tui-popup-inprogress.test.ts). Net diff: -25 LOC, +5 LOC.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:02:05.923Z

```
CLOSE: 22357168850814352e34a151b5baf972a493a220: bundled hoist
```
