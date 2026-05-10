---
id: "output_labels_human_rename"
workstream: "mufeedback"
status: CLOSED
impact: 20
effort_days: 0.3
roi: 66.67
owner: null
created_at: "2026-05-09T13:22:38.040Z"
updated_at: "2026-05-09T14:38:47.276Z"
blocked_by: ["output_id_vs_name_audit"]
blocks: []
---

# rename cli-table3 column headers to match v5 'name' convention (id→name on tasks; slug→name on approvals)

## Notes (1)

### #1 by worker-mf-2, 2026-05-09T13:22:54.633Z

```
PHASE 2 (non-breaking subset) of OUTPUT_LABELS_AUDIT. Scope: cli-table3 column header rename ONLY. JSON keys preserved (the JSON rename is `output_json_keys_rename_v5`, separate breaking commit).

Affected files (per audit per-verb matrix):
  - src/cli.ts formatTaskListTable / formatReadyTable: head `id` → `name`
  - src/cli/approve.ts formatApprovalsTable: head `slug` → `name`

Other table headers already match the convention (agents.name, workspaces.agent, workstreams.name) — no change.

Tests: any snapshot/string assertion on the rendered table needs updating; expect ~5-10 test files touched.

CHANGELOG: under [Unreleased] / Changed (NOT Breaking — JSON shape unchanged, scripts that grep human output were never a stable contract).
```
