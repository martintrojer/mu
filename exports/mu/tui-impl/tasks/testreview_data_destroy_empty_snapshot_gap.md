---
id: "testreview_data_destroy_empty_snapshot_gap"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.1
roi: 450.00
owner: "worker-2"
created_at: "2026-05-13T12:45:59.350Z"
updated_at: "2026-05-13T13:31:33.575Z"
blocked_by: []
blocks: []
---

# REVIEW med: destroy-empty tests miss positive snapshot count

## Notes (2)

### #1 by "worker-2", 2026-05-13T12:45:59.651Z

```
FILE(S):
  test/workstream-destroy-empty.integration.test.ts:474-496
  src/cli/workstream.ts:604-620
  src/workstream.ts:358-367

FINDING (missing coverage):
  it("--yes with no empties is a clean no-op (does NOT take a snapshot)", async () => {
    ...
    const r = await runCli(["workstream", "destroy", "--empty", "--yes", "--json"], dbPath);
    ...
    const snaps = (db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n;
    expect(snaps).toBe(0);
  });

WHY IT'S A PROBLEM:
  The --empty suite asserts the zero-victim case takes no snapshot, but it never checks the positive batch case's snapshot count. The implementation has a comment saying one snapshot covers the whole sweep, yet each nested destroyWorkstream call takes another snapshot. Without a positive-count assertion, the test suite misses the N+1 snapshot behavior and only verifies the easy no-op branch.

PROPOSED FIX:
  Add a positive --empty --yes regression with two empty workstreams, then inspect the snapshots table after the run. Assert exactly one snapshot exists and its label starts with `workstream destroy --empty sweep (2 workstreams)`. Also assert individual `workstream destroy <name>` snapshot labels are absent for the batch path.

EFFORT NOTE:
  Test-only if filed separately, but it should land with review_data_destroy_batch_snapshots because it will fail until destroyWorkstream can suppress per-item snapshots in the batch caller.
```

### #2 by "worker-2", 2026-05-13T13:31:33.575Z

```
CLOSE: 444889c: positive snapshot-count assertion added
```
