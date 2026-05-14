---
id: "nit_blocks_flag_naming"
workstream: "roadmap-v0-2"
status: CLOSED
impact: 30
effort_days: 0.2
roi: 150.00
owner: null
created_at: "2026-05-08T06:39:00.000Z"
updated_at: "2026-05-08T07:37:35.773Z"
blocked_by: []
blocks: []
---

# NIT: --blocks flag on task add is confusing (means 'blocked by', not 'blocks'); add --blocks-X mirror

## Notes (1)

### #1 by null, 2026-05-08T07:37:32.132Z

```
FILES: src/cli.ts (cmdTaskAdd opts type + handler; task add command options/help), test/cli-blocked-by.test.ts (NEW, 5 CLI-level tests via buildProgram + parseAsync)
DIFFSTAT:
 src/cli.ts                  | 26 +++++++++++++++++++++++---
 test/cli-blocked-by.test.ts | 272 +++++++++++++++++++++++++++++++++++++++++++  (new)

VERIFIED: typecheck + lint + test (568 passed, +5 new) + build all green.

DECISION: Shipped option (b)+(c):
  - --blocked-by <ids>: NEW, preferred spelling. Help text: 'comma-separated task ids that block this task (i.e. this task is blocked by them)'.
  - -b, --blocks <ids>: kept as deprecated alias, help text now warns 'the name is misleading because the listed tasks block THIS one'.
  - If both passed with DIFFERENT values -> typed UsageError. If both passed with the SAME value, tolerated (idempotent).
  - In handler: opts.blockedBy is preferred over opts.blocks.

DEFERRED: --unblocks <ids> (option from the design's optional-further). DOWNGRADE rationale: addTask SDK currently inserts only incoming edges (blocker -> newTask), and the cycle check assumes a fresh task has no outgoing edges. Adding outgoing edges from cmdTaskAdd would require either (a) a new addTask SDK option with a real cycle-check pass for outgoing edges, or (b) wrapping addTask + addBlockEdge in a CLI-side transaction (atomicity edge cases). Both > the 'only if simple' bar. Easy follow-up if a real user hits it; today the workaround is 'mu task block <listed> --by <new-task-id>' after creation.
```
