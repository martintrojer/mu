---
id: "review_resolved_nothing_dead_branch"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.05
roi: 600.00
owner: null
created_at: "2026-05-10T11:38:43.669Z"
updated_at: "2026-05-10T11:59:07.214Z"
blocked_by: []
blocks: []
---

# review: cmdState `resolvedNothing` flag is dead — `void resolvedNothing` admits it

## Notes (1)

### #1 by "reviewer-1", 2026-05-10T11:38:43.774Z

```
FILES: src/cli/state.ts:160-184 (resolveWorkstreamSet) and src/cli/state.ts:218-225 (cmdState dispatch)

FINDING: `resolveWorkstreamSet` returns `{ workstreams, resolvedNothing }` but `cmdState` never uses `resolvedNothing` — the comment "Defensive: resolveWorkstreamSet only returns resolvedNothing=true when workstreams is empty (handled above), but the typing carries it for clarity" + the `void resolvedNothing` discard prove the field is always redundant with `workstreams.length === 0`.

WHY: A tuple field that is always derivable from another field is dead surface — the next maintainer has to puzzle out whether the two can ever disagree, then learn from the comment that they can't. The `void` discard is also a code smell suggesting the contributor knew it was useless but didn't want to delete the field.

FIX-SKETCH: Drop `resolvedNothing` from the return type. The caller already branches on `workstreams.length === 0`. Net -3 lines.

DONT-FIX: Don't replace the flag with another sentinel; just delete it.
```
