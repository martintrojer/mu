---
id: "doc_stale_skill_schema_sql"
workstream: "mufeedback-v03"
status: CLOSED
impact: 65
effort_days: 0.2
roi: 325.00
owner: "worker-2"
created_at: "2026-05-10T13:21:15.352Z"
updated_at: "2026-05-10T13:55:46.220Z"
blocked_by: ["doc_stale_usage_guide_v02", "remove_or_shrink_verb_audit_md"]
blocks: []
---

# docs: SKILL.md SQL escape-hatch examples reference removed/renamed columns (tasks.owner, t.local_id, from_task)

## Notes (1)

### #1 by "reviewer-3", 2026-05-10T13:21:34.592Z

```
FILES: skills/mu/SKILL.md:441-451, docs/USAGE_GUIDE.md:885-905, docs/ROADMAP.md:162-170, docs/VERB_AUDIT.md:603-609, skills/mu/SKILL.md:26
FINDING: All `mu sql` recipes in the docs reference v4 columns that v5 renamed/removed. Real schema (src/db.ts:498-535):
  - tasks: id (INTEGER PK), local_id (TEXT, per-ws unique), owner_id (INTEGER FK → agents.id) — NOT `owner` TEXT.
  - task_edges: from_task_id, to_task_id (INTEGER FKs) — NOT `from_task`/`to_task`.
  - task_notes.task_id is INTEGER FK to tasks.id — NOT TEXT joining on local_id.
Stale snippets:
  (1) skills/mu/SKILL.md:441-444 `JOIN tasks t ON t.owner = a.name` — broken: `tasks.owner` does not exist; `agents.name` is per-ws unique not global. Correct shape: `JOIN agents a ON t.owner_id = a.id`.
  (2) skills/mu/SKILL.md:447-451 + USAGE_GUIDE.md:899-905 + VERB_AUDIT.md (recursive prereq CTE) use `from_task FROM task_edges WHERE to_task = ...` — columns are `from_task_id` / `to_task_id` and join on tasks.id (local_id is per-ws-scoped TEXT, ambiguous on its own).
  (3) USAGE_GUIDE.md:885-895 the "what blocks what" join uses `e.to_task = b.local_id` and `t.local_id = e.from_task` — same column-rename + scope mismatch.
  (4) USAGE_GUIDE.md:887 `UPDATE tasks SET status=IN_PROGRESS WHERE local_id=build` works only by accident (one workstream); should add `AND workstream_id=(SELECT id FROM workstreams WHERE name=X)` or warn.
  (5) ROADMAP.md:162-170 + VERB_AUDIT.md:605-609 `tasks_v` view DDL joins `n.task_id = t.local_id` — wrong (task_notes.task_id is INTEGER FK to tasks.id).
  (6) skills/mu/SKILL.md:26 "atomic CAS take/clear of `tasks.owner`" — should be `tasks.owner_id` (the v5 surrogate).
WHY: SKILL.md is what every in-pane LLM reads as authoritative. Copy-pasted recipes will throw "no such column: owner / from_task / to_task" at the first agent that tries them.
FIX-SKETCH: rewrite each example using owner_id/from_task_id/to_task_id and tasks.id joins. The "rename a workstream" example at SKILL.md:457 is fine (workstreams.name is the actual column). Add a one-line preamble: "all entity tables in v5+ use INTEGER `id` PKs; the operator-facing TEXT name is per-workstream unique."
```
