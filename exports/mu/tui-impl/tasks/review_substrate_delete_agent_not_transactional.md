---
id: "review_substrate_delete_agent_not_transactional"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.2
roi: 350.00
owner: "worker-1"
created_at: "2026-05-13T12:40:45.605Z"
updated_at: "2026-05-13T12:58:40.946Z"
blocked_by: []
blocks: []
---

# REVIEW high: deleteAgent + reaper loop not transactional — partial failure leaves zombie tasks

## Notes (2)

### #1 by "worker-1", 2026-05-13T12:40:45.921Z

```
FILE(S):
  src/agents.ts:493-535 (deleteAgent + reaper loop)

FINDING (complexity / partial-failure hazard):
  `deleteAgent` performs the DELETE on agents, then in a loop
  UPDATEs each previously-owned IN_PROGRESS task back to OPEN
  and writes a `[reaper]` note + event log for it. None of this
  is wrapped in a single SQL transaction.

      const result = db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
      if (result.changes === 0) return false;

      for (const t of stuck) {
        db.prepare("UPDATE tasks SET status = 'OPEN' …").run(...);
        addNote(...);
        emitEvent(...);
      }

WHY IT'S A PROBLEM:
  - Process kill / OOM / better-sqlite3 throw mid-loop leaves
    the agent row deleted (FK cascade has already SET NULL on
    every tasks.owner) and only PART of the reaper trail
    written. The leftover IN_PROGRESS tasks have no owner and
    no `[reaper]` note explaining how they got there. A future
    reconcile / `mu task wait --stuck-after` will surface them
    as zombies with no breadcrumb.
  - Tests can't catch this without injecting failure between
    statements; production observes it as silent "where did my
    notes go?" reports.
  - The `addNote` and `emitEvent` calls themselves can throw
    (FK on workstream race after destroy, NOT NULL on payload
    if a refactor regressed it, …). Same outcome.

PROPOSED FIX:
  Wrap in a transaction:

      db.transaction(() => {
        // SELECT stuck tasks
        // DELETE agent row
        // for each stuck: UPDATE + addNote + emitEvent
      })();

  better-sqlite3 transactions are synchronous and cheap; the
  whole reaper sequence is small. Wraps cleanly. The only
  subtlety: `addNote` and `emitEvent` both call back into
  prepared statements on the same Db handle, which is fine
  inside a transaction.

EFFORT NOTE:
  Small (~10 LOC). Add a regression test that throws from a
  monkey-patched `addNote` mid-loop and asserts the agent row
  is rolled back (still present). Risk: low — better-sqlite3
  transactions are well-understood. Same pattern is already
  used elsewhere in src/tasks/* for status changes.
```

### #2 by "worker-1", 2026-05-13T12:58:40.946Z

```
CLOSE: ee2757a: reaper sequence atomic; rollback test added
```
