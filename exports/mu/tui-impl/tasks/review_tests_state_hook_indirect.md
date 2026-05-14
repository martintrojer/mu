---
id: "review_tests_state_hook_indirect"
workstream: "tui-impl"
status: DEFERRED
impact: 35
effort_days: 0.2
roi: 175.00
owner: null
created_at: "2026-05-12T08:37:15.378Z"
updated_at: "2026-05-12T08:50:39.490Z"
blocked_by: []
blocks: []
---

# REVIEW low: useDashboardSnapshot hook is gated only by static-source markers (no real driver)

## Notes (1)

### #1 by "worker-3", 2026-05-12T08:37:15.768Z

```
FILES + LINES:
  - test/tui-state-hook-rerender.test.ts:165-194 — Layer B is asserted via `expect(src).toMatch(/useState\s*\(\s*0\s*\)/)`.
  - test/tui-state-tab-switch.test.ts:43-71 — snap-to-null wired via `expect(src).toMatch(/setData\s*\(\s*\{\s*data:\s*null/)`.
CATEGORY: false-confidence
SEVERITY: low
FINDING: The hook's two layers (key-equality short-circuit + snap-to-null on workstream change) are tested via grep on state.ts. The pure helpers (snapshotKey / snapshotKeyString / shouldDiscardForWorkstream) are exercised in detail. But the actual hook lifecycle (mount → tick → re-render guard / setData) has zero behaviour test. Header comments acknowledge this with "The hook isn't cheap to drive without ink-testing-library".
SUGGESTED FIX (small, no ink-testing-library): drive the hook from a vanilla react-test-renderer or @testing-library/react inline:
   - mount with a mock loadWorkstreamSnapshot resolved to A.
   - tick interval, assert data === A.
   - swap mock to B (same key → snapshotKey unchanged), tick, assert data REFERENCE is the SAME object.
   - swap to C (different key), tick, assert data is the new object.
   - flip workstream prop, assert data nulls during render.
This is ~50 LOC of test code and pins the actual behaviour, not the source layout.
CROSS-REF: review_tui_code_and_tests
```
