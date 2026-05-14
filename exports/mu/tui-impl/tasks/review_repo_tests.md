---
id: "review_repo_tests"
workstream: "tui-impl"
status: CLOSED
impact: 70
effort_days: 0.5
roi: 140.00
owner: "worker-3"
created_at: "2026-05-12T11:08:44.427Z"
updated_at: "2026-05-12T11:18:15.185Z"
blocked_by: []
blocks: []
---

# REVIEW: run test-reviewer skill across the ENTIRE test/ tree — file every finding as a task

## Notes (3)

### #1 by "reaper", 2026-05-12T11:11:15.746Z

```
[reaper] previous owner worker-3 gone (agent removed); status reverted IN_PROGRESS → OPEN, owner cleared
```

### #2 by "worker-3", 2026-05-12T11:18:10.448Z

```
FILES: test/*.test.ts excluding test/tui-*.test.ts; test/_*.ts helpers/setup; integration-style *.integration.test.ts in test/ (no test/integration/ directory present). Focused on SDK/CLI/DB/tmux/reconcile/agents/tasks/workspace/snapshots/archives/vcs/logs/acceptance tests.
COMMANDS: read skills meta-tools/mu/test-reviewer; mu state -w tui-impl --json; rg --files test; scoped rg/read inspections across non-TUI tests; filed 7 follow-up tasks with mu task add + mu task note; git status --short (clean).
FINDINGS: Filed backlog tasks:
- testreview_static_source_assertions — static source/AST assertions in state tests should become behavior tests or lint checks.
- testreview_acceptance_bypasses_lifecycle — acceptance/graph tests stamp task status with raw SQL and skip lifecycle side effects.
- testreview_fixed_sleep_flakes — real-tmux/export/wait tests still use fixed sleeps where polling/fake clocks would be stronger.
- testreview_env_leak_no_color — NO_COLOR is mutated globally by test files and not restored.
- testreview_smoke_assertions_vcs_backends — jj/sl VCS backend tests assert broad smoke shapes rather than concrete behavior.
- testreview_json_shape_weak_assertions — JSON shape tests often assert Array.isArray without seeded content semantics.
- testreview_runcli_global_shims_race — runCli's process-global shims are non-reentrant and need serialization or subprocess isolation.
DECISION: No code edits per task instructions; filed review findings as separate mu tasks with line-precise notes and recommended fixes.
NEXT: Triage/claim the 7 new tasks; they are independent test-hardening backlog items.
VERIFIED: Audit-only; git status stayed clean; no four-greens run because no code edits.
```

### #3 by "worker-3", 2026-05-12T11:18:15.185Z

```
CLOSE: audit complete: filed 7 tasks: testreview_static_source_assertions, testreview_acceptance_bypasses_lifecycle, testreview_fixed_sleep_flakes, testreview_env_leak_no_color, testreview_smoke_assertions_vcs_backends, testreview_json_shape_weak_assertions, testreview_runcli_global_shims_race
```
