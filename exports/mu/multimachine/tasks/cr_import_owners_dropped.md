---
id: "cr_import_owners_dropped"
workstream: "multimachine"
status: REJECTED
impact: 70
effort_days: 0.3
roi: 233.33
owner: null
created_at: "2026-05-14T09:55:46.029Z"
updated_at: "2026-05-14T10:00:37.622Z"
blocked_by: []
blocks: []
---

# Code review: db import drops task owners despite lossless handoff goal

## Notes (2)

### #1 by "worker-1", 2026-05-14T09:55:46.296Z

```
FILE: src/db-sync.ts:402
WHAT'S WRONG: replaceWorkstreamFromSource imports source workstreams with includeMachineLocalRows=false, so copyTasks always writes owner_id=NULL (see src/db-sync.ts:542-545). The design context explicitly calls out multi-machine handoff should not lose task owners, but a normal mu db import clears every claim/owner in the imported workstream.
WHY IT MATTERS: After moving a workstream between machines, IN_PROGRESS tasks lose their owner. State/TUI/wait/stall/reaper flows no longer know which worker owned the task, and the feature is not lossless for one of the named preserved fields.
SUGGESTED FIX: Preserve owner identity in a machine-safe way during db import. Either import source agent rows for the workstream (while validating/marking pane-local fields such as pane_id/workspace as unreachable/stale as appropriate), or add an explicit owner-name preservation path/schema if live agent rows must remain machine-local. Add a regression that claims a task on source, exports/imports, and asserts the imported task still exposes the expected owner.
SEVERITY: high
```

### #2 by "π - mu", 2026-05-14T10:00:28.315Z

```
ORCHESTRATOR REJECTION
=====================
Closing as REJECTED.

owner_id is an FK into the agents table; agents are machine-local by spec (the umbrella note explicitly says 'DO NOT carry over agents rows or workspace_path data: machine-local'). Carrying owner_id across machines would be incoherent — the source machine's agents.id=5 has no meaning on the destination.

The hard rule the user committed to is 'no concurrent edits to the same workstream on two machines.' That implies no live claims at ship time — closed/finished work or unowned ready work. So 'owners dropped on import' is consistent with the design contract, not a bug.

If real friction surfaces ('I shipped mid-claim and forgot which agent owned this'), promote a future variant like 'on import, surface former owner as a system note on the imported task' (~10 LOC, no schema change). Tracking that as a possible future enhancement, not a v0.5 blocker.

Mitigation in this session: docs_pass will explicitly call out 'mu db import drops task owners; finish or release in-flight claims before exporting' in USAGE_GUIDE + the verb help text.
```
