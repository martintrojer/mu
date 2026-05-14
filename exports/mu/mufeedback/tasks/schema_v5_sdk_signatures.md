---
id: "schema_v5_sdk_signatures"
workstream: "mufeedback"
status: CLOSED
impact: 70
effort_days: 1
roi: 70.00
owner: null
created_at: "2026-05-09T10:40:53.461Z"
updated_at: "2026-05-09T13:02:26.852Z"
blocked_by: ["schema_v5_migration_script"]
blocks: ["docs_staleness_review_capstone", "schema_v5_cleanups", "schema_v5_cli_boundary"]
---

# schema v5: SDK functions take operator names + workstream context, internal helpers take surrogate ids

## Notes (1)

### #1 by "worker-mf-3", 2026-05-09T10:40:53.564Z

```
Per docs/SCHEMA_v5_DESIGN.md "Boundary discipline for the SDK surface".

The load-bearing pattern (also adds to docs/ARCHITECTURE.md):
  - PUBLIC SDK functions take operator-facing names.
  - INTERNAL helpers take surrogate ids.
  - Resolution happens at the public-function entry, exactly once.

Deliverable:
  - Walk every public function in src/agents.ts, src/tasks.ts (+ src/tasks/*),
    src/workstream.ts, src/workspace.ts, src/approvals.ts, src/logs.ts,
    src/snapshots.ts. For each:
      - Ensure signature takes (workstream: string, <name>: string, ...).
      - Resolve at function entry: workstream -> wsId, <name> -> id.
      - Extract or rename the post-resolution body into a *ById internal
        helper. (Often the post-resolution body IS already the function
        minus the lookup step; this is mostly mechanical.)
  - Add typed errors at resolve-time: WorkstreamNotFoundError,
    TaskNotFoundError, AgentNotFoundError carry the operator input string.
  - Update test fixtures: insertAgent / addTask helpers stay name-shaped
    on the public surface; tests do not change.

Approx ~30 functions, mostly 1-line resolve-then-call changes.

Scope: ~1 day. Blocked by schema_v5_migration_script (needs the v5
schema in place to compile).
Gate: typecheck + lint + test + build green; no behavioural change to
CLI or JSON outputs.
```
