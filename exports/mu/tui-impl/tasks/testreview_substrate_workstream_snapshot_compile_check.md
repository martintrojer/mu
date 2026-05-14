---
id: "testreview_substrate_workstream_snapshot_compile_check"
workstream: "tui-impl"
status: CLOSED
impact: 40
effort_days: 0.1
roi: 400.00
owner: null
created_at: "2026-05-13T12:44:52.342Z"
updated_at: "2026-05-13T14:08:46.825Z"
blocked_by: ["tests_typecheck_misc_finalwiring"]
blocks: []
---

# TESTREVIEW med: WorkstreamSnapshot 'compile-time check' is tautological + uses wrong shape

## Notes (2)

### #1 by "worker-1", 2026-05-13T12:44:52.661Z

```
FILE(S):
  test/state-helpers.integration.test.ts:194-211 (WorkstreamSnapshot
  type structural check)

FINDING (fake testing — type check that doesn't compile):
  The test literally says "Compile-time structural check: this
  assignment must compile" — but constructs a WorkstreamSnapshot
  with the WRONG report shape (and possibly other shape drift):

      const _example: WorkstreamSnapshot = {
        workstreamName: "demo",
        view: { agents: [], orphans: [], report: { reaped: [], pruned: [] } },
        ...
      };
      expect(_example.workstreamName).toBe("demo");

  The actual ReconcileReport interface (src/reconcile.ts:87-99)
  has fields { prunedGhosts, statusChanges, orphans, mode } —
  NOT { reaped, pruned }. This object would FAIL `tsc` if tests
  were type-checked (see review_substrate_tsconfig_test_unused
  for the typecheck-skips-tests bug; this finding is the
  receipt). At vitest runtime, it just allocates an object and
  asserts the literal string "demo" round-trips, which is
  vacuous.

WHY IT'S A PROBLEM:
  - The test name promises a structural type check; it actually
    delivers a tautology (does `"demo" === "demo"` work?). A
    consumer reading the suite will believe WorkstreamSnapshot's
    shape is pinned.
  - The assertion would NOT catch a real schema drift: if
    WorkstreamSnapshot dropped `workstreamName`, the test
    would fail compile (which goes uncaught), then fail at
    runtime with a different error than the consumer expects.
  - Worse, the inline shape is already STALE — a real refactor
    would happen against this fixture, see the wrong shape, and
    "fix" it to match — but the test was never actually checking
    anything in the first place.

PROPOSED FIX:
  - If the goal is structural pinning, drop the assertion
    entirely and rely on TypeScript (see
    review_substrate_tsconfig_test_unused for wiring tests
    into typecheck — that's the proper home for compile-time
    contracts).
  - If the goal is runtime contract pinning, build an actual
    snapshot via loadWorkstreamSnapshotFast on a temp DB and
    assert each top-level field exists with the documented
    type:

        const snap = await loadWorkstreamSnapshotFast(db, "demo");
        for (const k of [
          "workstreamName", "view", "tracks", "ready",
          "inProgress", "blocked", "recentClosed", "allTasks",
          "workspaces", "workspaceOrphans", "recent",
          "recentCommits", "doctor",
        ] as const) {
          expect(snap).toHaveProperty(k);
        }

  Either way: kill the misleading inline literal that doesn't
  match the SDK shape.

EFFORT NOTE:
  Small (~15 LOC). Bonus: pair this fix with
  review_substrate_tsconfig_test_unused so test/ is properly
  type-checked going forward.
```

### #2 by "worker-2", 2026-05-13T14:08:46.825Z

```
CLOSE: 57e50e3: WorkstreamSnapshot fixture drift fixed; was covered by typecheck wiring
```
