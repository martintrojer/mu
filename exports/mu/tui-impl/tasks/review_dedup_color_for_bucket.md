---
id: "review_dedup_color_for_bucket"
workstream: "tui-impl"
status: CLOSED
impact: 35
effort_days: 0.05
roi: 700.00
owner: null
created_at: "2026-05-12T08:31:46.113Z"
updated_at: "2026-05-12T09:02:05.607Z"
blocked_by: []
blocks: []
---

# REVIEW low: Hoist colorForBucket helper (3 identical copies)

## Notes (2)

### #1 by "worker-3", 2026-05-12T08:31:46.412Z

```
FILES + LINES:
  - src/cli/tui/cards/ready.tsx:97-106
  - src/cli/tui/cards/blocked.tsx:226-235
  - src/cli/tui/popups/blocked.tsx:294-302
CATEGORY: duplication
SEVERITY: low
FINDING: Three byte-identical `function colorForBucket(b: RoiBucket): string | undefined` (the popups/blocked.tsx variant uses `ReturnType<typeof roiBucket>` instead of importing the type — same domain). Cases match exactly: high|infinite→green, mid→yellow, low→undefined.
SUGGESTED FIX: hoist into src/state.ts (sits next to `roiBucket`/`RoiBucket`) as `colorForRoiBucket` (or just `colorForBucket` since it's tightly coupled to the type). Replace the three local copies with the import.
CROSS-REF: review_tui_code_and_tests
```

### #2 by "worker-3", 2026-05-12T09:02:05.607Z

```
CLOSE: 22357168850814352e34a151b5baf972a493a220: bundled hoist
```
