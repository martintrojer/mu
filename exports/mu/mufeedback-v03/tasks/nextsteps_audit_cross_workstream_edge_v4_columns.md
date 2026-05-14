---
id: "nextsteps_audit_cross_workstream_edge_v4_columns"
workstream: "mufeedback-v03"
status: CLOSED
impact: 60
effort_days: 0.2
roi: 300.00
owner: "worker-5"
created_at: "2026-05-10T13:33:47.804Z"
updated_at: "2026-05-10T13:47:24.576Z"
blocked_by: []
blocks: []
---

# nextsteps-audit: CrossWorkstreamEdgeError suggests v4 SQL (UPDATE tasks SET workstream= ; WHERE local_id) — wrong post-v5

## Notes (1)

### #1 by "worker-5", 2026-05-10T13:34:00.666Z

```
FILES: src/tasks/errors.ts:374-380
FINDING: CrossWorkstreamEdgeError.errorNextSteps() returns two `mu sql` recipes that both reference v4 schema columns that no longer exist post-v5.
CURRENT-HINT:
  intent: "Move the blocker into the dependent's workstream"
  command: mu sql "UPDATE tasks SET workstream='<dep-ws>' WHERE local_id='<blocker>'"
  intent: "Or merge the two workstreams (rename one to the other)"
  command: mu sql "UPDATE workstreams SET name='<dep-ws>' WHERE name='<blocker-ws>'"
STALE-BECAUSE: src/db.ts schema v5+ has tasks.workstream_id (INTEGER FK to workstreams.id), NOT tasks.workstream. The first UPDATE will fail with "no such column: workstream". local_id is per-(workstream_id, local_id) UNIQUE so the WHERE is also ambiguous across workstreams. The second hint (rename workstream) ALSO breaks transparently if the dep-ws name already exists (UNIQUE violation), and would silently move every task — almost never what the operator wants.
FIX-SKETCH:
  - Replace UPDATE 1 with a v5-correct form scoped by workstream_id:
      mu sql "UPDATE tasks SET workstream_id=(SELECT id FROM workstreams WHERE name='<dep-ws>')
              WHERE local_id='<blocker>'
                AND workstream_id=(SELECT id FROM workstreams WHERE name='<blocker-ws>')"
  - The second hint (rename a workstream to merge) is operationally dangerous; consider dropping it and keeping the third (duplicate the blocker) since that is what most operators actually want.
```
