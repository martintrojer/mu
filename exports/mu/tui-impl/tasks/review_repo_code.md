---
id: "review_repo_code"
workstream: "tui-impl"
status: CLOSED
impact: 75
effort_days: 0.5
roi: 150.00
owner: "worker-2"
created_at: "2026-05-12T11:08:44.145Z"
updated_at: "2026-05-12T11:14:59.756Z"
blocked_by: []
blocks: []
---

# REVIEW: run code-reviewer skill across the ENTIRE src/ tree (not just src/cli/tui/) — file every finding as a task

## Notes (2)

### #1 by "worker-2", 2026-05-12T11:14:54.705Z

```
FILES: src/** (non-TUI focus): src/agents/, src/tasks/, src/cli non-TUI verbs, db/tmux/detect/reconcile/state/workspace/snapshots/archives/exporting/importing/logs/vcs/output/index; package.json. Skipped deep TUI subtree already covered by review_tui_code_and_tests.
COMMANDS: read meta-tools/mu/code-reviewer skills; read AGENTS docs; `find src -maxdepth 3 -type f | sort`; `wc -l ...`; targeted `rg` scans for dead code, stale hud refs, unused deps, anti-feature imports, process.exit, JSON envelope drift; git status --short (clean).
FINDINGS: Filed 9 tasks:
- review_repo_unused_zod_dependency — package dependency zod is unused anywhere in src/test.
- review_repo_agent_list_all_dead_surface — agent list all-workstreams surface is half-removed; nextSteps point at non-working `-w *`.
- review_repo_hud_residue_dead_helpers — removed --hud still lives in comments/help aliases and `currentPaneSize()` appears production-dead.
- review_repo_workspace_commits_json_loses_metadata — `mu workspace commits --json` drops SDK metadata (`vcs`, `baseRef`, `workspacePath`).
- review_repo_process_exit_inside_handlers — leaf handlers call `process.exit` inside `handle()`, bypassing cleanup/testability.
- review_repo_archive_events_not_incremental — archive re-add skips new events/notes when no new task is inserted.
- review_repo_export_bucket_index_not_additive — additive bucket export rewrites top-level INDEX from only current input source.
- review_repo_git_dirty_check_dup — git dirty semantics duplicated via `listGitDirtyFiles` and `isGitDirty`.
- review_repo_core_files_past_refactor_signal — multiple core files exceed AGENTS 800 LOC refactor signal.
DECISION: Audit/backlog only; no code changes made.
NEXT: Implementation tasks above can be triaged after final greens; avoid touching test/ findings owned by worker-3.
VERIFIED: `git status --short` clean after filing tasks/notes.
```

### #2 by "worker-2", 2026-05-12T11:14:59.756Z

```
CLOSE: audit complete: filed 9 tasks: review_repo_unused_zod_dependency, review_repo_agent_list_all_dead_surface, review_repo_hud_residue_dead_helpers, review_repo_workspace_commits_json_loses_metadata, review_repo_process_exit_inside_handlers, review_repo_archive_events_not_incremental, review_repo_export_bucket_index_not_additive, review_repo_git_dirty_check_dup, review_repo_core_files_past_refactor_signal
```
