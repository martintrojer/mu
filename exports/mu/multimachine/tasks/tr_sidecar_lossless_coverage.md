---
id: "tr_sidecar_lossless_coverage"
workstream: "multimachine"
status: CLOSED
impact: 70
effort_days: 0.3
roi: 233.33
owner: null
created_at: "2026-05-14T09:51:20.814Z"
updated_at: "2026-05-14T10:08:28.278Z"
blocked_by: []
blocks: ["umbrella"]
---

# Test review: conflict sidecar test only checks task titles

## Notes (2)

### #1 by "worker-2", 2026-05-14T09:51:21.105Z

```
FILE: test/db-sync-import.test.ts: classifies CONFLICT, refuses by default, and --force-source parks then replaces
WHAT'S MISSING/WRONG: The --force-source sidecar assertion only checks that the park file exists, opens with openDb, and contains task titles [A, Local loser]. It does not assert that the parked DB preserves the local divergent workstream's notes, edges, agent_logs, workstream_sync, local agents, or vcs_workspaces.
WHY IT MATTERS: The sharp conflict path promises to clobber source while parking the loser so nothing is lost. A sidecar that is valid SQLite but omits notes/logs/edges or machine-local rows would pass the current test yet undermine manual recovery via mu db replay or inspection.
SUGGESTED FIX: Enrich the conflict fixture with a local-only note, edge, agent_log entry, sync row, agent, and workspace before --force-source; after import, open parkPath and assert those rows are present in the sidecar while the live destination contains only the source winner and no stale local machine-local rows.
SEVERITY: high
```

### #2 by "worker-1", 2026-05-14T10:08:28.278Z

```
CLOSE: 7bcccee sidecar contents asserted: notes/edges/logs/sync/agents/workspaces all preserved
```
