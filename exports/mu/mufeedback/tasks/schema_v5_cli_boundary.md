---
id: "schema_v5_cli_boundary"
workstream: "mufeedback"
status: CLOSED
impact: 50
effort_days: 0.5
roi: 100.00
owner: null
created_at: "2026-05-09T10:41:04.642Z"
updated_at: "2026-05-09T13:13:21.379Z"
blocked_by: ["schema_v5_sdk_signatures"]
blocks: ["docs_staleness_review_capstone", "schema_v5_cleanups"]
---

# schema v5: CLI verb handlers map operator input through resolved-name SDK boundary cleanly

## Notes (1)

### #1 by "worker-mf-3", 2026-05-09T10:41:04.740Z

```
Per docs/SCHEMA_v5_DESIGN.md "Boundary discipline" section.

After schema_v5_sdk_signatures lands, every SDK function takes operator
names. CLI verbs already pass operator names through; the work here is:
  - Wire fresh-resolved error types (WorkstreamNotFoundError,
    TaskNotFoundError, AgentNotFoundError) through classifyError in
    src/cli.ts so they map to specific exit codes (not just generic 1).
  - Audit verb handlers in src/cli/*.ts for any place that assumed the
    old global TEXT PK shape (e.g. handlers that did "if id starts with
    mu_ then..." gymnastics — they go away in schema_v5_cleanups but
    the CLI handlers may have residual checks).
  - Confirm --json output shape still uses operator names (localId,
    workstream name, agent name, slug). NO surfacing of surrogate ids
    unless an explicit consumer asks (deferred per design doc Out-of-scope).

Approx ~30 verbs. Most no-ops; the win is consistent error mapping at
the boundary.

Scope: ~0.5 days. Blocked by schema_v5_sdk_signatures.
Gate: typecheck + lint + test + build green; --json shapes unchanged
(snapshot tests would catch a regression).
```
