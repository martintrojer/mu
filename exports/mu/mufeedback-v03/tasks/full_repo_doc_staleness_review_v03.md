---
id: "full_repo_doc_staleness_review_v03"
workstream: "mufeedback-v03"
status: CLOSED
impact: 65
effort_days: 0.5
roi: 130.00
owner: null
created_at: "2026-05-10T13:10:21.649Z"
updated_at: "2026-05-10T13:24:27.352Z"
blocked_by: []
blocks: []
---

# REVIEW: full-repo doc staleness scan (post-v0.3 wave); file each finding as a separate task

## Notes (1)

### #1 by "reviewer-3", 2026-05-10T13:24:19.033Z

```
SUMMARY: filed 11 tasks: doc_stale_agentsmd_tree, doc_stale_arch_modules_table, doc_stale_usage_guide_v02, doc_stale_skill_schema_sql, doc_stale_verb_audit_v01, doc_stale_output_labels_audit_approve, doc_stale_vocab_release_update, doc_stale_vision_namespaces_tables, doc_stale_skill_release_reopen, doc_stale_changelog_unreleased_dup_03, doc_stale_omnibus_minor.

Highest-value findings: (1) doc_stale_skill_schema_sql — every `mu sql` recipe in SKILL/USAGE_GUIDE/ROADMAP/VERB_AUDIT references v4 columns (tasks.owner, from_task/to_task, task_notes.task_id=local_id) that v5 renamed to surrogate-id form. In-pane LLMs copy-pasting will hit "no such column" errors. (2) doc_stale_usage_guide_v02 — USAGE_GUIDE leads with v0.2 framing across the whole doc, references `mu approve list` (removed), and undercount tables (says 6, schema has 14). (3) doc_stale_arch_modules_table — ARCHITECTURE.md still says schema v6, references removed src/cli/hud.ts, and lists nonexistent agents/+prompts/+pi-extension.js artifacts.

Cross-cutting themes:
  - schema version drift: v5/v6 cited; current is v7 (src/db.ts:347). Approvals dropped, archive_* added.
  - removed verbs still cited: `mu hud`, `mu approve *`, `mu whoami`, `mu my-tasks`, `mu my-next` appear as live verbs in VERB_AUDIT, OUTPUT_LABELS_AUDIT, USAGE_GUIDE.
  - removed source files still referenced: src/cli/hud.ts, src/approvals.ts, src/migrations.ts, scripts/.
  - --reopen semantics drift in SKILL.md (auto-flip moved into bare release per CHANGELOG; --reopen is now un-close only).
  - CHANGELOG has TWO unreleased buckets ([Unreleased] + [0.3.0] — unreleased) for the same v0.3 wave.

What was IN-DATE (verified clean): VOCABULARY.md archive entries, README.md core text, AGENTS.md working-conventions section, SKILL.md `mu state` render-mode line.
```
