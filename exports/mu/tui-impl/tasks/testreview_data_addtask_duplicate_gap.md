---
id: "testreview_data_addtask_duplicate_gap"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.1
roi: 450.00
owner: "worker-2"
created_at: "2026-05-13T12:40:42.282Z"
updated_at: "2026-05-13T12:56:32.804Z"
blocked_by: []
blocks: []
---

# REVIEW med: add-task tests miss duplicate blockers

## Notes (2)

### #1 by "worker-2", 2026-05-13T12:40:43.965Z

```
FILE(S):
  test/tasks-crud.integration.test.ts:170-227
  test/cli-task-add-blocked-by.integration.test.ts:39-144
  src/tasks/edit.ts:78-116

FINDING (missing coverage):
  it("inserts edges when blockedBy specified", () => {
    addTask(db, {
      localId: "build",
      workstream: "auth",
      title: "Build",
      impact: 80,
      effortDays: 2,
      blockedBy: ["design"],
    });
    ...
  });
  ...
  it("--blocked-by accepts comma-separated lists", async () => {
    ... "--blocked-by", "design,api" ...
  });

WHY IT'S A PROBLEM:
  The tests prove single and multi-blocker happy paths, unknown-blocker rollback, and parser shapes, but they never cover duplicate blockers. Because task_edges has a composite primary key, duplicate input is exactly where behavior differs from the intended idempotent edge model: the second insert can throw a raw SQLite constraint. The CLI parser intentionally accepts mixed comma/repeated forms, making accidental duplicates realistic.

PROPOSED FIX:
  Add SDK and CLI tests for duplicate `blockedBy` entries: `blockedBy: ["design", "design"]`, `--blocked-by design,design`, and repeated `--blocked-by design --blocked-by design`. Assert either canonical dedupe success with one edge or a typed/usage error, but never a raw SQLite constraint and never a partially-created task.

EFFORT NOTE:
  Pair with review_data_addtask_duplicate_blockers. The current rollback test with a missing blocker should remain to prove validation still aborts the task insert when any unique blocker is invalid.
```

### #2 by "worker-2", 2026-05-13T12:56:32.804Z

```
CLOSE: 8fcbd60: addTask duplicate-blocker tests added
```
