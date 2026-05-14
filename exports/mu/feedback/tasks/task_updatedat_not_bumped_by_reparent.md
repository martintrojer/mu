---
id: "task_updatedat_not_bumped_by_reparent"
workstream: "feedback"
status: CLOSED
impact: 20
effort_days: 0.3
roi: 66.67
owner: null
created_at: "2026-05-10T14:33:04.136Z"
updated_at: "2026-05-10T14:56:56.757Z"
blocked_by: []
blocks: []
---

# task.updatedAt not bumped by reparent / unblock / note (only by status change?)

## Notes (2)

### #1 by "π - infer-rs", 2026-05-10T14:34:07.212Z

```
OBSERVED 2026-05-10 on workstream infer-rs:

REPRO:
  task test_full_check_current_stack created 2026-05-08T12:53:29.034Z, updatedAt 2026-05-08T12:53:29.034Z.
  Today (2026-05-10) I:
    - mu task reparent test_full_check_current_stack --blocked-by sil_virtual_static_class_dispatch -w infer-rs
    - mu task note     test_full_check_current_stack -w infer-rs "<hygiene note>"
  After both:
    mu task show ... --json | jq '.task.updatedAt' -> "2026-05-08T12:53:29.034Z"
    mu task show ... --json | jq '.notes[-1].createdAt' -> "2026-05-10T14:28:41.308Z"
  -> updatedAt is stale by ~2 days while a note from today exists on the task.

Same observed for `mu task unblock <id> --by <other>`: I unblocked CLOSED-only blockers off textual_declenv_enhancements, perf_explore_linear_const_cleanup, perf_component_clone_reduction today; their updatedAt is also stale.

WHY IT'S A NIT:
  - mu task list --sort recency uses updatedAt; tasks that just had edges reshuffled / notes appended look stale and get sorted DOWN. I rely on `--sort recency` to surface "what did I touch last" when context-switching.
  - The `recency` sort is documented in the skill but its semantics are now silently "last status/field change" rather than "last write of any kind".

EXPECTED: updatedAt bumps on any write that mutates the task row OR its child rows (notes, edges, owner, status). At minimum: edge changes and notes.

FIX: trigger updatedAt = now() on:
  - task notes insert
  - task_edges insert/delete
  - claim/release (owner change)
  - reject/defer/open/close/reopen (status change, presumed already)
  - update --title/--impact/--effort-days (presumed already)

VERIFIED: dual readout above. Repro reliable.
```

### #2 by "worker-2", 2026-05-10T14:56:40.509Z

```
FILES:
  src/tasks.ts (added touchTask helper; bump in addNote/addBlockEdge/removeBlockEdge/reparentTask)
  test/tasks-crud.test.ts (regression tests for note + edge add/remove + reparent)
  test/tasks-lifecycle.test.ts (regression test for releaseTask updated_at bump)
  CHANGELOG.md (entry under [0.3.0] § Fixed)
COMMANDS:
  npm run typecheck && npm run lint && npm run test && npm run build  # all green; 1049 tests passing
FINDINGS:
  - addNote, addBlockEdge, removeBlockEdge, reparentTask never touched tasks.updated_at.
  - claimTask, releaseTask, setTaskStatus (close/open/reject/defer), updateTask all DO bump updated_at directly in their UPDATE statements; left untouched.
  - claimTask already had a "bumps updated_at" test (line 124); releaseTask did not.
DECISION:
  - Single shared SDK helper touchTask(db, taskId, now?) in src/tasks.ts. Used by 4 sites; well over the 2x threshold for extracting a helper.
  - Each child-row mutation now wraps INSERT/DELETE + touchTask in a db.transaction(...) so the bump rolls back on error.
  - Bump on the BLOCKED side for edge writes (the FROM_TASK whose blockers changed); blocker untouched. Same for reparent (the reparented task's blockers changed).
  - Skip the bump on idempotent no-ops (block-already-exists, unblock-already-gone, reparent to same set) — `--sort recency` should reflect actual writes, not no-op verbs.
NEXT: none — fix is targeted; semantics for already-bumping paths preserved.
VERIFIED:
  - npm run typecheck → clean
  - npm run lint → clean (105 files)
  - npm run test → 57 files / 1049 tests passing (incl. 7 new regression tests covering note/edge-add/edge-remove/reparent/release)
  - npm run build → clean
```
