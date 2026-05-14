---
id: "review_repo_archive_events_not_incremental"
workstream: "tui-impl"
status: CLOSED
impact: 45
effort_days: 0.25
roi: 180.00
owner: "worker-3"
created_at: "2026-05-12T11:14:37.749Z"
updated_at: "2026-05-12T12:58:05.796Z"
blocked_by: []
blocks: ["feat_mu_bare_launches_tui", "review_repo_core_files_past_refactor_signal"]
---

# REVIEW med: archive re-add skips new events/notes unless a new task exists

## Notes (3)

### #1 by "worker-2", 2026-05-12T11:14:38.071Z

```
FILES: src/archives.ts:544-604 (especially 580-604).
FINDING: `addToArchive()` copies notes and kind=event rows only when `newArchivedIds.length > 0`. Re-running an archive add after only new events (or new notes on already-archived tasks) silently skips those rows, even though `last_added_at` is bumped and the event says `events=0`. The coarse gate exists to avoid duplicates because archived_events/archived_notes lack natural uniqueness.
RECOMMENDED FIX: Make idempotency explicit instead of gating on new tasks. For events, add/enforce a unique key such as `(archive_id, source_workstream, seq)` and copy with `INSERT OR IGNORE` every run. For notes, either store original note id in `archived_notes` for the same pattern or document that notes are task-snapshot-only and do not update on re-add; then adjust counters/event text so the behaviour is honest.
```

### #2 by "π - mu", 2026-05-12T12:42:10.285Z

```
DECISION (orchestrator triage): DOCUMENT — do NOT change the schema or addToArchive logic.

The use case for archives is end-of-milestone snapshot-and-destroy, not weekly incremental refresh. Re-running 'mu archive add' after only new events is a rare workflow not worth the schema migration cost (would also be the FIRST non-additive schema change → triggers schema_version migration substrate per AGENTS.md).

Implementation:
1. src/archives.ts addToArchive event payload: change 'events=N' wording when newArchivedIds.length === 0 to 'events=0 (snapshot only — re-add is task-incremental, not event-incremental)'. Or omit the events count entirely in that branch.
2. docs/USAGE_GUIDE.md mu archive section: add a paragraph clarifying that 'mu archive add <label> -w <ws>' is task-snapshot-only; events + notes for already-archived tasks are NOT updated on re-add. Recommend full re-create (delete + create) for full event-stream refresh.
3. CHANGELOG.md (under v0.4.0 polish): bullet under 'Documentation'.

NO schema change. NO logic change. ~30 LOC of doc + comment + event-payload-text edits.

⚠️ FINAL ACTION ⚠️
mu task close review_repo_archive_events_not_incremental -w tui-impl --evidence '<sha>: documented archive snapshot-only contract'
```

### #3 by "worker-3", 2026-05-12T12:58:05.796Z

```
CLOSE: e0752cf: documented archive snapshot-only contract
```
