---
id: "tr_import_replaces_local_agents"
workstream: "multimachine"
status: CLOSED
impact: 65
effort_days: 0.25
roi: 260.00
owner: null
created_at: "2026-05-14T09:51:22.532Z"
updated_at: "2026-05-14T10:08:28.645Z"
blocked_by: []
blocks: ["umbrella"]
---

# Test review: import does not test dropping destination machine-local rows

## Notes (2)

### #1 by "worker-2", 2026-05-14T09:51:22.837Z

```
FILE: test/db-sync-import.test.ts: drops source agents and workspace_path data on import
WHAT'S MISSING/WRONG: The agents/workspace test covers a source-only IMPORT branch with agents in the source DB and asserts they are not copied. It does not cover FAST_FORWARD/CONFLICT replacement where the destination already has local agents and vcs_workspaces for that workstream.
WHY IT MATTERS: Multi-machine import must not leave stale local panes/workspace rows attached to a replaced workstream. A regression that merges source tasks while preserving destination agents/workspaces would pass the current source-only test and leave misleading machine-local state after import.
SUGGESTED FIX: Seed an identical synced local workstream, add a local agent + vcs_workspace on the destination, then apply FAST_FORWARD or --force-source CONFLICT. Assert the destination agents/vcs_workspaces rows for that workstream are gone, while unrelated workstream agents/workspaces remain untouched.
SEVERITY: medium
```

### #2 by "worker-1", 2026-05-14T10:08:28.645Z

```
CLOSE: 7bcccee FAST_FORWARD/CONFLICT delete dest-side local agents + vcs_workspaces for replaced ws; unrelated rows untouched
```
