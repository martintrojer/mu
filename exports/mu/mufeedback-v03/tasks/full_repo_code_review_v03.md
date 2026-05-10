---
id: "full_repo_code_review_v03"
workstream: "mufeedback-v03"
status: CLOSED
impact: 70
effort_days: 0.6
roi: 116.67
owner: null
created_at: "2026-05-10T11:22:56.966Z"
updated_at: "2026-05-10T11:40:34.632Z"
blocked_by: []
blocks: []
---

# REVIEW: full-repo code review (post-v0.3 wave); file each finding as a separate task

## Notes (1)

### #1 by reviewer-1, 2026-05-10T11:40:34.513Z

```
SUMMARY: filed 9 tasks (review_unblock_flag_typo_in_error_nextstep — TaskHasOpenDependentsError nextStep uses non-existent --not-blocked-by flag; review_agent_exists_message_stale — AgentExistsError message + SQL hint contradicts v5 per-workstream uniqueness; review_assert_agent_in_workstream_stale_doc — assertAgentInWorkstream docstring still claims globally-unique agent names; review_cli_ts_past_refactor_signal — src/cli.ts at 1318 LOC + 5 other files past 800 LOC threshold; review_resolved_nothing_dead_branch — dead `resolvedNothing` field in cmdState with `void` discard; review_undo_stale_drun_comment — cmdUndo doc cites `dryRun:true` after rename to `mode:"report-only"`; review_count_helpers_duplicated_three_files — count* helpers duplicated between workstream.ts and cli/doctor.ts; review_export_archive_double_resolves_label — cmdArchiveExport pre-resolves twice + non-idiomatic `as` cast; review_release_open_in_progress_inconsistency — releaseTask leaves owner=NULL/IN_PROGRESS by default which `mu task wait` cannot satisfy; review_omnibus_minor_polish — 6 small nits including bucket-INDEX shrink-on-re-export, sql-handle triple-throw, log-tail-interval clamp, etc).
```
