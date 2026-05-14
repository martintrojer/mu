---
id: "review_data_addtask_duplicate_blockers"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.15
roi: 333.33
owner: "worker-2"
created_at: "2026-05-13T12:40:30.656Z"
updated_at: "2026-05-13T12:56:32.080Z"
blocked_by: []
blocks: []
---

# REVIEW med: add task duplicate blockers leak SQLite errors

## Notes (2)

### #1 by "worker-2", 2026-05-13T12:40:30.966Z

```
FILE(S):
  src/tasks/edit.ts:78-116
  test/tasks-crud.integration.test.ts:170-227
  test/cli-task-add-blocked-by.integration.test.ts:39-144

FINDING (complexity):
  if (opts.blockedBy && opts.blockedBy.length > 0) {
    ...
    const insertEdge = db.prepare(
      "INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, ?)",
    );
    for (const blocker of opts.blockedBy) {
      ...
      insertEdge.run(row.id, newTaskId, now);
    }
  }

WHY IT'S A PROBLEM:
  addTask validates each blockedBy element but does not canonicalise the list before inserting task_edges with a plain INSERT. If an SDK caller or the CLI's repeat/comma parser passes the same blocker twice (for example `--blocked-by design,design`), the second insert violates task_edges' primary key and leaks a raw SQLite constraint error. The transaction rolls back, but the user gets a substrate error instead of the idempotent graph semantics used by addBlockEdge.

PROPOSED FIX:
  Dedupe blockedBy before insertion while preserving first-seen order, or reject duplicates up front with a typed validation error. Prefer dedupe to match `addBlockEdge`'s idempotent duplicate-edge contract. Build the emitted `blocked-by=` event summary from the canonical list so logs do not imply duplicate edges were created.

EFFORT NOTE:
  Local fix in addTask plus tests. Add SDK coverage for duplicate blockedBy rollback-free success and CLI coverage for CSV/repeated duplicate forms. Watch for existing rollback tests with `["design", "ghost", "design"]`: the missing blocker should still abort the whole add before any row survives.
```

### #2 by "worker-2", 2026-05-13T12:56:32.080Z

```
CLOSE: 8fcbd60: same dedupe applied to addTask
```
