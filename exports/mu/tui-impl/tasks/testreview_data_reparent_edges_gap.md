---
id: "testreview_data_reparent_edges_gap"
workstream: "tui-impl"
status: CLOSED
impact: 50
effort_days: 0.15
roi: 333.33
owner: "worker-2"
created_at: "2026-05-13T12:40:09.062Z"
updated_at: "2026-05-13T12:56:31.268Z"
blocked_by: []
blocks: []
---

# REVIEW med: reparent tests miss duplicate and no-op edges

## Notes (2)

### #1 by "worker-2", 2026-05-13T12:40:09.393Z

```
FILE(S):
  test/tasks-crud.integration.test.ts:773-867
  test/cli-task-reparent-blocked-by.integration.test.ts:43-101
  src/tasks/edges.ts:309-324

FINDING (missing coverage):
  describe("reparentTask", () => {
    it("replaces every incoming edge with the new blocker set (atomic)", () => {
      const r = reparentTask(db, "target", ["c"], { workstream: "auth" });
      expect(r).toEqual({ removedEdges: 2, addedEdges: 1 });
      expect(getTaskEdges(db, "target", "auth").blockers).toEqual(["c"]);
    });
    ...
  });

WHY IT'S A PROBLEM:
  The reparent tests cover replacement, clearing, cycle, missing-task, and cross-workstream errors, but they never exercise duplicate blockers or the documented same-set no-op path. That leaves false confidence around the primary-key boundary on task_edges: `reparentTask(db, "target", ["a", "a"], ...)` can leak a raw SQLite constraint error, and reparenting to the existing set mutates updated_at despite the code comment claiming idempotency. These are user-visible because the CLI accepts comma/repeated forms that can accidentally duplicate ids.

PROPOSED FIX:
  Add behavior tests that (1) reparenting to the exact current blocker set returns zero removals/additions and leaves updated_at unchanged, (2) duplicate blockers are deduped or rejected with a typed/usage error rather than a raw SQLite constraint, and (3) the CLI path with `--blocked-by a,a` or repeated `--blocked-by a --blocked-by a` has the same contract. These should fail on the current implementation and pass after the SDK fix.

EFFORT NOTE:
  Test-only change if filed independently, but it pairs naturally with review_data_reparent_duplicate_blockers. Use the existing tasks-crud timestamp bump pattern and the CLI reparent fixture; no real tmux/VCS needed.
```

### #2 by "worker-2", 2026-05-13T12:56:31.268Z

```
CLOSE: 8fcbd60: SDK + CLI duplicate-blocker tests added
```
