# mubugs — task index

| id | status | impact | effort | ROI | title |
| --- | --- | --- | --- | --- | --- |
| [`bug_no_recovery_after_tmux_server_crash`](tasks/bug_no_recovery_after_tmux_server_crash.md) | CLOSED | 75 | 1 | 75.00 | BUG: mu state inconsistent after tmux server crash — agents reported alive, panes gone, no auto-detect or recovery path |
| [`code_review`](tasks/code_review.md) | CLOSED | 70 | 0.4 | 175.00 | Code review: reconciler mode collapse (file findings as new blockers of umbrella) |
| [`collapse_status_only_mode`](tasks/collapse_status_only_mode.md) | CLOSED | 75 | 0.5 | 150.00 | Collapse status-only → full; mu state and mu agent list use one mode |
| [`cr_attach_precheck`](tasks/cr_attach_precheck.md) | CLOSED | 65 | 0.2 | 325.00 | Code review: agent attach skips reaping when session is gone |
| [`cr_doctor_ghost_wording`](tasks/cr_doctor_ghost_wording.md) | CLOSED | 50 | 0.1 | 500.00 | Code review: doctor reports ghost count as pruned in report-only mode |
| [`cr_pending_leak`](tasks/cr_pending_leak.md) | CLOSED | 55 | 0.2 | 275.00 | Code review: placeholder skip leaks past prune loop |
| [`reconcile_pending_skip`](tasks/reconcile_pending_skip.md) | CLOSED | 60 | 0.25 | 240.00 | Defensive: reconcile() skips placeholder pane ids during prune in ALL modes |
| [`test_review`](tasks/test_review.md) | CLOSED | 70 | 0.4 | 175.00 | Test review: reconciler mode collapse (file findings as new blockers of umbrella) |
| [`tr_placeholder_report_only`](tasks/tr_placeholder_report_only.md) | CLOSED | 55 | 0.2 | 275.00 | Test review: placeholder skip lacks report-only coverage |
| [`tr_state_crash_entrypoint`](tasks/tr_state_crash_entrypoint.md) | CLOSED | 80 | 0.3 | 266.67 | Test review: wholesale crash test bypasses mu state/no-server path |
| [`umbrella`](tasks/umbrella.md) | CLOSED | 75 | 0.1 | 750.00 | Reconciler: collapse status-only into full mode (closes bug_no_recovery_after_tmux_server_crash) |
