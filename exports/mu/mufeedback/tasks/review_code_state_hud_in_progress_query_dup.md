---
id: "review_code_state_hud_in_progress_query_dup"
workstream: "mufeedback"
status: CLOSED
impact: 40
effort_days: 0.15
roi: 266.67
owner: null
created_at: "2026-05-09T08:31:42.542Z"
updated_at: "2026-05-09T08:49:30.098Z"
blocked_by: []
blocks: ["docs_staleness_review_capstone", "reconcile_split_dryrun_into_status_only_mode"]
---

# REVIEW: same in-progress raw SQL repeated in cli/state.ts and cli/hud.ts

## Notes (2)

### #1 by code-reviewer-1, 2026-05-09T08:32:06.201Z

```
FILES: src/cli/state.ts:165-170 (in-progress raw query), src/cli/hud.ts:336-342 (identical raw query)

FINDINGS: Both cmdState and cmdHud independently re-prepare the same raw SQL:

  db.prepare(
    "SELECT * FROM tasks WHERE workstream = ? AND status = 'IN_PROGRESS' ORDER BY updated_at DESC",
  ).all(workstream) as RawTaskRowForState[]

then map through rawTaskRowToTask. The motivation comment in src/cli.ts:407-410 explicitly notes:

  // Helper types/converters used by `mu state` and `mu hud` for their
  // IN_PROGRESS / recent_closed slices. Both verbs re-query the tasks
  // table directly (with status + ordering not exposed by listTasks)
  // so the column-name conversion lives here as a shared helper.

This is exactly the "we shared the row-mapper but not the query" half-measure. listTasks(db, ws, { status: "IN_PROGRESS" }) returns the right rows but ORDER BY local_id, not updated_at — so the verbs need a different ordering. The fix is one extra optional `orderBy` param on listTasks (or a new typed helper `listInProgressByRecency`), not two copies of the SQL string.

This is in the same neighborhood as the existing review_code_views_recreated_thrice and review_code_raw_task_state_duplicate tickets but distinct: those track schema-view recreation and the RawTaskRowForState shape; this one tracks the SQL-string duplication itself. NOTE: distinct from review_code_views_recreated_thrice (open).

WHY IT MATTERS: 40. Pure smell. Exactly the duplication shape the skill calls out: "Copy-pasted logic with small variations" — variations being just the workstream parameter. Future schema changes (added column, renamed status) need to find both copies. The recent_closed query in cli/state.ts:172-177 is a third copy with a different filter — would benefit from the same helper.

SUGGESTED FIX (~20 LOC):
Option A (small): Add an `orderBy?: "localId" | "updatedAt" | "createdAt"` field to ListTasksOptions in src/tasks.ts (already accepts `status`). Both verbs become listTasks(db, ws, { status: "IN_PROGRESS", orderBy: "updatedAt" }). Minimal SDK surface growth.

Option B (smaller still): Add two specific helpers in src/tasks.ts:
  export function listInProgressByRecency(db, ws): TaskRow[]
  export function listRecentClosed(db, ws, limit): TaskRow[]
The state.ts and hud.ts call sites become one-liners. RawTaskRowForState becomes private to src/tasks.ts (no cross-cluster export needed).

Either fix is ~20 LOC delete. Option B halves the SDK surface vs Option A but is two helpers instead of one parameter.

ALTERNATIVES CONSIDERED:
- Leave as-is and add a test that locks the SQL strings together. Doesn't reduce LOC; adds maintenance burden.
- Inline both queries into a single shared helper in src/cli.ts (where rawTaskRowToTask lives). Worse: keeps SQL in CLI layer. Helpers belong with the data, not the renderer.

EVIDENCE:
- diff of cli/state.ts:165-170 vs cli/hud.ts:336-342 is just whitespace.
- src/cli.ts:407-410 comment explicitly admits the duplication.
- listTasks already accepts a `status` filter (src/tasks.ts:262), so the SDK surface is half-built for this.
```

### #2 by worker-mf-2, 2026-05-09T08:49:28.246Z

```
VERIFIED ALREADY FIXED by commit 21582cc (review_code_raw_task_state_duplicate).

Current state on 6f94818:
- src/tasks.ts:314 listInProgress(db, ws) — single canonical raw SQL
- src/tasks.ts:328 listRecentClosed(db, ws, limit=5) — sibling helper
- src/cli/state.ts:162-163 calls both helpers, no inline SELECT
- src/cli/hud.ts:334 calls listInProgress, no inline SELECT
- src/cli.ts no longer exports RawTaskRowForState / rawTaskRowToTask

The reviewer's Option B was implemented exactly: two narrow SDK
helpers, RawTaskRow stays private to src/tasks.ts, cli layer is
SQL-free for these slices. grep "status = 'IN_PROGRESS'" src/
returns 4 hits — 1 in tasks.ts (the canonical), 2 in doctor.ts
(COUNT diagnostics, different query), 1 in agents.ts (owner-scoped
SELECT, different query). No dup remains.

No code change needed for this ticket. Closing as already-fixed.
No CHANGELOG entry: 21582cc already documented the dedup under
[Unreleased] / Changed.
```
