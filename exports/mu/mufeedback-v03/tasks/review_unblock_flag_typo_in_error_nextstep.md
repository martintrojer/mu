---
id: "review_unblock_flag_typo_in_error_nextstep"
workstream: "mufeedback-v03"
status: CLOSED
impact: 60
effort_days: 0.05
roi: 1200.00
owner: null
created_at: "2026-05-10T11:37:40.602Z"
updated_at: "2026-05-10T11:48:25.725Z"
blocked_by: []
blocks: []
---

# review: TaskHasOpenDependentsError suggests non-existent --not-blocked-by flag

## Notes (1)

### #1 by reviewer-1, 2026-05-10T11:37:53.115Z

```
FILES: src/tasks/errors.ts:165-172 (TaskHasOpenDependentsError.errorNextSteps)

FINDING: The third nextStep suggests `mu task unblock <dep> --not-blocked-by <id>`, but `mu task unblock` only accepts `-b/--by <blocker>` (see src/cli/tasks/wire.ts:347-352 and src/cli/tasks/edges.ts cmdTaskUnblock). The `--not-blocked-by` flag does not exist; running the suggested command will fail with a commander unknown-option error.

WHY: nextSteps are the operator-facing recovery path; a typo that produces a non-runnable command violates the implicit contract (see src/output.ts NextStep doc: "literal shell command... copy-paste or eval directly"). The other entries (1, 2, 4) are runnable and tested; this one slipped through.

FIX-SKETCH: Replace `--not-blocked-by ${this.taskId}` with `--by ${this.taskId}` so the command becomes `mu task unblock <dep> --by <root-id>`, matching the actual flag. One-character fix.

DONT-FIX: Do not add a `--not-blocked-by` alias to the unblock verb; the existing `--by` is the canonical name and aliasing creates a second surface to keep in sync.
```
