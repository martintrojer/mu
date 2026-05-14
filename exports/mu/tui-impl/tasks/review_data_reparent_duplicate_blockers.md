---
id: "review_data_reparent_duplicate_blockers"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.2
roi: 275.00
owner: "worker-2"
created_at: "2026-05-13T12:39:45.924Z"
updated_at: "2026-05-13T12:56:30.482Z"
blocked_by: []
blocks: []
---

# REVIEW med: reparent leaks duplicate blocker SQLite errors

## Notes (2)

### #1 by "worker-2", 2026-05-13T12:39:46.228Z

```
FILE(S):
  src/tasks/edges.ts:309-324
  test/tasks-crud.integration.test.ts:773-867
  test/cli-task-reparent-blocked-by.integration.test.ts:43-101

FINDING (complexity):
  const insertEdge = db.prepare(
    "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
  );
  const now = new Date().toISOString();
  for (const blockerId of blockerIds) {
    insertEdge.run(blockerId, taskSurrogateId, now);
  }
  // Bump the reparented task itself — its blocker set just changed.
  // No-op when both removed and added were 0 (effectively a no-op
  // call); skip in that case so an idempotent `reparent --blocked-by
  // <same-set>` stays a true no-op for `--sort recency`.
  if (removed.changes > 0 || blockerIds.length > 0) {
    touchTask(db, taskSurrogateId, now);
  }

WHY IT'S A PROBLEM:
  reparentTask accepts an arbitrary blocker list and inserts each entry with a plain INSERT into a table whose primary key is (from_task_id, to_task_id). Duplicate blockers from SDK callers or CLI forms such as `--blocked-by a,a` therefore raise a raw SQLite constraint error after the DELETE already ran inside the transaction (rolled back, but surfaced as an untyped substrate failure). The adjacent comment also claims same-set reparent is an idempotent no-op, but the implementation always deletes then re-inserts the same edges and bumps updated_at / emits an event whenever blockers.length > 0.

PROPOSED FIX:
  Canonicalise the blocker list before the transaction (dedupe by surrogate id while preserving first-seen order), compare the current incoming blocker-id set with the canonical requested set, and return `{removedEdges: 0, addedEdges: 0}` without touching the DB when they are equal. Keep the existing validation over canonical blockers, then delete/insert only when the set actually changes. Add SDK tests for duplicate blockers and same-set no-op, plus a CLI regression for repeated/CSV duplicate `--blocked-by` input.

EFFORT NOTE:
  Small, local task-graph fix. Be careful to preserve cycle/cross-workstream validation and the current event text for real changes; tests should assert no raw SQLite error leaks.
```

### #2 by "worker-2", 2026-05-13T12:56:30.482Z

```
CLOSE: 8fcbd60: dedupe blockers + true no-op same-set; tests added
```
