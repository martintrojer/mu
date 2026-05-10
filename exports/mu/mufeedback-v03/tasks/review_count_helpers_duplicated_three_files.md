---
id: "review_count_helpers_duplicated_three_files"
workstream: "mufeedback-v03"
status: CLOSED
impact: 30
effort_days: 0.15
roi: 200.00
owner: null
created_at: "2026-05-10T11:39:10.660Z"
updated_at: "2026-05-10T12:10:15.367Z"
blocked_by: []
blocks: []
---

# review: countAgents/Tasks/Notes/Edges duplicated across workstream.ts and cli/doctor.ts

## Notes (1)

### #1 by reviewer-1, 2026-05-10T11:39:10.780Z

```
FILES: src/workstream.ts:454-499 (countAgents/Tasks/Notes/Edges); src/cli/doctor.ts:255-321 (countAgentsByWorkstream/countTasksByWorkstream/countInProgressByWorkstream/countLogsByWorkstream/countReady/countBlocked)

FINDING: Six near-identical SELECT COUNT(*)-with-join helpers exist in cli/doctor.ts; the same workstream-scoped SELECTs already live in workstream.ts (private). Both compute `agents`/`tasks`/`notes` counts via the same JOIN-on-workstreams pattern. doctor.ts adds `inProgress`/`logs`/`ready`/`blocked` variants but the underlying SQL pattern is the same.

WHY: AGENTS.md "duplicated logic that begs for a shared helper". Adding a new workstream-scoped count today means picking which file to put it in (and the doctor variants are *not* re-exported, so the next contributor will probably add a third copy somewhere). The summarizeWorkstream() in workstream.ts already returns most of the doctor numbers — doctor could call summarizeWorkstream and add only the views it needs.

FIX-SKETCH: Two options. (a) Make doctor.ts call summarizeWorkstream(db, {workstream}) for agents/tasks/notes/edges/workspaces and only define countInProgressByWorkstream/countLogsByWorkstream/countReady/countBlocked locally. Net ~30 LOC out. (b) Hoist the count helpers to a shared `src/counts.ts` module if other consumers ever need them — defer until a real second consumer appears.

DONT-FIX: Don't add a generic countByWorkstream(table, predicate) — that's exactly the anticipatory abstraction AGENTS.md warns against.
```
