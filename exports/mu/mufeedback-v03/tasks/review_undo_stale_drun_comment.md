---
id: "review_undo_stale_drun_comment"
workstream: "mufeedback-v03"
status: CLOSED
impact: 25
effort_days: 0.05
roi: 500.00
owner: null
created_at: "2026-05-10T11:38:56.563Z"
updated_at: "2026-05-10T11:49:23.264Z"
blocked_by: []
blocks: []
---

# review: cmdUndo doc still says `dryRun: true` — flag was renamed to mode: "report-only"

## Notes (1)

### #1 by reviewer-1, 2026-05-10T11:38:56.746Z

```
FILES: src/cli/snapshot.ts:140-158 (cmdUndo reconcile section)

FINDING: The 18-line comment block before `openDb({path: restored.restoredTo})` argues "**dryRun: true** is the load-bearing flag. Without it, the reconcile pass would prune any agent row..." — but `dryRun` was REPLACED by `mode: "report-only"` in the v0.3 ReconcileMode change (src/reconcile.ts ReconcileMode type, CHANGELOG entry). The actual call below correctly uses `mode: "report-only"`; the comment is stale documentation pointing at a flag that no longer exists.

WHY: The comment is the load-bearing rationale for why post-restore reconcile must NOT prune rows the snapshot just restored (snap_undo_reconcile_destroys_recovered_agents). Future maintainers grep for "dryRun" and find nothing in reconcile.ts; the explanation appears to refer to a missing API.

FIX-SKETCH: Two-line edit: change "**dryRun: true** is the load-bearing flag" → "**mode: \"report-only\"** is the load-bearing flag" and "Dry-run reports drift but doesn't delete" → "report-only reports drift but doesn't delete". Reword the closing parenthetical too.

DONT-FIX: No code change — just docstring sync.
```
