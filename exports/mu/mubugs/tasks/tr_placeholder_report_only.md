---
id: "tr_placeholder_report_only"
workstream: "mubugs"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: null
created_at: "2026-05-15T11:38:28.323Z"
updated_at: "2026-05-15T11:47:52.646Z"
blocked_by: []
blocks: ["umbrella"]
---

# Test review: placeholder skip lacks report-only coverage

## Notes (2)

### #1 by "worker-2", 2026-05-15T11:38:28.629Z

```
FILE: test/reconcile.integration.test.ts:reconcile — pruning ghost rows > full mode skips placeholder pane ids during prune
WHAT'S MISSING/WRONG: Placeholder-pane protection is only asserted in full/default mode. The review checklist/design explicitly calls out that placeholders should be skipped in both surviving reconcile modes (full and report-only), but there is no report-only placeholder case. Current report-only tests cover normal ghost rows, status suppression, orphans, and undo recovery, not a %pending-* row.
WHY IT MATTERS: The protective invariant was moved from the old status-only mode into the prune loop 'independent of mode'. A future refactor could reorder the report-only prune/count path so %pending-* placeholders are counted as ghosts or otherwise treated as drift in doctor/undo/TUI doctor summaries. That would recreate confusing mid-spawn false positives, and the full-only placeholder tests would not fail.
SUGGESTED FIX: Add a report-only test that inserts an agent with paneId '%pending-alice', mocks an empty pane list, runs reconcile(db, { workstream: 'auth', mode: 'report-only' }), and asserts report.mode === 'report-only', prunedGhosts === 0, the agent row survives, and no capture-pane occurs.
SEVERITY: medium
```

### #2 by "worker-1", 2026-05-15T11:47:52.646Z

```
CLOSE: 385ead2 report-only placeholder skip test added; prunedGhosts=0, row survives, no capturePane fires
```
