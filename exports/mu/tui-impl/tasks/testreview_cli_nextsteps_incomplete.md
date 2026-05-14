---
id: "testreview_cli_nextsteps_incomplete"
workstream: "tui-impl"
status: CLOSED
impact: 55
effort_days: 0.25
roi: 220.00
owner: "worker-3"
created_at: "2026-05-13T12:38:47.275Z"
updated_at: "2026-05-13T13:13:43.364Z"
blocked_by: []
blocks: []
---

# REVIEW med: nextSteps test omits many typed errors

## Notes (2)

### #1 by "worker-3", 2026-05-13T12:38:47.625Z

```
FILE(S):
  test/error-nextsteps.test.ts:40-107
  src/cli/handle.ts:222-329

FINDING (missing coverage):
  const cases: Array<[Error, string, string[]]> = [
    [new TaskNotFoundError("foo"), "TaskNotFoundError", ["foo"]],
    [new TaskExistsError("foo"), "TaskExistsError", ["foo"]],
    ...
    [new WorkspaceNotFoundError("alice"), "WorkspaceNotFoundError", ["alice"]],
    [new WorkstreamNameInvalidError("mu-foo"), "WorkstreamNameInvalidError", ["foo"]],
    [new WorkstreamNotFoundError("ghost"), "WorkstreamNotFoundError", ["ghost"]],
  ];

WHY IT'S A PROBLEM:
  The test title says every typed error class carries actionable `errorNextSteps()`, but the fixture list omits many shipped typed errors: archive/import errors, snapshot file/version/prune errors, workspace dirty/VCS/conflict errors, `TaskClaimStaleWorkspaceError`, wait reaper/stall errors, `AgentSpawnCliNotFoundError`, and `NoForegroundProcessError`. A new or existing typed error can return generic or missing next steps while this suite stays green. This is false confidence around a user-facing recovery contract.

PROPOSED FIX:
  Expand the cases to cover every exported typed error with `HasNextSteps`, or derive the list from explicit per-module inventories so omissions are reviewed intentionally. Include contextual token checks for each omitted class (archive label, snapshot id/path, workspace path, stale agent/workstream, wait task/workstream). Add a small assertion that the inventory count matches the current exported error classes to catch drift.

EFFORT NOTE:
  Test-only change. Some constructors need realistic fixture args (e.g. `WorkspaceDirtyError` file list, `TaskClaimStaleWorkspaceError` staleness object), but no DB/tmux subprocesses are needed.
```

### #2 by "worker-3", 2026-05-13T13:13:43.364Z

```
CLOSE: a4980db: every typed error with HasNextSteps covered + drift inventory check
```
