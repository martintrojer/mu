---
id: "review_unify_format_when_since"
workstream: "tui-impl"
status: CLOSED
impact: 35
effort_days: 0.05
roi: 700.00
owner: null
created_at: "2026-05-12T08:32:10.651Z"
updated_at: "2026-05-12T09:02:06.214Z"
blocked_by: []
blocks: []
---

# REVIEW low: Unify formatSinceClaim + formatWhen (same body, just '+ ago' suffix)

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:32:10.934Z

```
FILES + LINES:
  - src/cli/tui/cards/inprogress.tsx:178-189 — formatSinceClaim(ms): renders "Ns","Nm","Nh","Nd","Nw" or "—".
  - src/cli/tui/cards/recent.tsx:163-175     — formatWhen(ms): EXACTLY the same arithmetic with " ago" suffix on every non-em-dash branch.
  - src/cli/format.ts:110 — relTime() exists already and returns the same shape (no suffix). cards/inprogress.tsx:175 explicitly notes "Mirrors src/cli/format.ts relTime exactly, inlined so the TUI cluster doesn't import a sibling cluster's helper just for one call site."
CATEGORY: duplication / non-idiomatic
SEVERITY: low
FINDING: Three implementations of the same date-bucketing rules. The "single-call-site so don't share" rationale was true when only the card had it; now both cards AND both popups consume it — 4 callsites for formatSinceClaim, 4 for formatWhen — and the sibling-import objection looks weaker than the duplication cost.
SUGGESTED FIX: import src/cli/format.ts's relTime in the TUI helpers (no new module); add `relTimeAgo(ms): string` next to relTime if the " ago" suffix is the only delta. Cards/inprogress + cards/recent collapse to one-liners; popups/inprogress + popups/recent re-import accordingly.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:02:06.214Z

```
CLOSE: 22357168850814352e34a151b5baf972a493a220: bundled hoist
```
