---
id: "testreview_data_import_existing_ws_gap"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.15
roi: 300.00
owner: null
created_at: "2026-05-13T12:44:24.466Z"
updated_at: "2026-05-13T13:14:40.518Z"
blocked_by: []
blocks: []
---

# REVIEW med: import tests miss existing non-task workstreams

## Notes (2)

### #1 by "worker-2", 2026-05-13T12:44:24.786Z

```
FILE(S):
  test/importing.integration.test.ts:173-190
  src/importing.ts:750-763

FINDING (missing coverage):
  it("imports cleanly into a destroyed-then-recreated empty workstream", async () => {
    seed("auth", ["design"]);
    const bucket = join(tmpDir, "bucket");
    exportWorkstream(db, { workstream: "auth", outDir: bucket });
    await destroyWorkstream(db, { workstream: "auth" });

    importBucket(db, { bucketDir: bucket });
    expect(listTasks(db, "auth")).toHaveLength(1);
  });

  it("refuses to merge into an existing workstream that already has tasks", async () => {
    ...
    expect(() => importBucket(db, { bucketDir: bucket })).toThrow(WorkstreamAlreadyExistsError);
  });

WHY IT'S A PROBLEM:
  The tests cover the absent-workstream import path and the existing-workstream-with-tasks conflict, but not the important middle cases: an existing workstream row with agents/workspaces/logs and zero tasks, or a deliberately initialized empty workstream. That gap lets the implementation's task-only EXISTS check drift from the documented "target workstream already exists in the DB" contract. A merge into a workstream with live agents would be user-visible and hard to untangle.

PROPOSED FIX:
  Add import collision tests for an existing target workstream with (a) only a workstreams row, (b) an agent row, and/or (c) a workspace row. Assert the chosen contract explicitly: either all existing rows refuse, or only a truly empty registered workstream is allowed while agents/workspaces still refuse. The test title should avoid "destroyed-then-recreated" unless it actually creates the target row before import.

EFFORT NOTE:
  Test-only if the code contract is already considered correct after clarification; otherwise pair with review_data_import_merges_nonempty_ws. Use insertAgent and noneBackend workspace setup if covering workspace rows.
```

### #2 by "π - mu", 2026-05-13T13:14:40.518Z

```
CLOSE: 5fd227c: covered by paired tests added in import-merge-nonempty-ws fix (agent-bearing + workspace-bearing existing-target regression tests in test/importing.integration.test.ts)
```
