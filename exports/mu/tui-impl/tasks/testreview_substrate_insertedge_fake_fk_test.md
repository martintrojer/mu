---
id: "testreview_substrate_insertedge_fake_fk_test"
workstream: "tui-impl"
status: CLOSED
impact: 30
effort_days: 0.15
roi: 200.00
owner: "worker-1"
created_at: "2026-05-13T12:45:34.982Z"
updated_at: "2026-05-13T14:40:37.688Z"
blocked_by: []
blocks: []
---

# TESTREVIEW low: db.test 'rejects edges to non-existent tasks (FK)' uses fake -999999 to coerce error

## Notes (2)

### #1 by "worker-1", 2026-05-13T12:45:35.295Z

```
FILE(S):
  test/db.test.ts:265-269 (the "rejects edges to non-existent tasks (FK)" test)
  test/db.test.ts:450-470 (insertEdge helper that synthesises -999999)

FINDING (fake testing — catches the wrong error):
  The test helper `insertEdge(from, to)` DELIBERATELY catches the
  "task not found" error from `taskIdByLocalId(db, to)` and then
  inserts an edge with `to_task_id = -999999` "to match the v4
  FOREIGN KEY constraint failed contract":

      try {
        toId = taskIdByLocalId(db, to);
      } catch {
        // Match the v4 'FOREIGN KEY constraint failed' contract by inserting
        // a deliberately invalid id so SQLite raises the FK error.
        db.prepare(
          `INSERT INTO task_edges (from_task_id, to_task_id, created_at) VALUES (?, ?, datetime('now'))`,
        ).run(taskIdByLocalId(db, from), -999999);
        return;
      }

  The "rejects edges to non-existent tasks (FK)" test then does:

      insertTask(db, { id: "a", title: "A", impact: 50, effortDays: 1 });
      expect(() => insertEdge(db, "a", "ghost")).toThrow();

  This passes for the WRONG reason. The actual SDK
  (src/tasks/edit.ts addBlockEdge) catches "task not found"
  early and throws TaskNotFoundError before any SQL runs. The
  test bypasses that path entirely and instead exercises a
  raw INSERT with -999999 to coerce the FK error.

WHY IT'S A PROBLEM:
  - A regression where the FK constraint on task_edges.to_task_id
    is dropped (e.g. `REFERENCES tasks (id)` removed in a v8
    schema bump that mistakes the join for cosmetic) would NOT
    fail this test — the helper's synthetic -999999 INSERT
    would silently succeed and the test would still .toThrow()
    on the next line if there is one (no, there isn't).

    Actually wait: `taskIdByLocalId(db, from)` for `from='a'`
    succeeds, then INSERT with `to_task_id=-999999` is what
    raises the FK error. If the FK was dropped, the insert
    succeeds and the test passes (.toThrow expectation fails).
    OK that part holds.

  - But: it's still misleading. The test name claims it
    rejects edges to non-existent tasks; in reality it rejects
    edges to invalid integer ids. With the v5 surrogate-PK
    design these are conceptually different:
      - "task with local_id 'ghost' doesn't exist in this
        workstream" → SDK throws TaskNotFoundError, exit 3
      - "task with surrogate id -999999 doesn't exist
        anywhere" → SQLite throws FK error, surfaces as
        generic exit 1 from SDK callsites
    The latter contract is WHAT v5 was supposed to make
    invisible to the operator (resolver helpers handle it).
    The test pins behaviour mu shouldn't ship.

PROPOSED FIX:
  Test the FK contract directly without the synthetic catch:

      it("FK constraint blocks edges to non-existent tasks.id", () => {
        insertTask(db, { id: "a", ... });
        expect(() =>
          db.prepare(
            `INSERT INTO task_edges (from_task_id, to_task_id, created_at)
             VALUES (?, ?, datetime('now'))`
          ).run(taskIdByLocalId(db, "a"), 999999)
        ).toThrow(/FOREIGN KEY/);
      });

  And separately, exercise the SDK-level "no such task" path:

      it("addBlockEdge throws TaskNotFoundError for unknown local_id", () => {
        addTask(db, { localId: "a", ... });
        expect(() => addBlockEdge(db, "test", "a", "ghost"))
          .toThrowError(TaskNotFoundError);
      });

  Drop the catch+synthesise hack from the helper.

EFFORT NOTE:
  Small (~20 LOC). The helper is private to db.test.ts so no
  cascading callers. Risk: low.
```

### #2 by "worker-1", 2026-05-13T14:40:37.688Z

```
CLOSE: dd3b47528be4744fa2702d297694df45a257ba26: replaced fake-FK helper with direct FK + SDK assertions
```
