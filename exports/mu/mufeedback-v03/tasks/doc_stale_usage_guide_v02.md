---
id: "doc_stale_usage_guide_v02"
workstream: "mufeedback-v03"
status: CLOSED
impact: 60
effort_days: 0.3
roi: 200.00
owner: "worker-2"
created_at: "2026-05-10T13:20:52.885Z"
updated_at: "2026-05-10T13:50:36.088Z"
blocked_by: []
blocks: ["doc_stale_skill_schema_sql"]
---

# docs: USAGE_GUIDE.md still says v0.2 / "schema v5" / "six tables" / "What is NOT in 0.2.0"

## Notes (1)

### #1 by reviewer-3, 2026-05-10T13:21:11.201Z

```
FILES: docs/USAGE_GUIDE.md:3, :9-21, :17, :160, :731-733, :1408 ("§ Not in 0.2.0"), :1432
FINDING: USAGE_GUIDE leads with v0.2 wave framing across the entire doc:
  (1) :3 "(current main; v0.2-track)" — should be v0.3-track / v0.3 wave.
  (2) :9 "Status: v0.2 wave (pre-1.0). ~60 typed verbs across 7 namespaces" — verb count is fine, but namespace count should be re-counted (workstream/agent/task/workspace/log/snapshot/archive/me + bare top-levels — currently 8 namespaces by `mu --help`).
  (3) :17 "schema v5 (surrogate INTEGER PKs; per-workstream UNIQUE on operator-facing names)" — schema is now v7. Mention v6 (archive_* additive) and v7 (drop approvals).
  (4) :160 references "`mu task list`, `mu task next`, and `mu approve list`" — `mu approve list` no longer exists (removed in remove_approvals_dead_weight; CHANGELOG [Unreleased] Removed). Drop the `mu approve list` mention.
  (5) :731 "The schema is six tables (`workstreams`, `agents`, `tasks`, `task_edges`, `task_notes`, `agent_logs`, `vcs_workspaces`) plus three views" — thats SEVEN listed tables (the prose says six), and the schema actually has 14: workstreams, agents, tasks, task_edges, task_notes, agent_logs, vcs_workspaces, snapshots, schema_version, archives, archived_tasks, archived_edges, archived_notes, archived_events. Re-render to match.
  (6) :1408 anchor `§ Not in 0.2.0` and table heading "Whats NOT in 0.2.0" — should be 0.3.0 (or just "current"). Several rows in that table reference removed verbs (e.g. `mu task blocked`, `mu task goals`, `mu task search`) that have been removed-with-recipe per VERB_AUDIT — table is fine but the version header is stale.
WHY: USAGE_GUIDE is the headline "Start here" doc (README links it as primary). Its v0.2 framing makes the entire v0.3 wave invisible to a first-time reader.
FIX-SKETCH: bump every "v0.2" → "v0.3" or "current"; rewrite the schema-six-tables paragraph from src/db.ts:7-9 (8 core + 1 meta + 5 archive); delete the `mu approve list` mention at :160; rename anchor + heading to "Whats NOT in 0.3.0".
```
